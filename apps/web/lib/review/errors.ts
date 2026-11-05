// Error codes of the read-only Review Changes routes. Shared by the server, the API contracts and
// the browser; nothing here touches the filesystem.

export const reviewErrorCodes = [
  /** The task has no finished run with a recorded workspace, or its run is still active. */
  'review_unavailable',
  /** The stored workspace record does not match the task, project or managed worktree root. */
  'workspace_identity_mismatch',
  /** The worktree is missing, moved, unregistered, unlocked or on another branch. */
  'workspace_not_verified',
  /** The worktree exists but could not be read (for example, permissions). */
  'workspace_inaccessible',
  /** The recorded base commit no longer exists in the repository. */
  'base_commit_missing',
  /** The requested path is not among the task's changed files. */
  'review_file_not_found',
  /** Git failed while inspecting the worktree. */
  'review_inspection_failed',
] as const;

export type ReviewErrorCode = (typeof reviewErrorCodes)[number];

export class ReviewError extends Error {
  override name = 'ReviewError';

  constructor(
    readonly code: ReviewErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const reviewErrorStatus = (code: ReviewErrorCode): number => {
  switch (code) {
    case 'review_file_not_found':
      return 404;
    case 'review_inspection_failed':
      return 500;
    default:
      return 409;
  }
};
