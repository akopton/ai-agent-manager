import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { taskProposalActionRequestSchema } from '@/lib/conversations/contracts';
import { getDatabase } from '@/lib/server/database';
import { rejectProjectTaskProposal } from '@/lib/server/task-proposals';

type RouteContext = {
  params: Promise<{ projectId: string; conversationId: string; proposalId: string }>;
};

/** Rejects a draft. Repeating it is harmless; an approved proposal cannot be rejected. */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, taskProposalActionRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, conversationId, proposalId } = await params;
    const proposal = rejectProjectTaskProposal(
      getDatabase(),
      projectId,
      conversationId,
      proposalId,
      data,
    );
    return jsonResponse({ proposal });
  } catch (error) {
    return handleRouteError(error);
  }
};
