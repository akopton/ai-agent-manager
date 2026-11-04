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
