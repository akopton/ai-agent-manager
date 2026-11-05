import { randomUUID } from 'node:crypto';
import { isRunReviewEligible, truncateText } from '@ai-agent-manager/core';
import {
  claimPublication,
  completePublicationCommit,
  completePublicationPush,
  failPublication,
  findProjectById,
  findPublication,
  findTaskById,
  findWorkspace,
  listInFlightPublications,
  listQueuedPublications,
  listTaskRuns,
  recordPublicationCommitObject,
  startPublicationPush,
  type DatabaseConnection,
  type PublicationRecord,
} from '@ai-agent-manager/database';
import {
  commitReviewSnapshot,
  defaultTaskBranchName,
  hashReviewSnapshot,
  PublishError,
  pushTaskBranch,
  readTaskBranchCommit,
  reviewSnapshotSchema,
  validateRepository,
  type PublishErrorCode,
  type ReviewSnapshot,
} from '@ai-agent-manager/git';
import { verifyRetainedWorkspace } from '../execution/retained-workspace.js';
import type { Logger } from '../logger.js';

// Approve & Push in the worker (M6-03). The worker is the only process that mutates Git for a
// publication. It never starts an agent and never picks work on its own: it only executes approvals
// the operator recorded (`approved`) and push retries the operator requested (`push_requested`),
// one at a time. Before any mutation it re-reads every record and re-verifies the task, the latest
// run, the retained worktree, the repository identity, the destination and the snapshot; anything
// that changed since the review fails the publication instead of being repaired or overwritten.
// After a restart, publications left in flight are reconciled from Git state and never resumed
// automatically: a pending push waits for an explicit Retry push.

type Database = DatabaseConnection['db'];

export type PublicationGit = {
  commit: typeof commitReviewSnapshot;
  push: typeof pushTaskBranch;
  branchCommit: typeof readTaskBranchCommit;
};

export type PublicationServiceOptions = {
  db: Database;
  logger: Logger;
  worktreeRoot: string;
  workerInstanceId: string;
  now?: () => number;
  /** @internal Tests only: replaces the Git operations (for example to simulate a crash). */
  git?: Partial<PublicationGit>;
};

export type PublicationService = {
  /** Reconciles publications left in flight by a previous worker. Call once, before `poll`. */
  reconcile: () => Promise<void>;
  /** Starts the oldest queued publication unless one is already running. Never blocks. */
  poll: () => void;
  /** Resolves when no publication is running. */
  idle: () => Promise<void>;
  readonly busy: boolean;
};

