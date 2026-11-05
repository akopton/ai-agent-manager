import { guardMutation, guardRead, handleRouteError, jsonResponse } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { getTaskExecution, startTaskExecution, stopTaskExecution } from '@/lib/server/execution';

type RouteContext = { params: Promise<{ projectId: string; taskId: string }> };

/** `GET`: the task's runs, workspace, last start request and recent events of the latest run. */
export const taskExecutionGet = async (
  request: Request,
  { params }: RouteContext,
): Promise<Response> => {
  const rejected = guardRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId, taskId } = await params;
    return jsonResponse({ execution: getTaskExecution(getDatabase(), projectId, taskId) });
  } catch (error) {
    return handleRouteError(error);
  }
};

/** Builds a body-less `POST` handler for an execution command (`start` or `stop`). */
export const taskExecutionCommand =
  (command: 'start' | 'stop') =>
  async (request: Request, { params }: RouteContext): Promise<Response> => {
    const rejected = guardMutation(request);
    if (rejected !== undefined) {
      return rejected;
    }
    try {
      const { projectId, taskId } = await params;
      const db = getDatabase();
      const execution =
        command === 'start'
          ? startTaskExecution(db, projectId, taskId)
          : stopTaskExecution(db, projectId, taskId);
      return jsonResponse({ execution }, command === 'start' ? 202 : 200);
    } catch (error) {
      return handleRouteError(error);
    }
  };
