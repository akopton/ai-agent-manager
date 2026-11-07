import { guardRead, handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import { conversationSettingsRequestSchema } from '@/lib/conversations/contracts';
import {
  disableConversationAiReplies,
  enableConversationAi,
  getConversationSettings,
} from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';

/** The AI Conversations disclosure and the operator's recorded acceptance. */
export const GET = (request: Request): Response => {
  const rejected = guardRead(request);
  if (rejected !== undefined) {
    return rejected;
  }
  try {
    return jsonResponse({ settings: getConversationSettings(getDatabase()) });
  } catch (error) {
    return handleRouteError(error);
  }
};

/**
 * Enables AI replies with an explicit acceptance of the current AI Conversations disclosure, or
 * turns them off. Separate from Trusted Local execution; runs nothing.
 */
export const PUT = async (request: Request): Promise<Response> => {
  const { data, response } = await parseMutationRequest(request, conversationSettingsRequestSchema);
  if (response !== undefined) {
    return response;
  }
  try {
    const db = getDatabase();
    const settings = data.enabled
      ? enableConversationAi(db, data.disclosureVersion)
      : disableConversationAiReplies(db);
    return jsonResponse({ settings });
  } catch (error) {
    return handleRouteError(error);
  }
};
