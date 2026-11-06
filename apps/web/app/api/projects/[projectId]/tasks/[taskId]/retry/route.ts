import { taskRecoveryPost } from '@/lib/server/recovery-route';

/**
 * Retry a Failed task (TM-01): records the decision and returns the task to Queued. No agent
 * starts; the next attempt runs only after an explicit Start execution.
 */
export const POST = taskRecoveryPost('retry');
