import { updateProjectRequestSchema } from '@ai-agent-manager/core';
import {
  errorResponse,
  guardMutation,
  guardRead,
  handleRouteError,
  jsonResponse,
  parseMutationRequest,
} from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { disconnectProject, getProjectDetails, updateProject } from '@/lib/server/projects';

type RouteContext = { params: Promise<{ projectId: string }> };

export const GET = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId } = await params;
    const details = await getProjectDetails(getDatabase(), projectId);
    return details === undefined
      ? errorResponse('project_not_found', 'The project does not exist.', 404)
      : jsonResponse(details);
  } catch (error) {
    return handleRouteError(error);
  }
};

/** Updates project settings. The repository path and identity cannot be changed. */
export const PATCH = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, updateProjectRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId } = await params;
    const project = await updateProject(getDatabase(), projectId, data);
    return jsonResponse({ project });
  } catch (error) {
    return handleRouteError(error);
  }
};

/** Disconnects the project: removes its database record only, never the repository. */
export const DELETE = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardMutation(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId } = await params;
    return jsonResponse({ disconnected: disconnectProject(getDatabase(), projectId) });
  } catch (error) {
    return handleRouteError(error);
  }
};
