import type { ConversationMessage } from '@ai-agent-manager/core';
import { formatTimestamp } from '@/lib/projects/format';

export const ConversationNotes = ({ messages }: { messages: readonly ConversationMessage[] }) => {
  const notes = messages.filter((message) => message.kind === 'note');
  return (
    <section aria-label="Conversation notes" className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Notes stay in AI Agent Manager. They are never sent to Claude Code or Codex.
      </p>
      {notes.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          No notes yet. Save an idea or reminder below.
        </p>
      ) : (
        <ol aria-label="Saved notes" className="space-y-3">
          {notes.map((note) => (
            <li key={note.id}>
              <article className="rounded-xl border border-dashed bg-inset/60 px-4 py-3">
                <header className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                  <span>Note · Not sent to an AI</span>
                  <time dateTime={new Date(note.createdAt).toISOString()}>
                    {formatTimestamp(note.createdAt)}
                  </time>
                </header>
                <p className="text-sm leading-6 break-words whitespace-pre-wrap">{note.content}</p>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
