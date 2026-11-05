import { registerProjectRequestSchema } from '@ai-agent-manager/core';
import { guardRead, handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { listProjects, registerProject } from '@/lib/server/projects';

export const GET = (request: Request): Response => {
  const rejected = guardRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    return jsonResponse({ projects: listProjects(getDatabase()) });
  } catch (error) {
    return handleRouteError(error);
  }
};

export const POST = async (request: Request): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, registerProjectRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const project = await registerProject(getDatabase(), data);
    return jsonResponse({ project }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
};
