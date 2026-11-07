import { guardContentRead, handleRouteError, jsonResponse } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { getConversationProposals } from '@/lib/server/task-proposals';

type RouteContext = { params: Promise<{ projectId: string; conversationId: string }> };

/**
 * The conversation's task proposals in a stable order, with the proposal requests that produced
 * them. Conversation content, so cross-origin browser requests are refused.
 */
export const GET = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardContentRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId, conversationId } = await params;
    return jsonResponse(getConversationProposals(getDatabase(), projectId, conversationId));
  } catch (error) {
    return handleRouteError(error);
  }
};
