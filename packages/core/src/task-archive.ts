import type { TaskStatus } from './task.js';

// TM-02 — Task archiving. Archive is an organizational visibility flag (`tasks.archived_at`), not
// a lifecycle state and not an execution outcome: the task keeps its status, runs, reviews,
// recoveries, publications and timestamps, and archiving never starts an agent, touches Git or
// removes a worktree. An archived task is hidden from the default board and stays inspectable; it
// must be restored before any lifecycle action or edit is accepted again.

/**
 * Statuses from which a task can be archived: no execution, review decision or queue claim is
 * pending. `Queued`, `In Progress` and `Review` are excluded because they still wait for the
 * scheduler, an agent or an operator decision (including an Approve & Push publication).
 */
export const taskArchivableStatuses = [
  'backlog',
  'done',
  'discarded',
  'failed',
  'stopped',
  'interrupted',
] as const satisfies readonly TaskStatus[];

export const isTaskArchivableStatus = (status: TaskStatus): boolean =>
  (taskArchivableStatuses as readonly TaskStatus[]).includes(status);

/** Database facts that decide whether a task can be archived now. */
export type TaskArchiveFacts = {
  status: TaskStatus;
  archived: boolean;
  /** A run of the task is pending, starting, running or stopping. */
  activeRun: boolean;
  /** An operator start request waits for the worker. */
  pendingStart: boolean;
  /** An Approve & Push publication is active or its push is pending. */
  blockingPublication: boolean;
  /** A local worktree cleanup is requested or running. */
  pendingCleanup: boolean;
};

export type TaskArchiveAssessment = { ok: true } | { ok: false; reason: string };

/** Whether the task can be archived; the reason is safe to show to the operator. */
export const assessTaskArchive = (facts: TaskArchiveFacts): TaskArchiveAssessment => {
  if (facts.archived) return { ok: false, reason: 'The task is already archived.' };
  if (!isTaskArchivableStatus(facts.status)) {
    return {
      ok: false,
      reason:
        facts.status === 'review'
          ? 'The task waits for a review decision. Approve & Push, Request Changes or Discard it first.'
          : 'The task is queued or running. Return it to Backlog or wait until its run ends.',
    };
  }
  if (facts.activeRun) return { ok: false, reason: 'An attempt of this task is still active.' };
  if (facts.pendingStart) {
    return { ok: false, reason: 'A start request for this task waits for the worker.' };
  }
  if (facts.blockingPublication) {
    return {
      ok: false,
      reason: 'An Approve & Push publication holds this task. Finish or retry the push first.',
    };
  }
  if (facts.pendingCleanup) {
    return {
      ok: false,
      reason: 'Removal of the local worktree is in progress. Wait until it finishes.',
    };
  }
  return { ok: true };
};
