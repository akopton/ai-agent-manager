import { taskActionRoute } from '@/lib/server/task-action-route';

/** Withdraws a queued task back to Backlog. */
export const POST = taskActionRoute('return_to_backlog');
