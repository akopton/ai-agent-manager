import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { addConversationMessageRequestSchema } from '@/lib/conversations/contracts';
import { addProjectConversationNote } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';

type RouteContext = { params: Promise<{ projectId: string; conversationId: string }> };

/**
 * Saves an operator note at the end of the history (C1). The note is stored only: no agent is
 * started and no reply is generated. Repeating a request with the same `requestId` returns the
 * stored note (200) instead of saving it twice (201).
 */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(
    request,
    addConversationMessageRequestSchema,
  );
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, conversationId } = await params;
    const result = addProjectConversationNote(getDatabase(), projectId, conversationId, data);
    return jsonResponse(result, result.created ? 201 : 200);
  } catch (error) {
    return handleRouteError(error);
  }
};
