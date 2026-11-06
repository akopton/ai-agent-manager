import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskWorktreeError } from './errors.js';
import {
  defaultTaskBranchName,
  inspectTaskWorktree,
  taskWorktreeLockReason,
  type TaskWorktree,
} from './task-worktree.js';

// Re-verification of a task's retained worktree from its stored record and live Git state. Used
// before a follow-up or recovered attempt (M6-02, TM-01) and before every Approve & Push mutation
// (M6-03). Read-only: nothing is repaired, reset, cleaned, unlocked, moved or recreated.

/** The stored fields of a task workspace record that the check compares with live Git state. */
export type RetainedWorktreeRecord = {
  taskId: string;
  repositoryRoot: string;
  gitCommonDir: string;
  worktreeRoot: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
};

export type RetainedWorktreeCheck =
  { ok: true; worktree: TaskWorktree } | { ok: false; reason: string };

/**
 * The stored record must belong to this task, the registered repository and the managed worktree
 * root, and Git must still confirm a locked linked worktree of that repository at the managed
 * location (`<root>/<repository key>/<task id>`), on the task branch, with HEAD and the branch at
 * `expectedCommit` (the recorded base commit unless the caller passes another one). Any mismatch is
 * reported as a reason; the worktree is left exactly as it is.
 */
export const verifyRetainedTaskWorktree = async ({
  repository,
  taskId,
  workspace,
  worktreeRoot,
  expectedCommit = workspace.baseSha,
}: {
  /** The registered repository (canonical root and common Git directory). */
  repository: { localPath: string; gitCommonDir: string };
  taskId: string;
  workspace: RetainedWorktreeRecord;
  /** The managed worktree root the caller expects the workspace under. */
  worktreeRoot: string;
  expectedCommit?: string;
}): Promise<RetainedWorktreeCheck> => {
  const fail = (reason: string): RetainedWorktreeCheck => ({ ok: false, reason });
  let expectedBranch: string;
  try {
    expectedBranch = defaultTaskBranchName(taskId);
  } catch {
    return fail('the task identifier cannot name a task branch');
  }
  if (workspace.taskId !== taskId) return fail('the workspace belongs to another task');
  if (
    workspace.repositoryRoot !== repository.localPath ||
    workspace.gitCommonDir !== repository.gitCommonDir
  ) {
    return fail('the workspace belongs to another repository');
  }
  if (workspace.worktreeRoot !== worktreeRoot) {
    return fail('the managed worktree root changed since the workspace was created');
  }
  if (workspace.branch !== expectedBranch)
    return fail('the workspace branch is not the task branch');

  let inspection;
  try {
    inspection = await inspectTaskWorktree({
      repositoryPath: repository.localPath,
      worktreePath: workspace.path,
      branchName: workspace.branch,
    });
  } catch (error) {
    return fail(
      `the worktree could not be inspected (${error instanceof TaskWorktreeError ? error.code : 'unexpected'})`,
    );
  }
  if (inspection.state !== 'ready') {
    return fail(
      `Git does not confirm the retained worktree (${inspection.state}${inspection.issues.length > 0 ? `: ${inspection.issues.join(', ')}` : ''})`,
    );
  }
  if (
    inspection.repository.root !== repository.localPath ||
    inspection.repository.commonDir !== repository.gitCommonDir ||
    inspection.path !== workspace.path
  ) {
    return fail('the inspected worktree is not the recorded workspace');
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(worktreeRoot);
  } catch {
    return fail('the managed worktree root no longer exists');
  }
  if (workspace.path !== join(canonicalRoot, inspection.repository.key, taskId)) {
    return fail('the worktree is not at the managed location for this task');
  }
  if (inspection.head?.commit !== expectedCommit || inspection.branchCommit !== expectedCommit) {
    return fail(
      expectedCommit === workspace.baseSha
        ? 'the task branch no longer points at the recorded base commit (commits were made or the branch was moved)'
        : 'the task branch no longer points at the expected commit (the branch was moved)',
    );
  }
  return {
    ok: true,
    worktree: {
      taskId,
      branch: inspection.branch,
      path: inspection.path,
      baseBranch: workspace.baseBranch,
      baseCommit: workspace.baseSha,
      repository: inspection.repository,
      lockReason: taskWorktreeLockReason(inspection.branch),
    },
  };
};

/**
 * Whether a process group with this ID may still exist, by sending signal 0 (no signal is
 * delivered). Fail-closed: an invalid ID, a group that exists but cannot be signalled (`EPERM`) or
 * any unexpected error reads as "may exist". The ID may have been reused by an unrelated process,
 * so `true` never proves that the agent is still running — only `false` rules it out. Descendants
 * that left the group (SEC-01) are not covered.
 */
export const isProcessGroupAlive = (pid: number): boolean => {
  // `kill(-1)` / `kill(-0)` would address every process or the caller's own group.
  if (!Number.isSafeInteger(pid) || pid <= 1) return true;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
