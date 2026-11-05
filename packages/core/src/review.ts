import { z } from 'zod';

// Review decisions (M6-02). A decision is recorded for one specific run (attempt) and the
// workspace it ran in, never only for a task. This slice implements `Request Changes`; Approve &
// Push and Discard are separate milestones. A decision is separate from the task status, the run
// status and the (future) publish state.

/** Stored review decision statuses. Only `changes_requested` exists in this slice. */
export const reviewStatuses = ['changes_requested'] as const;

export const reviewStatusSchema = z.enum(reviewStatuses);

export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewStatusLabels: Readonly<Record<ReviewStatus, string>> = {
  changes_requested: 'Changes requested',
};

export const reviewFeedbackMinLength = 3;
export const reviewFeedbackMaxLength = 10_000;

/**
 * The reviewer's follow-up instructions for the next attempt. Trimmed; whitespace-only or very
 * short text is rejected so an empty change request can never start a pointless run.
 */
export const reviewFeedbackSchema = z
  .string()
  .trim()
  .min(reviewFeedbackMinLength, 'Describe the changes you want (at least a few words).')
  .max(
    reviewFeedbackMaxLength,
    `Use at most ${reviewFeedbackMaxLength.toLocaleString('en')} characters.`,
  );

/**
 * `Request Changes` for the run the reviewer saw. `runId` and `revision` (the change inventory
 * revision shown on the review page) make a stale page fail instead of attaching the feedback to
 * a different attempt or worktree state.
 */
export const requestChangesInputSchema = z.strictObject({
  runId: z.uuid(),
  revision: z.string().min(1).max(200),
  feedback: reviewFeedbackSchema,
});

export type RequestChangesInput = z.input<typeof requestChangesInputSchema>;

/** Expected reasons a review decision is rejected. */
export const reviewActionErrorCodes = [
  'invalid_review_input',
  'task_not_in_review',
  /** The latest run is not the run the reviewer saw (a newer attempt exists). */
  'review_run_changed',
  /** The worktree changed after the review page was loaded. */
  'review_changes_changed',
  /** The latest run is not eligible for the normal review path. */
  'run_not_review_eligible',
  /** A decision was already recorded for this run. */
  'changes_already_requested',
] as const;

export const reviewActionErrorCodeSchema = z.enum(reviewActionErrorCodes);

export type ReviewActionErrorCode = z.infer<typeof reviewActionErrorCodeSchema>;

export class ReviewActionError extends Error {
  override name = 'ReviewActionError';

  constructor(
    readonly code: ReviewActionErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}
