import { MessagesSquare } from 'lucide-react';
import type { ConversationMessage } from '@ai-agent-manager/core';

import { describeMessageAuthor } from '@/lib/conversations/format';
import { formatTimestamp } from '@/lib/projects/format';
import { cn } from '@/lib/utils';

/** The stored history in its saved order, or an empty state that explains what C1 does. */
export const ConversationHistory = ({ messages }: { messages: readonly ConversationMessage[] }) => {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
          <MessagesSquare className="size-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <h2 className="text-base font-semibold">No notes yet</h2>
        <p className="max-w-md text-sm leading-6 text-muted-foreground">
          Collect questions, ideas and context for this topic below. AI replies will be enabled in
          C2; until then nothing you write here is sent to Claude Code or Codex.
        </p>
      </div>
    );
  }

  return (
    <ol aria-label="Conversation history" className="space-y-3">
      {messages.map((message) => {
        const { author, detail } = describeMessageAuthor(message);
        return (
          <li key={message.id}>
            <article
              aria-label={`${author}, ${formatTimestamp(message.createdAt)}`}
              className={cn(
                'rounded-xl border px-4 py-3',
                message.role === 'assistant' ? 'bg-card' : 'bg-inset',
              )}
            >
              <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <span className="font-semibold text-foreground">{author}</span>
                <span className="text-muted-foreground">{detail}</span>
                <time
                  dateTime={new Date(message.createdAt).toISOString()}
                  className="ml-auto text-muted-foreground tabular-nums"
                >
                  {formatTimestamp(message.createdAt)}
                </time>
              </header>
              <p className="text-sm leading-6 break-words whitespace-pre-wrap">{message.content}</p>
            </article>
          </li>
        );
      })}
    </ol>
  );
};
