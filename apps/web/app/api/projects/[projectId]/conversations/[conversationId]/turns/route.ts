import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { sendConversationMessageRequestSchema } from '@/lib/conversations/contracts';
import { sendProjectConversationMessage } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';

type RouteContext = { params: Promise<{ projectId: string; conversationId: string }> };

/**
 * Sends a chat message to the conversation's AI (C2). Stores the message and a queued turn and
 * returns at once (202); the worker runs the CLI and stores the reply. Starts no process here.
 * Repeating a request with the same `requestId` returns the stored message and turn (200).
 */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(
    request,
    sendConversationMessageRequestSchema,
  );
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, conversationId } = await params;
    const result = sendProjectConversationMessage(getDatabase(), projectId, conversationId, data);
    return jsonResponse(result, result.created ? 202 : 200);
  } catch (error) {
    return handleRouteError(error);
  }
};
