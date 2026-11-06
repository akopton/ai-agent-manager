import {
  guardContentRead,
  guardMutation,
  handleRouteError,
  jsonResponse,
  parseMutationRequest,
} from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import {
  archiveProjectTask,
  getTaskWorkspacePanel,
  requestTaskWorkspaceCleanup,
  restoreProjectTask,
} from '@/lib/server/workspace';
import { workspaceCleanupRequestSchema } from '@/lib/tasks/workspace';

// Archive/Restore and the managed workspace routes (TM-02). Same loopback Host, same-origin and
// JSON guards as every other task route. The workspace is named by its record ID; a path is never
// accepted. None of these routes starts an agent or writes to Git: a cleanup request is executed by
// the worker after it verifies the worktree again.

type RouteContext = { params: Promise<{ projectId: string; taskId: string }> };

/** `GET`: the workspace panel (recorded worktree, read-only Git state, cleanup availability). */
export const taskWorkspaceGet = async (
  request: Request,
  { params }: RouteContext,
): Promise<Response> => {
  // It shows local paths and repository state, so cross-origin reads are refused too.
  const rejected = guardContentRead(request);
  if (rejected !== undefined) return rejected;
  try {
    const { projectId, taskId } = await params;
    return jsonResponse({
      workspace: await getTaskWorkspacePanel(getDatabase(), projectId, taskId),
    });
  } catch (error) {
    return handleRouteError(error);
  }
};

/** `POST {requestId, workspaceId, expectedCommit, confirmed: true}`: Remove local worktree. */
export const taskWorkspaceCleanupPost = async (
  request: Request,
  { params }: RouteContext,
): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, workspaceCleanupRequestSchema);
  if (response !== undefined) return response;
  try {
    const { projectId, taskId } = await params;
    return jsonResponse({
      cleanup: await requestTaskWorkspaceCleanup(getDatabase(), projectId, taskId, data),
    });
  } catch (error) {
    return handleRouteError(error);
  }
};

/** Builds the body-less `POST` handler of Archive or Restore. */
export const taskArchivePost =
  (action: 'archive' | 'restore') =>
  async (request: Request, { params }: RouteContext): Promise<Response> => {
    const rejected = guardMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const { projectId, taskId } = await params;
      const db = getDatabase();
      return jsonResponse({
        task:
          action === 'archive'
            ? archiveProjectTask(db, projectId, taskId)
            : restoreProjectTask(db, projectId, taskId),
      });
    } catch (error) {
      return handleRouteError(error);
    }
  };
