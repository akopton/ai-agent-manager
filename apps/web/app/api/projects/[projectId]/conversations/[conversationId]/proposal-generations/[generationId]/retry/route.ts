import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { retryTaskProposalGenerationRequestSchema } from '@/lib/conversations/contracts';
import { getDatabase } from '@/lib/server/database';
import { retryProjectTaskProposalGeneration } from '@/lib/server/task-proposals';

type RouteContext = {
  params: Promise<{ projectId: string; conversationId: string; generationId: string }>;
};

/**
 * Asks again after the latest proposal request failed, was stopped or was interrupted. Never
 * automatic. 202 when queued, 200 for a repeat of the same `requestId`.
 */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(
    request,
    retryTaskProposalGenerationRequestSchema,
  );
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, conversationId, generationId } = await params;
    const result = retryProjectTaskProposalGeneration(
      getDatabase(),
      projectId,
      conversationId,
      generationId,
      data,
    );
    return jsonResponse(result, result.created ? 202 : 200);
  } catch (error) {
    return handleRouteError(error);
  }
};
