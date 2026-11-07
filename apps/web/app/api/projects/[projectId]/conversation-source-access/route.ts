import { projectSourceAccessRequestSchema } from '@/lib/conversations/contracts';
import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { updateProjectSourceAccess } from '@/lib/server/project-source-access';

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * Allows (`allowed`, with the confirmed repository identity and disclosure version) or withdraws
 * (`none`) sharing this project's committed source with Project-Aware conversations (C4). The
 * repository is only inspected read-only. Separate from AI Conversations consent and from Trusted
 * Local execution trust.
 */
export const PUT = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, projectSourceAccessRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId } = await params;
    return jsonResponse({
      sourceAccess: await updateProjectSourceAccess(getDatabase(), projectId, data),
    });
  } catch (error) {
    return handleRouteError(error);
  }
};
