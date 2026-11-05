import { projectTrustRequestSchema } from '@/lib/execution/contracts';
import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { setProjectTrust } from '@/lib/server/execution';

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * Grants (`trusted_local`, with the confirmed repository identity) or revokes (`none`) Trusted
 * Local execution for the project. The repository is only inspected read-only.
 */
export const PUT = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, projectTrustRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const { projectId } = await params;
    return jsonResponse({ trust: await setProjectTrust(getDatabase(), projectId, data) });
  } catch (error) {
    return handleRouteError(error);
  }
};
