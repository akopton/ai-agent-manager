import { guardRead, handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { createProjectConversationRequestSchema } from '@/lib/conversations/contracts';
import { createProjectConversation, listConversations } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';

type RouteContext = { params: Promise<{ projectId: string }> };

/** Lists the project's conversations, most recently changed first. */
export const GET = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId } = await params;
    return jsonResponse({ conversations: listConversations(getDatabase(), projectId) });
  } catch (error) {
    return handleRouteError(error);
  }
};

/** Creates a conversation with an empty history. Never starts an agent. */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(
    request,
    createProjectConversationRequestSchema,
  );
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId } = await params;
    const conversation = createProjectConversation(getDatabase(), projectId, data);
    return jsonResponse({ conversation }, 201);
  } catch (error) {
    return handleRouteError(error);
  }
};