/** A refusal before any mutation; the publication fails at `validation` with this code. */
class ValidationFailure extends Error {
  override name = 'ValidationFailure';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const validationCodes = new Set<PublishErrorCode>([
  'snapshot_blocked',
  'snapshot_changed',
  'worktree_not_verified',
]);

const describe = (error: unknown): string =>
  truncateText(error instanceof Error ? error.message : String(error), 500);

const parseSnapshot = (publication: PublicationRecord): ReviewSnapshot => {
  let json: unknown;
  try {
    json = JSON.parse(publication.snapshotJson) as unknown;
  } catch {
    json = null;
  }
  const parsed = reviewSnapshotSchema.safeParse(json);
  if (!parsed.success || hashReviewSnapshot(parsed.data) !== publication.snapshotHash) {
    throw new ValidationFailure(
      'snapshot_record_invalid',
      'The stored review snapshot is unreadable or does not match its hash. Nothing was committed.',
    );
  }
  return parsed.data;
};

export const createPublicationService = (
  options: PublicationServiceOptions,
): PublicationService => {
  const { db, logger, worktreeRoot } = options;
  const now = options.now ?? Date.now;
  const git: PublicationGit = {
    commit: options.git?.commit ?? commitReviewSnapshot,
    push: options.git?.push ?? pushTaskBranch,
    branchCommit: options.git?.branchCommit ?? readTaskBranchCommit,
  };
  let running: Promise<void> | null = null;

  /**
   * Re-reads and re-verifies everything a mutation depends on. `expectedCommit` is where the task
   * branch must point: the base commit before committing, the recorded commit before a push.
   */
  const verifyContext = async (publication: PublicationRecord, expectedCommit: string) => {
    const task = findTaskById(db, publication.taskId);
    if (task === undefined)
      throw new ValidationFailure('task_missing', 'The task no longer exists.');
    if (task.status !== 'review') {
      throw new ValidationFailure('task_not_in_review', 'The task is no longer in Review.');
    }
    const [latest] = listTaskRuns(db, task.id);
    if (latest === undefined || latest.id !== publication.runId) {
      throw new ValidationFailure(
        'review_run_changed',
        'A newer attempt exists than the approved one. Review the changes again.',
      );
    }
    if (!isRunReviewEligible(latest) || latest.workspaceId !== publication.workspaceId) {
      throw new ValidationFailure(
        'run_not_review_eligible',
        'The approved attempt is no longer eligible for the normal review path.',
      );
    }
    const workspace = findWorkspace(db, publication.workspaceId);
    const project = findProjectById(db, task.projectId);
    if (workspace === undefined || project === undefined) {
      throw new ValidationFailure(
        'workspace_missing',
        'The workspace or project record is missing.',
      );
    }
    let expectedBranch: string | null;
    try {
      expectedBranch = defaultTaskBranchName(task.id);
    } catch {
      expectedBranch = null;
    }
    if (
      workspace.branch !== publication.branch ||
      workspace.branch !== expectedBranch ||
      workspace.baseSha !== publication.baseCommit
    ) {
      throw new ValidationFailure(
        'workspace_identity_mismatch',
        'The approval does not match the task’s recorded branch or base commit.',
      );
    }
    if (project.remoteName !== publication.remoteName) {
      throw new ValidationFailure(
        'remote_changed',
        'The project’s remote changed after the approval. Review the changes again.',
      );
    }
    const repository = await validateRepository(project.localPath);
    if (
      !repository.valid ||
      repository.repository.root !== project.localPath ||
      repository.repository.commonDir !== project.gitCommonDir
    ) {
      throw new ValidationFailure(
        'repository_changed',
        'The repository at the registered path is missing or is a different repository.',
      );
    }
    const check = await verifyRetainedWorkspace({
      project,
      task,
      continuation: { workspace },
      worktreeRoot,
      expectedCommit,
    });
    if (!check.ok) {
      throw new ValidationFailure(
        'worktree_not_verified',
        `The task worktree cannot be published: ${check.reason}.`,
      );
    }
    return { task, project, workspace };
  };

  const fail = (
    publication: PublicationRecord,
    stage: 'validation' | 'commit' | 'push',
    code: string,
    message: string,
  ): void => {
    failPublication(db, {
      id: publication.id,
      stage,
      errorCode: code,
      errorMessage: message,
      now: now(),
    });
    logger.info(`Publication ${publication.id} failed at ${stage}: ${code}.`);
  };

  /**
   * After an unexpected error (or a restart) the Git state decides what happened: if the task
   * branch points at the recorded commit, the commit exists and only the push is pending.
   */
  const settleFromGit = async (publication: PublicationRecord, reason: string): Promise<void> => {
    const current = findPublication(db, publication.id) ?? publication;
    if (current.status === 'committed' || current.status === 'pushing') {
      fail(
        current,
        'push',
        'interrupted',
        `${reason} The commit exists; the push did not complete or was not confirmed. Retry the push (an identical remote branch is reported up to date).`,
      );
      return;
    }
    if (current.status !== 'committing') return;
    let branch: string | null = null;
    const workspace = findWorkspace(db, current.workspaceId);
    const task = findTaskById(db, current.taskId);
    const project = task === undefined ? undefined : findProjectById(db, task.projectId);
    if (workspace !== undefined && project !== undefined) {
      try {
        branch = await git.branchCommit({
          repositoryPath: project.localPath,
          worktreePath: workspace.path,
          branchName: workspace.branch,
        });
      } catch {
        branch = null;
      }
    }
    if (current.commitSha !== null && branch === current.commitSha) {
      completePublicationCommit(db, { id: current.id, now: now() });
      const committed = findPublication(db, current.id) ?? current;
      fail(
        committed,
        'push',
        'interrupted',
        `${reason} The commit was created on the task branch but not pushed. Retry the push.`,
      );
      return;
    }
    if (branch === current.baseCommit) {
      fail(
        current,
        'commit',
        'interrupted',
        `${reason} Nothing was committed. Review the changes and approve again.`,
      );
      return;
    }
    fail(
      current,
      'commit',
      'unexpected_branch_state',
      `${reason} The task branch is not at the base commit or the recorded commit; it was left as it is.`,
    );
  };

  /** Pushes the recorded commit, after re-verifying everything with the branch at that commit. */
  const push = async (publication: PublicationRecord): Promise<void> => {
    if (publication.commitSha === null) {
      fail(publication, 'push', 'commit_missing', 'No commit is recorded for this publication.');
      return;
    }
    try {
      const { project, workspace } = await verifyContext(publication, publication.commitSha);
      const pushed = await git.push({
        repositoryPath: project.localPath,
        worktreePath: workspace.path,
        branchName: workspace.branch,
        commitSha: publication.commitSha,
        remoteName: publication.remoteName,
        expectedRemoteDigest: publication.remoteUrlDigest,
      });
      completePublicationPush(db, { id: publication.id, outcome: pushed.outcome, now: now() });
      logger.info(
        `Publication ${publication.id} pushed ${publication.commitSha} to ${publication.remoteName} ${pushed.remoteRef} (${pushed.outcome}); task ${publication.taskId} is Done.`,
      );
    } catch (error) {
      if (error instanceof ValidationFailure || error instanceof PublishError) {
        fail(publication, 'push', error.code, error.message);
        return;
      }
      logger.error(`Publication ${publication.id}: the push failed unexpectedly.`, error);
      fail(publication, 'push', 'push_failed', `The push failed: ${describe(error)}`);
    }
  };

  const commitAndPush = async (publication: PublicationRecord): Promise<void> => {
    let snapshot: ReviewSnapshot;
    let context: Awaited<ReturnType<typeof verifyContext>>;
    try {
      snapshot = parseSnapshot(publication);
      context = await verifyContext(publication, publication.baseCommit);
      if (
        snapshot.worktreePath !== context.workspace.path ||
        snapshot.branch !== publication.branch ||
        snapshot.baseCommit !== publication.baseCommit
      ) {
        throw new ValidationFailure(
          'snapshot_record_invalid',
          'The stored review snapshot does not describe this task’s worktree.',
        );
      }
    } catch (error) {
      if (error instanceof ValidationFailure) {
        fail(publication, 'validation', error.code, error.message);
        return;
      }
      throw error;
    }

    try {
      await git.commit({
        repositoryPath: context.project.localPath,
        worktreePath: context.workspace.path,
        branchName: context.workspace.branch,
        baseCommit: publication.baseCommit,
        snapshot,
        snapshotHash: publication.snapshotHash,
        message: publication.commitMessage,
        onCommitObject: ({ commitSha, treeSha }) => {
          recordPublicationCommitObject(db, { id: publication.id, commitSha, treeSha, now: now() });
        },
      });
    } catch (error) {
      if (error instanceof PublishError) {
        fail(
          publication,
          validationCodes.has(error.code) ? 'validation' : 'commit',
          error.code,
          error.message,
        );
        return;
      }
      throw error;
    }
    const committed = completePublicationCommit(db, { id: publication.id, now: now() });
    logger.info(`Publication ${publication.id} committed ${committed.commitSha ?? ''}.`);
    const pushing = startPublicationPush(db, {
      id: publication.id,
      operationId: randomUUID(),
      now: now(),
    });
    await push(pushing.publication);
  };

  const run = async (id: string): Promise<void> => {
    const claim = claimPublication(db, {
      id,
      operationId: randomUUID(),
      workerInstanceId: options.workerInstanceId,
      now: now(),
    });
    if (claim === null) return;
    const { publication } = claim;
    logger.info(`Publication ${publication.id} claimed (${publication.status}).`);
    try {
      if (publication.status === 'committing') await commitAndPush(publication);
      else await push(publication);
    } catch (error) {
      logger.error(`Publication ${publication.id} failed unexpectedly.`, error);
      try {
        await settleFromGit(
          publication,
          `An unexpected error stopped the publication (${describe(error)}).`,
        );
      } catch (settleError) {
        logger.error(
          `Publication ${publication.id} could not be settled; it stays in progress until the next restart.`,
          settleError,
        );
      }
    }
  };

  const poll = (): void => {
    if (running !== null) return;
    const [next] = listQueuedPublications(db);
    if (next === undefined) return;
    running = run(next.id).finally(() => {
      running = null;
    });
  };

  const reconcile = async (): Promise<void> => {
    for (const publication of listInFlightPublications(db)) {
      try {
        await settleFromGit(
          publication,
          'The worker stopped while this publication was in progress.',
        );
      } catch (error) {
        logger.error(`Publication ${publication.id} could not be reconciled.`, error);
      }
    }
  };

  return {
    reconcile,
    poll,
    idle: async () => {
      await running;
    },
    get busy() {
      return running !== null;
    },
  };
};
