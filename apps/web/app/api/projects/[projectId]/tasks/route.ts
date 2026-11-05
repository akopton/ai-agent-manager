import { guardRead, handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { createProjectTask, listTasks } from '@/lib/server/tasks';
import { createProjectTaskRequestSchema } from '@/lib/tasks/contracts';

type RouteContext = { params: Promise<{ projectId: string }> };

/** Lists the project's tasks (the board). */
export const GET = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId } = await params;
    return jsonResponse({ tasks: listTasks(getDatabase(), projectId) });
  } catch (error) {
    return handleRouteError(error);
  }
};

/** Creates a task in `Backlog`. Never queues it, launches an agent or touches the repository. */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, createProjectTaskRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId } = await params;
    const task = await createProjectTask(getDatabase(), projectId, data);
    return jsonResponse({ task }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
};
