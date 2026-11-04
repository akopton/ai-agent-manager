import { readFilterOverrides, runGitChecked } from './process.js';
import { parseAbsolutePath, type GitCommandOptions } from './schemas.js';

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
/** Raw `git status --porcelain=v2 -z` output used by the parsers below. Internal. */
export const readStatusOutput = async (
  root: string,
  options: GitCommandOptions = {},
): Promise<string> => {
  const cwd = parseAbsolutePath(root, 'Repository root');
  const config = await readFilterOverrides(cwd, options);
  return runGitChecked(
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
};

export const getWorkingTreeStatus = async (
  root: string,
  options: GitCommandOptions = {},
): Promise<WorkingTreeStatus> => parseStatusOutput(await readStatusOutput(root, options));

/** Parses `readStatusOutput` records. Internal. */
export const parseStatusOutput = (output: string): WorkingTreeStatus => {
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

/**
 * Lists ignored paths (directories collapsed) that `git worktree remove` would delete along with a
 * clean worktree. Internal; used to protect files such as `.env` or build output.
 */
export const listIgnoredPaths = async (
  root: string,
  options: GitCommandOptions = {},
): Promise<string[]> => {
  const cwd = parseAbsolutePath(root, 'Repository root');
  const config = await readFilterOverrides(cwd, options);
  const output = await runGitChecked(
    [
      'status',
      '--porcelain=v2',
      '-z',
      '--ignored=traditional',
      '--untracked-files=normal',
      '--ignore-submodules=dirty',
    ],
    { ...options, cwd, config },
  );
  return output
    .split('\0')
    .filter((record) => record.startsWith('! '))
    .map((record) => record.slice(2));
};
