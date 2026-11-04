import { realpath, stat } from 'node:fs/promises';
import { GitCommandError, GitInputError } from './errors.js';
import { runGit, runGitChecked } from './process.js';
import { parseAbsolutePath, type GitCommandOptions } from './schemas.js';

export type RepositoryLocation = {
  /** Canonical (symlink-resolved) form of the input path. */
  path: string;
  /** Canonical root of the working tree that contains `path`. */
  root: string;
  /** Whether `path` is the working tree root rather than a directory inside it. */
  isRoot: boolean;
  /** Canonical Git directory of this working tree (`<common>/worktrees/<id>` for linked ones). */
  gitDir: string;
  /** Canonical common Git directory shared by the main and all linked worktrees. */
  commonDir: string;
  /** Whether this working tree is a linked worktree (its `.git` is a file). */
  isLinkedWorktree: boolean;
};

export type RepositoryInvalidReason =
  | 'invalid_path'
  | 'not_found'
  | 'not_directory'
  | 'not_git_repository'
  | 'bare_repository'
  | 'inside_git_directory'
  | 'not_repository_root'
  | 'unsafe_ownership';

export type RepositoryValidation =
  | { valid: true; repository: RepositoryLocation }
  | {
      valid: false;
      reason: RepositoryInvalidReason;
      message: string;
      /** The containing working tree root, when `reason` is `not_repository_root`. */
      root?: string;
    };

export type ValidateRepositoryOptions = GitCommandOptions & {
  /**
   * Accept a directory inside a working tree, not only its root. Defaults to `false`, so a nested
   * path is reported as `not_repository_root` along with the root to use instead.
   */
  allowNestedPath?: boolean;
};

const invalid = (
  reason: RepositoryInvalidReason,
  message: string,
  root?: string,
): RepositoryValidation => ({
  valid: false,
  reason,
  message,
  ...(root === undefined ? {} : { root }),
});

const hasErrorCode = (error: unknown, codes: string[]): boolean =>
  error instanceof Error && 'code' in error && codes.includes(String(error.code));

/** Git prints a single path followed by a newline; paths may themselves contain newlines. */
const stripFinalNewline = (output: string): string => output.replace(/\n$/, '');

/**
 * Determines whether `path` is an existing, non-bare Git working tree (a normal repository or a
 * linked worktree). Read-only: runs only `git rev-parse` queries.
 */
export const validateRepository = async (
  path: string,
  { allowNestedPath = false, ...commandOptions }: ValidateRepositoryOptions = {},
): Promise<RepositoryValidation> => {
  let inputPath: string;
  try {
    inputPath = parseAbsolutePath(path);
  } catch (error) {
    if (error instanceof GitInputError) {
      return invalid('invalid_path', error.message);
    }
    throw error;
  }

  try {
    if (!(await stat(inputPath)).isDirectory()) {
      return invalid('not_directory', 'The path is not a directory.');
    }
  } catch (error) {
    if (hasErrorCode(error, ['ENOENT', 'ENOTDIR'])) {
      return invalid('not_found', 'The path does not exist.');
    }
    throw error;
  }

  const canonicalPath = await realpath(inputPath);
  const options = { ...commandOptions, cwd: canonicalPath };
  const probe = await runGit(
    ['rev-parse', '--is-bare-repository', '--is-inside-work-tree', '--is-inside-git-dir'],
    options,
  );
  if (probe.exitCode !== 0) {
    if (probe.stderr.includes('not a git repository')) {
      return invalid('not_git_repository', 'The path is not inside a Git repository.');
    }
    if (probe.stderr.includes('dubious ownership')) {
      return invalid(
        'unsafe_ownership',
        'Git refused the repository because it is owned by another user (safe.directory).',
      );
    }
    throw new GitCommandError(`git rev-parse failed: ${probe.stderr.trim()}`, {
      code: 'GIT_FAILED',
      args: ['rev-parse'],
      exitCode: probe.exitCode,
      signal: null,
      stderr: probe.stderr,
    });
  }

  const [isBare, isInsideWorkTree, isInsideGitDir] = probe.stdout.trim().split('\n');
  if (isBare === 'true') {
    return invalid('bare_repository', 'Bare repositories have no working tree.');
  }
  if (isInsideGitDir === 'true') {
    return invalid('inside_git_directory', 'The path is inside a Git metadata directory.');
  }
  if (isInsideWorkTree !== 'true') {
    return invalid('not_git_repository', 'The path is not inside a Git working tree.');
  }

  const [rootOutput, gitDirOutput, commonDirOutput] = await Promise.all([
    runGitChecked(['rev-parse', '--show-toplevel'], options),
    runGitChecked(['rev-parse', '--absolute-git-dir'], options),
    runGitChecked(['rev-parse', '--path-format=absolute', '--git-common-dir'], options),
  ]);
  const [root, gitDir, commonDir] = await Promise.all(
    [rootOutput, gitDirOutput, commonDirOutput].map((output) =>
      realpath(stripFinalNewline(output)),
    ),
  );

  const isRoot = canonicalPath === root;
  if (!isRoot && !allowNestedPath) {
    return invalid(
      'not_repository_root',
      'The path is inside a Git working tree but is not its root.',
      root,
    );
  }

  return {
    valid: true,
    repository: {
      path: canonicalPath,
      root,
      isRoot,
      gitDir,
      commonDir,
      isLinkedWorktree: gitDir !== commonDir,
    },
  };
};
