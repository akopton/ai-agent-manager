import { taskDiscardPost } from '@/lib/server/recovery-route';

/**
 * Discard a task after explicit confirmation (TM-01): a logical state change to Discarded. No
 * record is deleted, and the worktree and task branch are kept untouched.
 */
export const POST = taskDiscardPost;
