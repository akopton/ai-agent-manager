import { guardRead, handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { getTask, updateProjectTask } from '@/lib/server/tasks';
import { updateProjectTaskRequestSchema } from '@/lib/tasks/contracts';

type RouteContext = { params: Promise<{ projectId: string; taskId: string }> };

export const GET = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId, taskId } = await params;
    return jsonResponse({ task: getTask(getDatabase(), projectId, taskId) });
  } catch (error) {
    return handleRouteError(error);
  }
};

/** Edits task fields allowed in the task's current status. The status itself is not editable. */
export const PATCH = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, updateProjectTaskRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, taskId } = await params;
    const task = await updateProjectTask(getDatabase(), projectId, taskId, data);
    return jsonResponse({ task });
  } catch (error) {
    return handleRouteError(error);
  }
};
