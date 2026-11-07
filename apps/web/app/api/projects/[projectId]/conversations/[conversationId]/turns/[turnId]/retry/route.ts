import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { retryConversationTurnRequestSchema } from '@/lib/conversations/contracts';
import { retryProjectConversationTurn } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';

type RouteContext = {
  params: Promise<{ projectId: string; conversationId: string; turnId: string }>;
};

/**
 * Asks again for a reply to the message of the latest failed, stopped or interrupted turn, with
 * the conversation's current settings. Never automatic. 202 when queued, 200 for a repeat.
 */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(
    request,
    retryConversationTurnRequestSchema,
  );
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, conversationId, turnId } = await params;
    const result = retryProjectConversationTurn(
      getDatabase(),
      projectId,
      conversationId,
      turnId,
      data,
    );
    return jsonResponse(result, result.created ? 202 : 200);
  } catch (error) {
    return handleRouteError(error);
  }
};
