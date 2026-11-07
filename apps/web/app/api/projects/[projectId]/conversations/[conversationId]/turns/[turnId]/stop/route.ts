import { guardMutation, handleRouteError, jsonResponse } from '@/lib/server/api';
import { stopProjectConversationTurn } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';

type RouteContext = {
  params: Promise<{ projectId: string; conversationId: string; turnId: string }>;
};

/**
 * Stops a pending or running reply. A queued turn is cancelled at once; for a running turn the
 * worker terminates the CLI's process group. Idempotent while the turn is stopping.
 */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardMutation(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId, conversationId, turnId } = await params;
    const turn = stopProjectConversationTurn(getDatabase(), projectId, conversationId, turnId);
    return jsonResponse({ turn });
  } catch (error) {
    return handleRouteError(error);
  }
};
