import { guardRead, handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { getDatabase } from '@/lib/server/database';
import { trustedLocalSettingsRequestSchema } from '@/lib/execution/contracts';
import {
  disableTrustedLocalMode,
  enableTrustedLocal,
  getExecutionSettings,
} from '@/lib/server/execution';

/** The current Trusted Local disclosure and the operator's recorded acceptance. */
export const GET = (request: Request): Response => {
  const rejected = guardRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    return jsonResponse({ settings: getExecutionSettings(getDatabase()) });
  } catch (error) {
    return handleRouteError(error);
  }
};

/**
 * Enables Trusted Local Mode with an explicit acceptance of the current disclosure version and
 * every listed risk, or disables it (which clears the acceptance). Runs nothing.
 */
export const PUT = async (request: Request): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, trustedLocalSettingsRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const db = getDatabase();
    const settings = data.enabled
      ? enableTrustedLocal(db, {
          disclosureVersion: data.disclosureVersion,
          acceptedRisks: data.acceptedRisks,
        })
      : disableTrustedLocalMode(db);
    return jsonResponse({ settings });
  } catch (error) {
    return handleRouteError(error);
  }
};
