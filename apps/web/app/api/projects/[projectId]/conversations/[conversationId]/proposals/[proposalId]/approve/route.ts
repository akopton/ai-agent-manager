import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { taskProposalActionRequestSchema } from '@/lib/conversations/contracts';
import { getDatabase } from '@/lib/server/database';
import { approveProjectTaskProposal } from '@/lib/server/task-proposals';

type RouteContext = {
  params: Promise<{ projectId: string; conversationId: string; proposalId: string }>;
};

/**
 * Approve to Backlog: the only way a proposal becomes a task, and only through this explicit
 * operator request. Creates exactly one task in the proposal's project, in `Backlog` (201). A
 * repeat returns the same task (200). Never queues or starts the task and never creates a
 * worktree or runs a Git mutation.
 */
export const POST = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, taskProposalActionRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId, conversationId, proposalId } = await params;
    const result = await approveProjectTaskProposal(
      getDatabase(),
      projectId,
      conversationId,
      proposalId,
      data,
    );
    return jsonResponse(result, result.created ? 201 : 200);
  } catch (error) {
    return handleRouteError(error);
  }
};
