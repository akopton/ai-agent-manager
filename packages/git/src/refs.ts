import { GitCommandError } from './errors.js';
import { runGit, runGitChecked, type ProcessResult } from './process.js';
import { parseAbsolutePath, parseBranchName, type GitCommandOptions } from './schemas.js';

export type HeadState =
  | { kind: 'branch'; branch: string; commit: string }
  /** HEAD names a branch that has no commits yet (for example, a freshly initialized repo). */
  | { kind: 'unborn'; branch: string; commit: null }
  | { kind: 'detached'; commit: string };

export type LocalBranch = { name: string; commit: string };

export type GitRemote = {
  name: string;
  /** Configured fetch URLs, with credentials in HTTP(S) URLs redacted. */
  fetchUrls: string[];
  /** Explicit `pushurl` values (redacted); empty when pushes use the fetch URL. */
  pushUrls: string[];
};

const branchRefPrefix = 'refs/heads/';

/** Treats exit code 1 as a negative answer and anything other than 0 or 1 as a failure. */
const expectZeroOrOne = (args: readonly string[], result: ProcessResult): boolean => {
  if (result.exitCode === 0 || result.exitCode === 1) {
    return result.exitCode === 0;
  }
  throw new GitCommandError(`git ${args[0]} failed: ${result.stderr.trim()}`, {
    code: 'GIT_FAILED',
    args,
    exitCode: result.exitCode,
    signal: null,
    stderr: result.stderr,
  });
};

const runPredicate = async (
  args: readonly string[],
  root: string,
  options: GitCommandOptions,
): Promise<{ matched: boolean; stdout: string }> => {
  const result = await runGit(args, {
    ...options,
    cwd: parseAbsolutePath(root, 'Repository root'),
  });
  return { matched: expectZeroOrOne(args, result), stdout: result.stdout };
};

export const getHead = async (
  root: string,
  options: GitCommandOptions = {},
): Promise<HeadState> => {
  const [symbolic, commit] = await Promise.all([
    runPredicate(['symbolic-ref', '--quiet', 'HEAD'], root, options),
    runPredicate(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root, options),
  ]);
  const commitSha = commit.matched ? commit.stdout.trim() : null;

  if (!symbolic.matched) {
    if (commitSha === null) {
      throw new GitCommandError('HEAD is detached but does not resolve to a commit.', {
        code: 'GIT_FAILED',
        args: ['rev-parse', 'HEAD'],
        exitCode: 1,
        signal: null,
        stderr: '',
      });
    }
    return { kind: 'detached', commit: commitSha };
  }

  const ref = symbolic.stdout.trim();
  const branch = ref.startsWith(branchRefPrefix) ? ref.slice(branchRefPrefix.length) : ref;
  return commitSha === null
    ? { kind: 'unborn', branch, commit: null }
    : { kind: 'branch', branch, commit: commitSha };
};

/** Lists local branches (`refs/heads/*`) sorted by name. Ref names cannot contain newlines. */
export const listBranches = async (
  root: string,
  options: GitCommandOptions = {},
): Promise<LocalBranch[]> => {
  const output = await runGitChecked(
    ['for-each-ref', '--format=%(refname)%00%(objectname)', branchRefPrefix],
    { ...options, cwd: parseAbsolutePath(root, 'Repository root') },
  );
  return output
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [ref = '', commit = ''] = line.split('\0');
      return { name: ref.slice(branchRefPrefix.length), commit };
    });
};

/** Checks whether `refs/heads/<branch>` exists. Invalid branch names throw `GitInputError`. */
export const hasLocalBranch = async (
  root: string,
  branch: string,
  options: GitCommandOptions = {},
): Promise<boolean> => {
  const name = parseBranchName(branch);
  const { matched } = await runPredicate(
    ['show-ref', '--verify', '--quiet', `${branchRefPrefix}${name}`],
    root,
    options,
  );
  return matched;
};

/** Resolves `refs/heads/<branch>` to its full commit SHA, or `null` when the branch is absent. */
export const resolveLocalBranch = async (
  root: string,
  branch: string,
  options: GitCommandOptions = {},
): Promise<string | null> => {
  const name = parseBranchName(branch);
  const { matched, stdout } = await runPredicate(
    ['rev-parse', '--verify', '--quiet', `${branchRefPrefix}${name}^{commit}`],
    root,
    options,
  );
  return matched ? stdout.trim() : null;
};

/** Hides user information (often a token) in HTTP(S) and FTP(S) URLs. Other URLs are unchanged. */
export const redactRemoteUrl = (url: string): string =>
  url.replace(/^((?:https?|ftps?):\/\/)[^/?#]*@/i, '$1***@');

/**
 * Lists remotes as configured (`remote.<name>.url` / `pushurl`), in config order. URLs are data:
 * they are never executed, and `url.*.insteadOf` rewrites are not applied.
 */
export const listRemotes = async (
  root: string,
  options: GitCommandOptions = {},
): Promise<GitRemote[]> => {
  const { matched, stdout } = await runPredicate(
    ['config', '--null', '--get-regexp', '^remote\\..+\\.(url|pushurl)$'],
    root,
    options,
  );
  if (!matched) {
    return [];
  }
  const remotes = new Map<string, GitRemote>();
  for (const entry of stdout.split('\0')) {
    const separator = entry.indexOf('\n');
    if (separator === -1) {
      continue;
    }
    const key = entry.slice(0, separator);
    const value = redactRemoteUrl(entry.slice(separator + 1));
    const variableStart = key.lastIndexOf('.');
    const name = key.slice('remote.'.length, variableStart);
    const remote = remotes.get(name) ?? { name, fetchUrls: [], pushUrls: [] };
    (key.slice(variableStart + 1) === 'pushurl' ? remote.pushUrls : remote.fetchUrls).push(value);
    remotes.set(name, remote);
  }
  return [...remotes.values()];
};
