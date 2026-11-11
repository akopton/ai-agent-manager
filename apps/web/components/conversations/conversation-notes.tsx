'use client';

import { useRef, useState } from 'react';
import type { ConversationMessage } from '@ai-agent-manager/core';
import { ConversationNoteCard } from '@/components/conversations/conversation-note-card';

export const ConversationNotes = ({
  messages,
  projectId,
}: {
  messages: readonly ConversationMessage[];
  projectId: string;
}) => {
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(new Set());
  const section = useRef<HTMLElement>(null);
  const notes = messages.filter(
    (message) => message.kind === 'note' && !deletedIds.has(message.id),
  );
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label="Conversation notes"
      className="space-y-4 outline-none"
    >
      <p className="text-sm text-muted-foreground">
        Notes stay in AI Agent Manager. They are sent only when you explicitly reference them in a
        new chat message.
      </p>
      {notes.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          No notes yet. Save an idea or reminder below.
        </p>
      ) : (
        <ol aria-label="Saved notes" className="space-y-3">
          {notes.map((note) => (
            <li key={note.id} id={`note-${note.id}`}>
              <ConversationNoteCard
                projectId={projectId}
                note={note}
                onDeleted={() => {
                  setDeletedIds((current) => new Set([...current, note.id]));
                  requestAnimationFrame(() => section.current?.focus({ preventScroll: true }));
                }}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
