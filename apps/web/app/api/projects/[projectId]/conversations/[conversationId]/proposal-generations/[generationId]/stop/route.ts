import { guardMutation, handleRouteError, jsonResponse } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { stopProjectTaskProposalGeneration } from '@/lib/server/task-proposals';

type RouteContext = {
  params: Promise<{ projectId: string; conversationId: string; generationId: string }>;
};

/**
 * Stops a proposal request: a queued one is cancelled at once, a running one is stopped by the
 * worker (process-group stop). A stopped request stores no proposals.
 */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardMutation(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId, conversationId, generationId } = await params;
    const generation = stopProjectTaskProposalGeneration(
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
