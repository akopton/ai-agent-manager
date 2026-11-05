import { taskActionRoute } from '@/lib/server/task-action-route';

/** Explicitly enqueues a Backlog task. Makes it eligible for the scheduler; runs nothing. */
export const POST = taskActionRoute('queue');
