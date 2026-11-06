import { taskWorkspaceCleanupPost } from '@/lib/server/workspace-route';

/**
 * Remove local worktree (TM-02) after explicit confirmation: records a request for the worker,
 * which re-verifies and removes only the linked worktree directory. The task branch, the remote
 * branch and every record are kept.
 */
export const POST = taskWorkspaceCleanupPost;
