import type {
  ChangedFileView,
  DiffOmissionReasonView,
  PublicationReadinessReason,
  PublicationView,
  ReviewBlockReason,
} from '@/lib/review/contracts';

// Plain-language labels for the Review Changes page.

export const fileChangeLabels: Readonly<Record<ChangedFileView['change'], string>> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  type_changed: 'Type changed',
  conflicted: 'Conflicted',
};

/** The change label, with untracked files named as such (they are not known to Git yet). */
export const describeFileChange = (file: ChangedFileView): string =>
  !file.tracked && file.change === 'added' ? 'Untracked' : fileChangeLabels[file.change];

export const diffOmissionMessages: Readonly<Record<DiffOmissionReasonView, string>> = {
  too_large: 'File is too large to display (over 1 MiB). Its content was not read.',
  binary: 'Binary file. Its content is not shown.',
  unsupported_file_type:
    'Not a regular file (for example a submodule or nested repository). No diff is shown.',
  unsupported_encoding: 'Content is not valid UTF-8, so it is not shown.',
  diff_too_large: 'The diff is too large to display (over 1 MiB). A truncated diff is never shown.',
  read_budget_exhausted: 'Not read during the overview. Open the file to load its diff.',
  outside_worktree: 'The path resolves outside the worktree. Nothing was read.',
};

export const reviewBlockMessages: Readonly<Record<ReviewBlockReason, string>> = {
  no_run: 'The task has not run yet.',
  run_active: 'The agent is still running.',
  run_not_completed: 'The latest run did not complete (stopped, failed or interrupted).',
  integrity_violation: 'The Git integrity check found an unexpected Git mutation.',
  integrity_inconclusive: 'The Git integrity check was inconclusive.',
  integrity_not_run: 'The Git integrity check did not run for this run.',
  task_not_in_review: 'The task is not in Review.',
  changes_unavailable: 'The changes could not be inspected.',
  changed_during_inspection:
    'The worktree changed while it was inspected. Refresh to inspect it again.',
};

export const publicationReadinessMessages: Readonly<Record<PublicationReadinessReason, string>> = {
  not_review_eligible: 'The latest attempt is not eligible for the normal review path (see above).',
  no_changes: 'The worktree has no changes to publish.',
  files_truncated:
    'Not every changed file is listed, so the change set cannot be approved as shown.',
  unexpected_commits:
    'The task branch has commits after the base commit. Only uncommitted changes made in the worktree can be approved.',
  conflicted_file: 'A file has unresolved conflicts.',
  unsupported_file:
    'A changed entry is a submodule, nested repository or other unsupported file type, or lies behind a symlinked directory.',
  no_remote:
    'The project has no remote configured. Choose a remote in the project settings; nothing is pushed to a guessed destination.',
  remote_not_found: 'The project’s configured remote does not exist in the repository.',
  remote_mirror: 'The project’s remote is a mirror remote; a single-branch push is not possible.',
  publication_active: 'This task is already being published.',
  push_pending: 'A commit of this task exists but is not pushed yet. Use Retry push below.',
};

const failureTitles: Readonly<Record<NonNullable<PublicationView['failureStage']>, string>> = {
  validation: 'Not published: the changes no longer match the approval',
  commit: 'Not published: the commit was not created',
  push: 'Committed, but not pushed',
};

export const describePublicationFailure = (publication: PublicationView): string =>
  publication.failureStage === null ? 'Not published' : failureTitles[publication.failureStage];

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

export const shortSha = (sha: string): string => sha.slice(0, 12);

export const taskReviewUrl = (projectId: string, taskId: string): string =>
  `/projects/${projectId}/tasks/${taskId}/review`;

export const taskReviewDiffUrl = (projectId: string, taskId: string, path: string): string =>
  `/api/projects/${projectId}/tasks/${taskId}/review/diff?${new URLSearchParams({ path })}`;
