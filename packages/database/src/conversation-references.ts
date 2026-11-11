import {
  ConversationError,
  conversationReferenceSnapshotsSchema,
  type ConversationReferenceSnapshot,
} from '@ai-agent-manager/core';
import { and, eq } from 'drizzle-orm';
import type { Transaction } from './conversations.js';
import { conversationMessages, conversationTurns } from './schema.js';

/** Resolve within the already scoped transaction; callers never supply quotation text. */
export const resolveConversationReferences = (
  tx: Transaction,
  conversationId: string,
  sourceIds: readonly string[],
): ConversationReferenceSnapshot[] => {
  const snapshots = sourceIds.map((sourceId) => {
    const source = tx
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, sourceId),
          eq(conversationMessages.conversationId, conversationId),
        ),
      )
      .get();
    if (source === undefined || source.deletedAt !== null) {
      throw new ConversationError(
        'invalid_conversation_input',
        'A referenced message or note is unavailable in this conversation. Remove it and select a source from this conversation.',
      );
    }
    if (
      source.role === 'assistant' &&
      (source.kind !== 'chat' ||
        tx
          .select({ id: conversationTurns.id })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.conversationId, conversationId),
              eq(conversationTurns.assistantMessageId, source.id),
              eq(conversationTurns.status, 'completed'),
            ),
          )
          .get() === undefined)
    ) {
      throw new ConversationError(
        'invalid_conversation_input',
        'Only user messages, saved notes and completed AI replies can be referenced. Remove this reference.',
      );
    }
    return {
      sourceId,
      kind: source.kind,
      role: source.role,
      sequence: source.sequence,
      content: source.content,
    };
  });
  const parsed = conversationReferenceSnapshotsSchema.safeParse(snapshots);
  if (!parsed.success) {
    throw new ConversationError(
      'invalid_conversation_input',
      'References must contain at most 20,000 characters each and 30,000 characters together. Remove a reference or send a smaller quotation in your message.',
    );
  }
  return parsed.data;
};
