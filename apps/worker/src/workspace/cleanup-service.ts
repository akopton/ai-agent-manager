import { truncateText } from '@ai-agent-manager/core';
import {
  claimWorkspaceCleanup,
  completeWorkspaceCleanup,
  expireRequestedWorkspaceCleanups,
  failWorkspaceCleanup,
  findProjectById,
  findTaskById,
  findWorkspace,
  listInFlightWorkspaceCleanups,
  listQueuedWorkspaceCleanups,
  type DatabaseConnection,
  type WorkspaceCleanupRecord,
} from '@ai-agent-manager/database';
import {
  inspectTaskWorktree,
  inspectWorktreeForCleanup,
  relockTaskWorktree,
  removeTaskWorktree,
  TaskWorktreeError,
  validateRepository,
} from '@ai-agent-manager/git';
import type { Logger } from '../logger.js';

// Remove local worktree (TM-02) in the worker, the process that owns Git mutations. The worker
// never decides on its own to remove anything: it only executes removals the operator requested
// and confirmed (`requested`), one at a time. The claim re-assesses the task's records in the same
// transaction; then the worker re-verifies the repository identity, the managed location under its
// own worktree root, the lock marker, the branch, HEAD at the expected commit, and that there are
// no uncommitted, untracked or ignored files. Only then does it run a non-forced `git worktree
// remove` (through `removeTaskWorktree`, which checks everything again and re-locks on failure).
// The task branch, the remote, the main checkout and every record are kept. After a restart, a
// removal left in flight is settled from Git state and never repeated automatically.

type Database = DatabaseConnection['db'];

export type WorkspaceCleanupGit = {
  remove: typeof removeTaskWorktree;
  inspect: typeof inspectTaskWorktree;
  relock: typeof relockTaskWorktree;
};

export type WorkspaceCleanupServiceOptions = {
  db: Database;
  logger: Logger;
  worktreeRoot: string;
  workerInstanceId: string;
  /** Requests older than this are failed instead of executed. */
  requestMaxAgeMs: number;
  now?: () => number;
  /** @internal Tests only: replaces the Git mutation (for example to simulate a crash). */
  git?: Partial<WorkspaceCleanupGit>;
};

export type WorkspaceCleanupService = {
  /** Settles removals left in flight by a previous worker. Call once, before `poll`. */
  reconcile: () => Promise<void>;
  /** Starts the oldest requested removal unless one is already running. Never blocks. */
  poll: () => void;
  /** Resolves when no removal is running. */
  idle: () => Promise<void>;
};

const describe = (error: unknown): string =>
  truncateText(error instanceof Error ? error.message : String(error), 500);

