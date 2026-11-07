import { guardContentRead, handleRouteError, jsonResponse } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { getProjectTaskProposalGeneration } from '@/lib/server/task-proposals';

type RouteContext = {
  params: Promise<{ projectId: string; conversationId: string; generationId: string }>;
};

/** Status of one proposal request. Never contains the prompt. */
export const GET = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardContentRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId, conversationId, generationId } = await params;
    const generation = getProjectTaskProposalGeneration(
      getDatabase(),
      projectId,
      conversationId,
      generationId,
    );
    return jsonResponse({ generation });
  } catch (error) {
    return handleRouteError(error);
  }
};
