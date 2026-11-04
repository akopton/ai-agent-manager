import type { TaskWorktreeInspection } from './task-worktree.js';

export type GitCommandErrorCode =
  /** The Git executable could not be started. */
  | 'GIT_UNAVAILABLE'
  /** Git exited with a non-zero status. */
  | 'GIT_FAILED'
  /** Git did not finish within the configured timeout and was terminated. */
  | 'GIT_TIMEOUT'
  /** Git produced more output than allowed and was terminated. */
  | 'GIT_OUTPUT_LIMIT';

export type GitCommandErrorDetails = {
  code: GitCommandErrorCode;
  /** Git arguments after the safety prefix, for diagnostics. Never contains secrets we add. */
  args: readonly string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  cause?: unknown;
};

export class GitCommandError extends Error {
  override name = 'GitCommandError';
  readonly code: GitCommandErrorCode;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(message: string, details: GitCommandErrorDetails) {
    super(message, { cause: details.cause });
    this.code = details.code;
    this.args = details.args;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.stderr = details.stderr;
  }
}

/** An argument (path, branch name, or option) was rejected before running Git. */
export class GitInputError extends Error {
  override name = 'GitInputError';
}

export type TaskWorktreeErrorCode =
  /** The repository path is not a valid main working tree. */
  | 'INVALID_REPOSITORY'
  | 'BASE_BRANCH_NOT_FOUND'
  /** The recorded base commit does not exist in the repository or is not a commit. */
  | 'BASE_COMMIT_NOT_FOUND'
  /** The task branch already exists; it was not touched. */
  | 'BRANCH_EXISTS'
  /** The destination path exists or is registered; it was not touched. */
  | 'DESTINATION_EXISTS'
  /** A path is a symlink, not owned by the current user, or inside the repository. */
  | 'UNSAFE_PATH'
  /** Creation failed and every resource this call created was rolled back. */
  | 'CREATE_FAILED'
  /** Creation failed or could not be verified; resources were preserved for manual recovery. */
  | 'RECOVERY_REQUIRED'
  /** The worktree's identity or ownership could not be fully verified. */
  | 'NOT_VERIFIED'
  /** The worktree has modified, staged, untracked, conflicted, or (by default) ignored files. */
  | 'WORKTREE_DIRTY'
  /** Git refused or failed to remove the worktree; it was preserved. */
  | 'REMOVE_FAILED';

/** Observed state of resources after a failed creation, for manual recovery. */
export type TaskWorktreeRecoveryState = {
  branch: string;
  /** Commit the branch points to now, or `null` if it does not exist. */
  branchCommit: string | null;
  path: string;
  pathExists: boolean;
  registered: boolean;
};

export class TaskWorktreeError extends Error {
  override name = 'TaskWorktreeError';
  readonly code: TaskWorktreeErrorCode;
  readonly recovery: TaskWorktreeRecoveryState | undefined;
  /** Inspection result for verification failures. */
  readonly inspection: TaskWorktreeInspection | undefined;

  constructor(
    code: TaskWorktreeErrorCode,
    message: string,
    details: {
      cause?: unknown;
      recovery?: TaskWorktreeRecoveryState;
      inspection?: TaskWorktreeInspection;
    } = {},
  ) {
    super(message, { cause: details.cause });
    this.code = code;
    this.recovery = details.recovery;
    this.inspection = details.inspection;
  }
}
