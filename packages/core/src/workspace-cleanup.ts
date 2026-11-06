import { z } from 'zod';
import { isActiveTaskRunStatus, type TaskRunStatus } from './execution.js';
import type { PublicationStatus } from './publication.js';
import type { TaskStatus } from './task.js';

// TM-02 — Removal of a task's managed local worktree. An explicit, separately confirmed operator
// action, executed by the worker (the process that owns Git mutations), never a side effect of a
// status change, of archiving or of a schedule. Only the linked worktree directory is removed with a
// non-forced `git worktree remove`; the task branch, the remote branch, the main checkout and every
// database record are kept. The cleanup is recorded in `workspace_cleanups`; the workspace record
// itself is never deleted.
//
// The rules here decide from database records alone whether the task still needs its worktree.
// Git state (identity, lock, branch, HEAD, uncommitted, untracked and ignored files) is checked
// separately, read-only, when the page loads, when the request is recorded, and again by the worker
// right before it removes anything.

/**
 * - `requested`: recorded by the operator; waits for the worker. Nothing was changed.
 * - `removing`: the worker re-verified the worktree and is removing it.
 * - `removed`: the worktree directory and its registration are gone; the branch is kept.
 * - `failed`: nothing was removed (or the outcome is recorded in the message); a new request is
 *   possible once the cause is fixed.
 */
export const workspaceCleanupStatuses = ['requested', 'removing', 'removed', 'failed'] as const;

export const workspaceCleanupStatusSchema = z.enum(workspaceCleanupStatuses);

export type WorkspaceCleanupStatus = z.infer<typeof workspaceCleanupStatusSchema>;

/** Cleanups that hold the workspace: no second request is accepted meanwhile. */
export const activeWorkspaceCleanupStatuses = [
  'requested',
  'removing',
] as const satisfies readonly WorkspaceCleanupStatus[];

export const isActiveWorkspaceCleanupStatus = (status: WorkspaceCleanupStatus): boolean =>
  (activeWorkspaceCleanupStatuses as readonly WorkspaceCleanupStatus[]).includes(status);

export const workspaceCleanupStatusLabels: Readonly<Record<WorkspaceCleanupStatus, string>> = {
  requested: 'Removal requested, waiting for the worker',
  removing: 'Removing',
  removed: 'Removed',
  failed: 'Removal failed',
};

/**
 * Final task states whose worktree is no longer needed by any workflow. Every other state can
 * still continue in the worktree (Review, Request Changes, Retry, Resume, Approve & Push) or is
 * executing.
 */
export const workspaceCleanupTaskStatuses = [
  'done',
  'discarded',
] as const satisfies readonly TaskStatus[];

/**
 * Why the worktree may be removed:
 *
 * - `published`: the task is Done; the reviewed changes were committed on the task branch and the
 *   push was confirmed. The worktree must be clean at exactly the pushed commit.
 * - `discarded_unchanged`: the task was discarded and its worktree holds no work: clean, with HEAD
 *   and the branch still at the base commit. A discarded worktree with changes is never removed.
 */
export type WorkspaceCleanupBasis = 'published' | 'discarded_unchanged';

const fullShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * `Remove local worktree` for the workspace and commit the operator saw. `expectedCommit` makes a
 * stale page fail instead of removing a worktree whose state changed; `confirmed: true` records the
 * separate, deliberate decision. Paths are never accepted from the browser.
 */
export const requestWorkspaceCleanupInputSchema = z.strictObject({
  requestId: z.uuid(),
  workspaceId: z.uuid(),
  expectedCommit: z.string().regex(fullShaPattern, 'Expected a full commit SHA.'),
  confirmed: z.literal(true, {
    error: 'Confirm that you want to remove the local worktree.',
  }),
});

export type RequestWorkspaceCleanupInput = z.input<typeof requestWorkspaceCleanupInputSchema>;

/** Database facts about a task and one of its workspaces. */
export type WorkspaceCleanupFacts = {
  taskStatus: TaskStatus;
  workspace: { id: string; baseSha: string };
  /** Workspace records of the task (one per task in v1). */
  workspaceCount: number;
  latestRun: { id: string; status: TaskRunStatus; workspaceId: string | null } | null;
  /** Any run of the task is active. */
  activeRun: boolean;
  /** An operator start request for the task waits for the worker. */
  pendingStart: boolean;
  /** A change request or Retry/Resume waits for its next attempt. */
  pendingFollowUp: boolean;
  /** An Approve & Push publication is active or its push is pending. */
  blockingPublication: boolean;
  /** The newest publication of the task, if any. */
  latestPublication: {
    runId: string;
    workspaceId: string;
    status: PublicationStatus;
    commitSha: string | null;
  } | null;
  /** The newest cleanup of this workspace, if any. */
  cleanup: { status: WorkspaceCleanupStatus } | null;
};

