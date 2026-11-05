import { guardMutation, handleRouteError, jsonResponse } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { transitionProjectTask } from '@/lib/server/tasks';
import type { UserTaskAction } from '@/lib/tasks/actions';

type RouteContext = { params: Promise<{ projectId: string; taskId: string }> };

/**
 * Builds the `POST` handler of a named task action. The request has no body; the action is fixed
 * by the route, so a client can never choose a status.
 */
export const taskActionRoute =
  (action: UserTaskAction) =>
  async (request: Request, { params }: RouteContext): Promise<Response> => {
    const rejected = guardMutation(request);
    if (rejected !== undefined) {
      return rejected;
    }
    try {
      const { projectId, taskId } = await params;
      return jsonResponse({
        task: transitionProjectTask(getDatabase(), projectId, taskId, action),
      });
    } catch (error) {
      return handleRouteError(error);
    }
  };
