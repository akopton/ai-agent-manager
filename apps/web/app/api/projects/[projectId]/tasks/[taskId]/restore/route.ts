import { taskArchivePost } from '@/lib/server/workspace-route';

/** Restore an archived task (TM-02) to the board with the status it had. */
export const POST = taskArchivePost('restore');
