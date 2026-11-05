import { taskExecutionCommand } from '@/lib/server/execution-route';

/**
 * Records an explicit operator request to execute this Queued task (202). The worker claims it,
 * re-checks Trusted Local consent, project trust and runtime capacity, and only then launches.
 */
export const POST = taskExecutionCommand('start');
