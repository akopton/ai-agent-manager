import type { HeadStateView, WorkingTreeSummary } from '@/lib/projects/contracts';

export const shortCommit = (commit: string): string => commit.slice(0, 7);

export const describeHead = (head: HeadStateView): string => {
  switch (head.kind) {
    case 'branch':
      return `${head.branch} at ${shortCommit(head.commit)}`;
    case 'unborn':
      return `${head.branch} (no commits yet)`;
    case 'detached':
      return `Detached at ${shortCommit(head.commit)}`;
  }
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

export const describeWorkingTree = (summary: WorkingTreeSummary): string => {
  if (summary.isClean) {
    return 'Clean';
  }
  return [
    summary.staged > 0 ? `${plural(summary.staged, 'staged change')}` : undefined,
    summary.unstaged > 0 ? `${plural(summary.unstaged, 'unstaged change')}` : undefined,
    summary.untracked > 0 ? `${plural(summary.untracked, 'untracked file')}` : undefined,
    summary.conflicted > 0 ? `${plural(summary.conflicted, 'conflicted file')}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(', ');
};

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

export const formatTimestamp = (milliseconds: number): string =>
  dateFormat.format(new Date(milliseconds));
