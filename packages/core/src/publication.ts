import { z } from 'zod';

// Approve & Push (M6-03). An approval is an explicit operator decision about one run (attempt),
// bound to an immutable review snapshot (content hashes of every changed path), not to a task ID.
// Publishing is executed by the worker as a durable operation with its own state, separate from
// the task status and the run status (`ARCHITECTURE.md` §5.2): the task moves Review → Done only
// after both the commit and the push succeeded.

/**
 * Publication states (`ARCHITECTURE.md` §5.2 publish states, with the operator queue made explicit):
 *
 * - `approved`: recorded by the operator; waits for the worker. Nothing has been mutated.
 * - `committing`: the worker re-verifies the snapshot and creates the commit.
 * - `committed`: the task branch points at the new commit; the push has not started.
 * - `push_requested`: the operator asked to retry a failed or interrupted push.
 * - `pushing`: the worker is pushing the task branch.
 * - `pushed`: commit and push succeeded; the task is `Done`.
 * - `failed`: see `failureStage`. After a commit exists, only the push is retried.
 */
export const publicationStatuses = [
  'approved',
  'committing',
  'committed',
  'push_requested',
  'pushing',
  'pushed',
  'failed',
] as const;

export const publicationStatusSchema = z.enum(publicationStatuses);

export type PublicationStatus = z.infer<typeof publicationStatusSchema>;

/** States in which a publication holds the task: no other approval or change request is allowed. */
export const activePublicationStatuses = [
  'approved',
  'committing',
  'committed',
  'push_requested',
  'pushing',
] as const satisfies readonly PublicationStatus[];

export const isActivePublicationStatus = (status: PublicationStatus): boolean =>
  (activePublicationStatuses as readonly PublicationStatus[]).includes(status);

export const publicationStatusLabels: Readonly<Record<PublicationStatus, string>> = {
  approved: 'Approved, waiting for the worker',
  committing: 'Committing',
  committed: 'Committed, push pending',
  push_requested: 'Push retry requested',
  pushing: 'Pushing',
  pushed: 'Committed and pushed',
  failed: 'Failed',
};

/**
 * Where a failed publication stopped:
 *
 * - `validation`: the approval no longer matched the task, run, worktree, snapshot or remote.
 *   Nothing was committed; a fresh review and approval are required.
 * - `commit`: the commit could not be created. Nothing was published; approve again after fixing
 *   the cause (for example the Git identity).
 * - `push`: the commit exists on the task branch but is not (confirmed) on the remote. Only the
 *   push is retried; the commit is never recreated.
 */
export const publicationFailureStages = ['validation', 'commit', 'push'] as const;

export const publicationFailureStageSchema = z.enum(publicationFailureStages);

export type PublicationFailureStage = z.infer<typeof publicationFailureStageSchema>;

/** The two Git operations of a publication, recorded separately with their own outcome. */
export const gitOperationKinds = ['commit', 'push'] as const;

export const gitOperationKindSchema = z.enum(gitOperationKinds);

export type GitOperationKind = z.infer<typeof gitOperationKindSchema>;

export const gitOperationStatuses = ['running', 'succeeded', 'failed'] as const;

export const gitOperationStatusSchema = z.enum(gitOperationStatuses);

export type GitOperationStatus = z.infer<typeof gitOperationStatusSchema>;

/**
 * `Approve & Push` as confirmed by the operator. The browser echoes what it showed — the attempt,
 * the change-inventory revision, the destination remote and the task branch — and the server
 * compares each with its own fresh values instead of using them. `requestId` makes a repeated
 * submission (double click, retry after a lost response) return the same approval.
 */
export const approvePublicationInputSchema = z.strictObject({
  requestId: z.uuid(),
  runId: z.uuid(),
  revision: z.string().min(1).max(200),
  remoteName: z.string().min(1).max(200),
  branch: z.string().min(1).max(255),
  confirmed: z.literal(true, 'Confirm that you want to commit and push these changes.'),
});

export type ApprovePublicationInput = z.input<typeof approvePublicationInputSchema>;

/** `Retry push` for a publication whose commit exists but whose push failed or was interrupted. */
export const retryPublicationPushInputSchema = z.strictObject({
  publicationId: z.uuid(),
});

export type RetryPublicationPushInput = z.input<typeof retryPublicationPushInputSchema>;

/** Expected reasons an approval or a push retry is rejected. */
export const publicationErrorCodes = [
  'invalid_publication_input',
  'task_not_in_review',
  /** The latest run is not the run the operator reviewed. */
  'review_run_changed',
  /** The worktree changed after the review page was loaded. */
  'review_changes_changed',
  /** The latest run is not eligible for the normal review path. */
  'run_not_review_eligible',
  /** The change set cannot be published as reviewed (see `details.blockers`). */
  'publication_blocked',
  /** The project has no remote configured, or the configured remote does not exist. */
  'publication_remote_missing',
  /** The destination shown to the operator differs from the current destination. */
  'publication_target_changed',
  /** Another approval of this task is being published. */
  'publication_in_progress',
  /** A commit of this task exists but is not pushed; retry the push instead of approving again. */
  'publication_push_pending',
  /** Changes were already requested for the reviewed attempt. */
  'review_decision_exists',
  'publication_not_found',
  /** The publication is not in a state where only the push can be retried. */
  'push_retry_not_allowed',
] as const;

export const publicationErrorCodeSchema = z.enum(publicationErrorCodes);

export type PublicationErrorCode = z.infer<typeof publicationErrorCodeSchema>;

export class PublicationError extends Error {
  override name = 'PublicationError';

  constructor(
    readonly code: PublicationErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

const singleLine = (text: string): string =>
  // Control characters (including newlines) would let a title shape the commit message's structure.
  // eslint-disable-next-line no-control-regex -- intentionally matches control characters
  text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

/**
 * The commit message for an approved change set. Generated by the server from stored task data,
 * never taken from the browser: the task title as the subject, then the task and attempt IDs.
 */
export const buildPublicationCommitMessage = ({
  taskId,
  title,
  attempt,
  runId,
}: {
  taskId: string;
  title: string;
  attempt: number;
  runId: string;
}): string => {
  const subject = singleLine(title).slice(0, 200) || `Task ${taskId}`;
  return [
    subject,
    '',
    `AI Agent Manager task: ${taskId}`,
    `Approved attempt: ${attempt} (run ${runId})`,
  ].join('\n');
};
