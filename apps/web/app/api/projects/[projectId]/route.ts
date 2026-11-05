import { errorResponse, guardRead, handleRouteError, jsonResponse } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { getProjectDetails } from '@/lib/server/projects';

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> => {
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
