import { TaskWorktreeError } from './errors.js';
import { verifyRetainedTaskWorktree, type RetainedWorktreeRecord } from './retained-worktree.js';
import { listIgnoredPaths } from './status.js';
import { inspectTaskWorktree, type TaskWorktreeInspection } from './task-worktree.js';

// TM-02 — Read-only inspection of a task's managed worktree for the workspace panel and for the
// cleanup eligibility check. It combines Git's own records (registration, lock marker, branch,
// HEAD) with the stored workspace record (task, repository, managed location) and the working tree
// state (uncommitted, untracked and ignored files). Nothing is written, refreshed, locked, unlocked
// or removed. Paths always come from the stored record, never from a request.

export type WorktreeCleanupPresence =
  /** Git confirms a linked worktree of this repository on the task branch with the lock marker. */
  | 'present'
  /** No worktree directory or registration exists (the task branch may still exist). */
  | 'missing'
  /** Something exists but does not match a managed task worktree; see `issues`. */
  | 'inconsistent'
  /** The repository or worktree could not be inspected at all. */
  | 'unavailable';

export type WorktreeCleanupInspection = {
  presence: WorktreeCleanupPresence;
  /** Low-level inspection findings (for example `lock_missing`, `branch_mismatch`). */
  issues: TaskWorktreeInspection['issues'];
  registered: boolean;
  pathExists: boolean;
  locked: boolean;
  /** The lock carries the AI Agent Manager marker for the task branch. */
  managedLock: boolean;
  /** Where the task branch points, or `null` when it does not exist. */
  branchCommit: string | null;
  headCommit: string | null;
  /** The worktree matches the stored record, the managed location and the expected commit. */
  identity: { ok: true } | { ok: false; reason: string };
  workingTree: {
    clean: boolean;
    staged: number;
    unstaged: number;
    untracked: number;
    conflicted: number;
  } | null;
  /** Git-ignored paths that `git worktree remove` would delete, or `null` when not inspected. */
  ignoredCount: number | null;
  /**
   * Git-level reasons the worktree must not be removed now, safe to show. Empty means Git state
   * allows a non-forced removal at `expectedCommit`; the task's records are assessed separately.
   */
  blockers: string[];
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Inspects the recorded task worktree. `expectedCommit` is where HEAD and the task branch must
 * point for a removal (the pushed commit of a Done task, the base commit of a discarded one).
 */
export const inspectWorktreeForCleanup = async ({
  repository,
  taskId,
  workspace,
  worktreeRoot,
  expectedCommit,
}: {
  repository: { localPath: string; gitCommonDir: string };
  taskId: string;
  workspace: RetainedWorktreeRecord;
  worktreeRoot: string;
  expectedCommit: string;
}): Promise<WorktreeCleanupInspection> => {
  let inspection: TaskWorktreeInspection;
  try {
    inspection = await inspectTaskWorktree({
      repositoryPath: repository.localPath,
      worktreePath: workspace.path,
      branchName: workspace.branch,
    });
  } catch (error) {
    const reason = `the repository or worktree could not be inspected (${
      error instanceof TaskWorktreeError ? error.code : 'unexpected error'
    })`;
    return {
      presence: 'unavailable',
      issues: [],
      registered: false,
      pathExists: false,
      locked: false,
      managedLock: false,
      branchCommit: null,
      headCommit: null,
      identity: { ok: false, reason },
      workingTree: null,
      ignoredCount: null,
      blockers: [reason],
    };
  }

  const presence: WorktreeCleanupPresence =
    inspection.state === 'ready'
      ? 'present'
      : inspection.state === 'inconsistent'
        ? 'inconsistent'
        : 'missing';
  const blockers: string[] = [];
  if (presence === 'missing') {
    blockers.push(
      'the worktree directory and its Git registration do not exist (removed or moved outside AI Agent Manager)',
    );
  }

  const check = await verifyRetainedTaskWorktree({
    repository,
    taskId,
    workspace,
    worktreeRoot,
    expectedCommit,
  });
  const identity = check.ok
    ? ({ ok: true } as const)
    : { ok: false as const, reason: check.reason };
  if (!check.ok && presence !== 'missing') blockers.push(check.reason);

  const status = inspection.workingTree;
  const workingTree =
    status === null
      ? null
      : {
          clean: status.isClean,
          staged: status.staged.length,
          unstaged: status.unstaged.length,
          untracked: status.untracked.length,
          conflicted: status.conflicted.length,
        };
  if (workingTree !== null && !workingTree.clean) {
    const changed = workingTree.staged + workingTree.unstaged + workingTree.conflicted;
    blockers.push(
      `the worktree has uncommitted or untracked files (${[
        changed > 0 ? plural(changed, 'changed path') : undefined,
        workingTree.untracked > 0 ? plural(workingTree.untracked, 'untracked path') : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(', ')})`,
    );
  }

  let ignoredCount: number | null = null;
  if (presence === 'present' && check.ok) {
    try {
      ignoredCount = (await listIgnoredPaths(inspection.path)).length;
    } catch {
      blockers.push('Git-ignored files in the worktree could not be listed');
    }
    if (ignoredCount !== null && ignoredCount > 0) {
      blockers.push(
        `the worktree contains ${plural(ignoredCount, 'Git-ignored path')} (for example build output, dependencies or .env files) that removal would delete`,
      );
    }
  }

  return {
    presence,
    issues: inspection.issues,
    registered: inspection.registered,
    pathExists: inspection.pathExists,
    locked: inspection.locked,
    managedLock: inspection.locked && !inspection.issues.includes('lock_reason_mismatch'),
    branchCommit: inspection.branchCommit,
    headCommit: inspection.head?.commit ?? null,
    identity,
    workingTree,
    ignoredCount,
    blockers,
  };
};
