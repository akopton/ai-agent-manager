import { previewProjectRequestSchema } from '@ai-agent-manager/core';
import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { previewProject } from '@/lib/server/projects';

/**
 * Read-only preview of a repository before registration. It is a POST with the same Origin checks
 * as mutations because it inspects an arbitrary local path supplied in the request.
 */
export const POST = async (request: Request): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, previewProjectRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const preview = await previewProject(getDatabase(), data.path);
    return jsonResponse({ preview });
  } catch (error) {
    return handleRouteError(error);
  }
};
