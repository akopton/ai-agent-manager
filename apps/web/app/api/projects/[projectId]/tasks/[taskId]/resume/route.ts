import { taskRecoveryPost } from '@/lib/server/recovery-route';

/**
 * Resume a Stopped or Interrupted task (TM-01): records the decision and returns the task to
 * Queued. Resume continues the retained worktree in a new agent session; no agent starts until an
 * explicit Start execution.
 */
export const POST = taskRecoveryPost('resume');
