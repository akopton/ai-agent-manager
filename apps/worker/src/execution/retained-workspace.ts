import type {
  ProjectRecordWithTrust,
  TaskRecord,
  WorkspaceRecord,
} from '@ai-agent-manager/database';
import { verifyRetainedTaskWorktree, type RetainedWorktreeCheck } from '@ai-agent-manager/git';

// Re-verification of a task's retained worktree from its stored record and live Git state. Used
// before a follow-up attempt (M6-02), a recovered attempt (TM-01) and before every Approve & Push
// mutation (M6-03). Read-only. The check itself lives in `packages/git` so the web process can run
// the same check before it records a Retry or Resume.

export type RetainedWorkspaceCheck = RetainedWorktreeCheck;

/**
 * Re-verifies the task's retained workspace: the stored record must belong to this task, project
 * and the worker's managed worktree root, and Git must still confirm a locked linked worktree of
 * the registered repository at the managed location, on the task branch, with HEAD and the branch
 * at the recorded base commit. Nothing is repaired, reset, cleaned or recreated: a mismatch refuses
 * the run and leaves the worktree as it is.
 */
export const verifyRetainedWorkspace = ({
  project,
  task,
  continuation,
  worktreeRoot,
  expectedCommit,
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
}): Promise<RetainedWorkspaceCheck> =>
  verifyRetainedTaskWorktree({
    repository: project,
    taskId: task.id,
    workspace: continuation.workspace,
    worktreeRoot,
    ...(expectedCommit === undefined ? {} : { expectedCommit }),
  });
