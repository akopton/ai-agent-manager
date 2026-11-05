import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ProjectRecordWithTrust,
  TaskRecord,
  WorkspaceRecord,
} from '@ai-agent-manager/database';
import {
  defaultTaskBranchName,
  inspectTaskWorktree,
  TaskWorktreeError,
  taskWorktreeLockReason,
  type TaskWorktree,
} from '@ai-agent-manager/git';

// Re-verification of a task's retained worktree from its stored record and live Git state. Used
// before a follow-up attempt (M6-02) and before every Approve & Push mutation (M6-03). Read-only.

export type RetainedWorkspaceCheck =
  { ok: true; worktree: TaskWorktree } | { ok: false; reason: string };

/**
 * Re-verifies the reviewed run's retained workspace before a follow-up attempt (M6-02): the stored
 * record must belong to this task, project and managed worktree root, and Git must still confirm a
 * locked linked worktree of the registered repository at the managed location, on the task branch,
 * with HEAD and the branch at the recorded base commit. Nothing is repaired, reset, cleaned or
 * recreated: a mismatch refuses the run and leaves the worktree as it is.
 */
export const verifyRetainedWorkspace = async ({
  project,
  task,
  continuation,
  worktreeRoot,
  expectedCommit = continuation.workspace.baseSha,
}: {
  project: ProjectRecordWithTrust;
  task: TaskRecord;
  continuation: { workspace: WorkspaceRecord };
  worktreeRoot: string;
  /**
   * Where HEAD and the task branch must point. Defaults to the recorded base commit; Approve & Push
   * passes its own commit when only the push is retried (M6-03).
   */
  expectedCommit?: string;
}): Promise<RetainedWorkspaceCheck> => {
  const { workspace } = continuation;
  const fail = (reason: string): RetainedWorkspaceCheck => ({ ok: false, reason });
  let expectedBranch: string;
  try {
    expectedBranch = defaultTaskBranchName(task.id);
  } catch {
    return fail('the task identifier cannot name a task branch');
  }
  if (workspace.taskId !== task.id) return fail('the workspace belongs to another task');
  if (
    workspace.repositoryRoot !== project.localPath ||
    workspace.gitCommonDir !== project.gitCommonDir
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
      repositoryPath: project.localPath,
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
    inspection.repository.root !== project.localPath ||
    inspection.repository.commonDir !== project.gitCommonDir ||
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
  if (workspace.path !== join(canonicalRoot, inspection.repository.key, task.id)) {
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
      taskId: task.id,
      branch: inspection.branch,
      path: inspection.path,
      baseBranch: workspace.baseBranch,
      baseCommit: workspace.baseSha,
      repository: inspection.repository,
      lockReason: taskWorktreeLockReason(inspection.branch),
    },
  };
};
