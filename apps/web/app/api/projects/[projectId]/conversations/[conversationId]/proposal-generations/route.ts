import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { requestTaskProposalsRequestSchema } from '@/lib/conversations/contracts';
import { getDatabase } from '@/lib/server/database';
import { requestProjectTaskProposals } from '@/lib/server/task-proposals';

type RouteContext = { params: Promise<{ projectId: string; conversationId: string }> };

/**
 * The operator's explicit request for task proposals (C3). Stores a queued generation and returns
 * at once (202); the worker runs the CLI and stores validated drafts. Starts no process here and
 * never creates a task. Repeating a request with the same `requestId` returns it (200).
 */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, requestTaskProposalsRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, conversationId } = await params;
    const result = requestProjectTaskProposals(getDatabase(), projectId, conversationId, data);
    return jsonResponse(result, result.created ? 202 : 200);
  } catch (error) {
    return handleRouteError(error);
  }
};
