import { runGitChecked } from './process.js';
import type { GitCommandOptions } from './schemas.js';

export type WorktreeEntry = {
  path: string;
  head: string | null;
  /** Full ref name, such as `refs/heads/main`; `null` when detached or bare. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
};

/**
 * Lists the worktrees Git has registered for a repository (`git worktree list --porcelain -z`).
 * The first entry is the main working tree. Read-only; does not prune stale entries.
 */
export const listWorktrees = async (
  cwd: string,
  options: GitCommandOptions = {},
): Promise<WorktreeEntry[]> => {
  const output = await runGitChecked(['worktree', 'list', '--porcelain', '-z'], {
    ...options,
    cwd,
  });
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const field of output.split('\0')) {
    const separator = field.indexOf(' ');
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? null : field.slice(separator + 1);
    if (key === 'worktree') {
      current = {
        path: value ?? '',
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
      };
      entries.push(current);
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') {
      current.locked = true;
      current.lockReason = value ?? '';
    } else if (key === 'prunable') current.prunable = true;
  }
  return entries;
};
