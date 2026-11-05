import { taskExecutionCommand } from '@/lib/server/execution-route';

/**
 * Persists a stop intent for the task's active run. The worker terminates the agent CLI's process
 * group (descendants that left it are not covered) and keeps every file.
 */
export const POST = taskExecutionCommand('stop');
