import { taskArchivePost } from '@/lib/server/workspace-route';

/**
 * Archive a task (TM-02): hides it from the default board. Not a status change and not Discard;
 * no record, worktree or branch is changed, and nothing runs.
 */
export const POST = taskArchivePost('archive');