export const workspaceCleanupBlockCodes = [
  'cleanup_in_progress',
  'already_removed',
  'task_active',
  'worktree_still_needed',
  'publication_in_progress',
  'workspace_ambiguous',
  'workspace_not_latest',
  'not_published',
] as const;

export type WorkspaceCleanupBlockCode = (typeof workspaceCleanupBlockCodes)[number];

export type WorkspaceCleanupAssessment =
  | { ok: true; basis: WorkspaceCleanupBasis; expectedCommit: string }
  | { ok: false; code: WorkspaceCleanupBlockCode; message: string };

const stillNeeded: Partial<Record<TaskStatus, string>> = {
  review:
    'The task is in Review: Approve & Push, Request Changes and Discard still need the worktree contents.',
  failed: 'The task is Failed: Retry continues in this worktree.',
  stopped: 'The task is Stopped: Resume continues in this worktree.',
  interrupted: 'The task is Interrupted: Resume continues in this worktree.',
};

/**
 * Whether the task's records allow removing this workspace, and at which commit the worktree must
 * be found. Fails closed: anything that is not clearly a finished, published task or an unchanged
 * discarded task is refused with a reason that is safe to show.
 */
export const assessWorkspaceCleanup = (
  facts: WorkspaceCleanupFacts,
): WorkspaceCleanupAssessment => {
  const refuse = (
    code: WorkspaceCleanupBlockCode,
    message: string,
  ): WorkspaceCleanupAssessment => ({
    ok: false,
    code,
    message,
  });
  if (facts.cleanup?.status === 'removed') {
    return refuse('already_removed', 'The local worktree was already removed.');
  }
  if (facts.cleanup !== null && isActiveWorkspaceCleanupStatus(facts.cleanup.status)) {
    return refuse('cleanup_in_progress', 'Removal of the local worktree is already in progress.');
  }
  if (
    facts.activeRun ||
    facts.pendingStart ||
    facts.taskStatus === 'queued' ||
    facts.taskStatus === 'in_progress' ||
    (facts.latestRun !== null && isActiveTaskRunStatus(facts.latestRun.status))
  ) {
    return refuse(
      'task_active',
      'The task is queued or an agent may still be working in the worktree.',
    );
  }
  const needed = stillNeeded[facts.taskStatus];
  if (needed !== undefined) return refuse('worktree_still_needed', needed);
  if (facts.pendingFollowUp) {
    return refuse('worktree_still_needed', 'A follow-up attempt still waits for this worktree.');
  }
  if (facts.blockingPublication) {
    return refuse(
      'publication_in_progress',
      'An Approve & Push publication holds this task. Finish or retry the push first.',
    );
  }
  if (facts.taskStatus !== 'done' && facts.taskStatus !== 'discarded') {
    return refuse(
      'worktree_still_needed',
      'Only Done or Discarded tasks can remove their worktree.',
    );
  }
  if (facts.workspaceCount !== 1) {
    return refuse(
      'workspace_ambiguous',
      'This task has more than one worktree record, so it is unclear which one is current.',
    );
  }
  if (facts.latestRun === null || facts.latestRun.workspaceId !== facts.workspace.id) {
    return refuse(
      'workspace_not_latest',
      'The worktree record is not the one the latest attempt ran in.',
    );
  }
  if (facts.taskStatus === 'done') {
    const publication = facts.latestPublication;
    if (
      publication === null ||
      publication.status !== 'pushed' ||
      publication.commitSha === null ||
      !fullShaPattern.test(publication.commitSha) ||
      publication.runId !== facts.latestRun.id ||
      publication.workspaceId !== facts.workspace.id
    ) {
      return refuse(
        'not_published',
        'No confirmed push of the latest attempt from this worktree is recorded.',
      );
    }
    return { ok: true, basis: 'published', expectedCommit: publication.commitSha };
  }
  return { ok: true, basis: 'discarded_unchanged', expectedCommit: facts.workspace.baseSha };
};

/** Expected reasons a cleanup request is rejected. */
export const workspaceCleanupErrorCodes = [
  'invalid_cleanup_input',
  'workspace_not_found',
  /** The task's records do not allow removing the worktree (see the message). */
  'cleanup_not_available',
  /** Git does not confirm a clean, verified managed worktree at the expected commit. */
  'worktree_not_removable',
  /** The page is outdated: the workspace or its expected commit changed. */
  'cleanup_state_changed',
  /** A removal for this worktree is already requested or running. */
  'cleanup_already_requested',
] as const;

export const workspaceCleanupErrorCodeSchema = z.enum(workspaceCleanupErrorCodes);

export type WorkspaceCleanupErrorCode = z.infer<typeof workspaceCleanupErrorCodeSchema>;

export class WorkspaceCleanupError extends Error {
  override name = 'WorkspaceCleanupError';

  constructor(
    readonly code: WorkspaceCleanupErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}
