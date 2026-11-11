import { handleRouteError, jsonResponse, parseMutationRequest } from '@/lib/server/api';
import {
  updateConversationNoteRequestSchema,
  deleteConversationNoteRequestSchema,
} from '@/lib/conversations/contracts';
import {
  updateProjectConversationNote,
  deleteProjectConversationNote,
} from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';

type RouteContext = {
  params: Promise<{ projectId: string; conversationId: string; noteId: string }>;
};

export const PATCH = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(
    request,
    updateConversationNoteRequestSchema,
  );
  if (response !== undefined) return response;
  try {
    const { projectId, conversationId, noteId } = await params;
    return jsonResponse({
      message: updateProjectConversationNote(
        getDatabase(),
        projectId,
        conversationId,
        noteId,
        data,
      ),
    });
  } catch (error) {
    return handleRouteError(error);
  }
};

export const DELETE = async (request: Request, { params }: RouteContext): Promise<Response> => {
  const { data, response } = await parseMutationRequest(
    request,
    deleteConversationNoteRequestSchema,
  );
  if (response !== undefined) return response;
  try {
    const { projectId, conversationId, noteId } = await params;
    deleteProjectConversationNote(getDatabase(), projectId, conversationId, noteId, data);
    return jsonResponse({ deleted: true });
  } catch (error) {
    return handleRouteError(error);
  }
};
