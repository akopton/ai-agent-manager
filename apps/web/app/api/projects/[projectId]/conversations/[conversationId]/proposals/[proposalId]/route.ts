import {
  guardContentRead,
  handleRouteError,
  jsonResponse,
  parseMutationRequest,
} from '@/lib/server/api';
import { updateTaskProposalRequestSchema } from '@/lib/conversations/contracts';
import { getDatabase } from '@/lib/server/database';
import { getProjectTaskProposal, updateProjectTaskProposal } from '@/lib/server/task-proposals';

type RouteContext = {
  params: Promise<{ projectId: string; conversationId: string; proposalId: string }>;
};

export const GET = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const rejected = guardContentRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    const { projectId, conversationId, proposalId } = await params;
    const proposal = getProjectTaskProposal(getDatabase(), projectId, conversationId, proposalId);
    return jsonResponse({ proposal });
  } catch (error) {
    return handleRouteError(error);
  }
};

/** Edits a draft (`revision` + changed fields). Approved and rejected proposals are refused. */
export const PATCH = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, updateTaskProposalRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, conversationId, proposalId } = await params;
    const proposal = await updateProjectTaskProposal(
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
