import {
  ConversationError,
  conversationMessageIdSchema,
  conversationNoteRevisionInputSchema,
  updateConversationNoteInputSchema,
  type ConversationNoteRevisionInput,
  type UpdateConversationNoteInput,
} from '@ai-agent-manager/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { DatabaseConnection } from './client.js';
import {
  findScoped,
  parseScope,
  type ConversationMessageRecord,
  type Scope,
} from './conversations.js';
import { conversationMessages, conversations } from './schema.js';

type Database = DatabaseConnection['db'];
type NoteCommand = { scope: Scope; noteId: string; now: number };

/** Only user notes may change. Tombstones reserve sequence/identity without retaining current text. */
const mutateNote = (
  db: Database,
  { scope, noteId, now }: NoteCommand,
  input: unknown,
  deleting: boolean,
): ConversationMessageRecord => {
  const ids = parseScope(scope);
  const parsedId = conversationMessageIdSchema.safeParse(noteId);
  const parsed = (
    deleting
      ? conversationNoteRevisionInputSchema.transform((value) => ({ ...value, content: '' }))
      : updateConversationNoteInputSchema
  ).safeParse(input);
  if (!parsed.success)
    throw new ConversationError(
      'invalid_conversation_input',
      parsed.error.issues[0]?.message ?? 'The note input is invalid.',
    );
  return db.transaction(
    (tx) => {
      if (findScoped(tx, ids) === undefined)
        throw new ConversationError('conversation_not_found', 'The conversation does not exist.');
      const note = parsedId.success
        ? tx
            .select()
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.id, parsedId.data),
                eq(conversationMessages.conversationId, ids.conversationId),
                eq(conversationMessages.kind, 'note'),
                eq(conversationMessages.role, 'user'),
              ),
            )
            .get()
        : undefined;
      if (!note || (!deleting && note.deletedAt !== null))
        throw new ConversationError(
          'conversation_note_not_found',
          'This note is unavailable or was deleted. Cancel this edit and refresh Notes.',
        );
      // A repeated confirmed deletion is harmless, even with the original revision.
      if (deleting && note.deletedAt !== null) return note;
      if (note.revision !== parsed.data.revision)
        throw new ConversationError(
          'conversation_note_changed',
          'This note changed in the meantime. Cancel and reopen the editor or deletion confirmation to review the latest version.',
        );
      const updated = tx
        .update(conversationMessages)
        .set({
          content: parsed.data.content,
          revision: note.revision + 1,
          updatedAt: now,
          deletedAt: deleting ? now : null,
        })
        .where(
          and(
            eq(conversationMessages.id, note.id),
            eq(conversationMessages.revision, note.revision),
            isNull(conversationMessages.deletedAt),
          ),
        )
        .returning()
        .get();
      if (!updated)
        throw new ConversationError(
          'conversation_note_changed',
          'This note changed. Refresh Notes and try again.',
        );
      tx.update(conversations)
        .set({ updatedAt: now })
        .where(eq(conversations.id, ids.conversationId))
        .run();
      return updated;
    },
    { behavior: 'immediate' },
  );
};

export const updateConversationNote = (
  db: Database,
  command: NoteCommand & { input: UpdateConversationNoteInput },
): ConversationMessageRecord => mutateNote(db, command, command.input, false);

export const deleteConversationNote = (
  db: Database,
  command: NoteCommand & { input: ConversationNoteRevisionInput },
): void => {
  mutateNote(db, command, command.input, true);
};
