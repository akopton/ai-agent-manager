import type { TaskRecoveryKind } from '@ai-agent-manager/core';
import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { discardProjectTask, recoverProjectTask } from '@/lib/server/recovery';
import { discardTaskRequestSchema, recoverTaskRequestSchema } from '@/lib/tasks/recovery';

// Retry, Resume and Discard routes (TM-01). Same loopback Host, same-origin and JSON guards as
// every mutation. The kind comes from the route; the body only names the attempt the operator saw.
// None of them starts an agent or writes to Git.

type RouteContext = { params: Promise<{ projectId: string; taskId: string }> };

/** Builds the `POST {runId, processStopConfirmed?}` handler of `retry` or `resume`. */
export const taskRecoveryPost =
  (kind: TaskRecoveryKind) =>
  async (request: Request, { params }: RouteContext): Promise<Response> => {
    const { data, response } = await parseMutationRequest(request, recoverTaskRequestSchema);
    if (response !== undefined) {
      return response;
    }
    try {
      const { projectId, taskId } = await params;
      return jsonResponse({
        task: await recoverProjectTask(getDatabase(), projectId, taskId, kind, data),
      });
    } catch (error) {
      return handleRouteError(error);
    }
  };

/** `POST {runId, confirmed: true}`: Discard. */
export const taskDiscardPost = async (
  request: Request,
  { params }: RouteContext,
): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, discardTaskRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, taskId } = await params;
    return jsonResponse({ task: discardProjectTask(getDatabase(), projectId, taskId, data) });
  } catch (error) {
    return handleRouteError(error);
  }
};
