import { runGit, runGitChecked } from './process.js';
import { parseAbsolutePath, type GitCommandOptions } from './schemas.js';
import { GitCommandError } from './errors.js';

export type WorkingTreeStatus = {
  /** No staged, unstaged, untracked, or conflicted paths. Ignored files do not count. */
  isClean: boolean;
  /** Paths with changes in the index relative to HEAD. */
  staged: string[];
  /** Tracked paths with working tree changes relative to the index. */
  unstaged: string[];
  untracked: string[];
  /** Paths with unresolved merge conflicts. */
  conflicted: string[];
};

/**
 * `git status` may run clean filters configured in repository config. Neutralize every configured
 * filter driver for this command: an empty command disables the filter.
 */
const listFilterOverrides = async (
  cwd: string,
  options: GitCommandOptions,
): Promise<Array<readonly [string, string]>> => {
  const result = await runGit(['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], {
    ...options,
    cwd,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new GitCommandError(`git config failed: ${result.stderr.trim()}`, {
      code: 'GIT_FAILED',
      args: ['config'],
      exitCode: result.exitCode,
      signal: null,
      stderr: result.stderr,
    });
  }
  const drivers = new Set(
    result.stdout
      .split('\0')
      .filter((key) => key.startsWith('filter.') && key.lastIndexOf('.') > 'filter'.length)
      .map((key) => key.slice('filter.'.length, key.lastIndexOf('.'))),
  );
  return [...drivers].flatMap((driver) => [
    [`filter.${driver}.clean`, ''] as const,
    [`filter.${driver}.smudge`, ''] as const,
    [`filter.${driver}.process`, ''] as const,
    [`filter.${driver}.required`, 'false'] as const,
  ]);
};

/** Returns the text after the `count`-th space; porcelain v2 paths may contain spaces. */
const afterFields = (record: string, count: number): string => {
  let index = -1;
  for (let field = 0; field < count; field += 1) {
    index = record.indexOf(' ', index + 1);
    if (index === -1) {
      return '';
    }
  }
  return record.slice(index + 1);
};

/**
 * Reports staged, unstaged, untracked, and conflicted paths using `git status --porcelain=v2 -z`.
 * Read-only: optional locks are disabled, so the index is not refreshed or rewritten. Modified
 * content inside submodules is not inspected; changed submodule commits are reported.
 */
export const getWorkingTreeStatus = async (
  root: string,
  options: GitCommandOptions = {},
): Promise<WorkingTreeStatus> => {
  const cwd = parseAbsolutePath(root, 'Repository root');
  const config = await listFilterOverrides(cwd, options);
  const output = await runGitChecked(
    [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=dirty',
      '--no-renames',
    ],
    { ...options, cwd, config },
  );

  const status: WorkingTreeStatus = {
    isClean: true,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  for (const record of output.split('\0')) {
    const type = record[0];
    if (type === '1') {
      const path = afterFields(record, 8);
      if (record[2] !== '.') status.staged.push(path);
      if (record[3] !== '.') status.unstaged.push(path);
    } else if (type === 'u') {
      status.conflicted.push(afterFields(record, 10));
    } else if (type === '?') {
      status.untracked.push(record.slice(2));
    }
  }
  status.isClean =
    status.staged.length +
      status.unstaged.length +
      status.untracked.length +
      status.conflicted.length ===
    0;
  return status;
};