export const createWorkspaceCleanupService = (
  options: WorkspaceCleanupServiceOptions,
): WorkspaceCleanupService => {
  const { db, logger, worktreeRoot } = options;
  const now = options.now ?? Date.now;
  const git: WorkspaceCleanupGit = {
    remove: options.git?.remove ?? removeTaskWorktree,
    inspect: options.git?.inspect ?? inspectTaskWorktree,
    relock: options.git?.relock ?? relockTaskWorktree,
  };
  let running: Promise<void> | null = null;

  const fail = (cleanup: WorkspaceCleanupRecord, code: string, message: string): void => {
    failWorkspaceCleanup(db, { id: cleanup.id, from: 'removing', code, message, now: now() });
    logger.info(`Worktree cleanup ${cleanup.id} failed: ${code}.`);
  };

  /**
   * Decides from Git state what an interrupted or unexpectedly failed removal did. The worktree is
   * gone with the branch kept → removed; still a verified worktree → nothing was removed; an
   * unlocked but otherwise intact worktree is locked again (the state before the removal began).
   */
  const settleFromGit = async (cleanup: WorkspaceCleanupRecord, reason: string): Promise<void> => {
    const workspace = findWorkspace(db, cleanup.workspaceId);
    const task = findTaskById(db, cleanup.taskId);
    const project = task === undefined ? undefined : findProjectById(db, task.projectId);
    if (workspace === undefined || project === undefined) {
      fail(cleanup, 'interrupted', `${reason} The task or worktree record is missing.`);
      return;
    }
    const inspection = await git.inspect({
      repositoryPath: project.localPath,
      worktreePath: workspace.path,
      branchName: workspace.branch,
    });
    if (inspection.state === 'branch_only' && !inspection.pathExists && !inspection.registered) {
      completeWorkspaceCleanup(db, {
        id: cleanup.id,
        branchCommit: inspection.branchCommit,
        note: {
          code: 'interrupted_after_removal',
          message: `${reason} Git shows the worktree was removed; the task branch is kept.`,
        },
        now: now(),
      });
      logger.info(`Worktree cleanup ${cleanup.id} settled as removed.`);
      return;
    }
    if (inspection.state === 'ready') {
      fail(
        cleanup,
        'interrupted',
        `${reason} The worktree is still in place; nothing was removed.`,
      );
      return;
    }
    if (
      inspection.state === 'inconsistent' &&
      inspection.issues.length === 1 &&
      inspection.issues[0] === 'lock_missing'
    ) {
      // The removal stopped between `worktree unlock` and `worktree remove`. Restore the lock so the
      // worktree is protected (and verifiable) again; nothing else is touched.
      const relocked = await git
        .relock({
          repositoryPath: project.localPath,
          worktreePath: workspace.path,
          branchName: workspace.branch,
        })
        .catch(() => false);
      fail(
        cleanup,
        'interrupted',
        relocked
          ? `${reason} The worktree is still in place and was locked again; nothing was removed.`
          : `${reason} The worktree is still in place but unlocked, and could not be locked again. Inspect it manually; nothing was removed.`,
      );
      return;
    }
    fail(
      cleanup,
      'interrupted',
      `${reason} Git reports the worktree as ${inspection.state}${
        inspection.issues.length > 0 ? ` (${inspection.issues.join(', ')})` : ''
      }; it was left as it is. Inspect it manually.`,
    );
  };

  const remove = async (
    cleanup: WorkspaceCleanupRecord,
    context: Extract<ReturnType<typeof claimWorkspaceCleanup>, { claimed: true }>,
  ): Promise<void> => {
    const { workspace, task } = context;
    const project = findProjectById(db, task.projectId);
    if (project === undefined) {
      fail(cleanup, 'project_missing', 'The project record is missing. Nothing was removed.');
      return;
    }
    const repository = await validateRepository(project.localPath);
    if (
      !repository.valid ||
      repository.repository.root !== project.localPath ||
      repository.repository.commonDir !== project.gitCommonDir
    ) {
      fail(
        cleanup,
        'repository_changed',
        'The repository at the registered path is missing or is a different repository. Nothing was removed.',
      );
      return;
    }
    // The worker's own configured root, not the recorded one: a workspace outside it is refused.
    const inspection = await inspectWorktreeForCleanup({
      repository: project,
      taskId: task.id,
      workspace,
      worktreeRoot,
      expectedCommit: cleanup.expectedCommit,
    });
    if (inspection.blockers.length > 0) {
      fail(
        cleanup,
        'worktree_not_removable',
        `The worktree cannot be removed safely: ${inspection.blockers.join('; ')}. Nothing was removed.`,
      );
      return;
    }
    try {
      const removed = await git.remove({
        repositoryPath: project.localPath,
        worktreePath: workspace.path,
        branchName: workspace.branch,
        expectedCommit: cleanup.expectedCommit,
      });
      completeWorkspaceCleanup(db, {
        id: cleanup.id,
        branchCommit: removed.branchCommit,
        ...(removed.branchCommit === cleanup.expectedCommit
          ? {}
          : {
              note: {
                code: 'branch_moved',
                message:
                  'The worktree was removed, but the task branch no longer points at the expected commit. It was kept as it is.',
              },
            }),
        now: now(),
      });
      logger.info(
        `Worktree cleanup ${cleanup.id}: removed the worktree of task ${task.id}; branch ${workspace.branch} kept at ${removed.branchCommit}.`,
      );
    } catch (error) {
      if (error instanceof TaskWorktreeError) {
        if (error.code === 'RECOVERY_REQUIRED') {
          completeWorkspaceCleanup(db, {
            id: cleanup.id,
            branchCommit: null,
            note: { code: 'branch_missing', message: error.message },
            now: now(),
          });
          return;
        }
        fail(
          cleanup,
          error.code === 'WORKTREE_DIRTY' ? 'worktree_dirty' : 'worktree_not_removable',
          `${error.message} Nothing was removed.`,
        );
        return;
      }
      throw error;
    }
  };

  const run = async (id: string): Promise<void> => {
    const claim = claimWorkspaceCleanup(db, {
      id,
      workerInstanceId: options.workerInstanceId,
      now: now(),
    });
    if (!claim.claimed) {
      if (claim.cleanup?.status === 'failed') {
        logger.info(`Worktree cleanup ${id} refused: ${claim.cleanup.errorCode ?? 'unknown'}.`);
      }
      return;
    }
    logger.info(`Worktree cleanup ${id} claimed for task ${claim.task.id}.`);
    try {
      await remove(claim.cleanup, claim);
    } catch (error) {
      logger.error(`Worktree cleanup ${id} failed unexpectedly.`, error);
      try {
        await settleFromGit(
          claim.cleanup,
          `An unexpected error stopped the removal (${describe(error)}).`,
        );
      } catch (settleError) {
        logger.error(
          `Worktree cleanup ${id} could not be settled; it stays in progress until the next restart.`,
          settleError,
        );
      }
    }
  };

  const poll = (): void => {
    if (running !== null) return;
    expireRequestedWorkspaceCleanups(db, {
      olderThan: now() - options.requestMaxAgeMs,
      now: now(),
    });
    const [next] = listQueuedWorkspaceCleanups(db);
    if (next === undefined) return;
    running = run(next.id).finally(() => {
      running = null;
    });
  };

  const reconcile = async (): Promise<void> => {
    for (const cleanup of listInFlightWorkspaceCleanups(db)) {
      try {
        await settleFromGit(cleanup, 'The worker stopped while this removal was in progress.');
      } catch (error) {
        logger.error(`Worktree cleanup ${cleanup.id} could not be reconciled.`, error);
      }
    }
  };

  return {
    reconcile,
    poll,
    idle: async () => {
      await running;
    },
  };
};
