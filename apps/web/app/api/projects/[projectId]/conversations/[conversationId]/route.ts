import {
  guardContentRead,
  handleRouteError,
  jsonResponse,
  parseMutationRequest,
} from '@/lib/server/api';
import { updateProjectConversationRequestSchema } from '@/lib/conversations/contracts';
import { getConversationDetail, updateProjectConversation } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';

type RouteContext = { params: Promise<{ projectId: string; conversationId: string }> };

/**
 * The conversation with its full history, reply requests (turns) and C3 task proposals. The history is stored
 * conversation text, so the route also refuses requests a browser marks as cross-origin.
 */
export const GET = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardContentRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId, conversationId } = await params;
    const { conversation, messages, turns, ai, generations, proposals } = getConversationDetail(
      getDatabase(),
      projectId,
      conversationId,
    );
    return jsonResponse({ conversation, messages, turns, ai, generations, proposals });
  } catch (error) {
    return handleRouteError(error);
  }
};

/** Changes the title, runtime, model or language. A stale settings revision is rejected. */
export const PATCH = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(
    request,
    updateProjectConversationRequestSchema,
  );
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, conversationId } = await params;
    const conversation = updateProjectConversation(getDatabase(), projectId, conversationId, data);
    return jsonResponse({ conversation });
  } catch (error) {
    return handleRouteError(error);
  }
};
