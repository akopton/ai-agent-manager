import { AlertCircle, Bot, Loader2, MessagesSquare, OctagonX } from 'lucide-react';
import type { ConversationMessage } from '@ai-agent-manager/core';

import { MarkdownContent } from '@/components/conversations/markdown-content';
import { ReplySources } from '@/components/conversations/reply-sources';
import { ReplyTaskActions } from '@/components/conversations/reply-task-actions';
import { TurnActions } from '@/components/conversations/turn-actions';
import type {
  ConversationAiStatus,
  ConversationTurnView,
  TaskProposalGenerationView,
} from '@/lib/conversations/contracts';
import {
  hasActiveGeneration,
  latestGenerationBySource,
  messageAnchor,
  replyGenerationBlockedReason,
} from '@/lib/conversations/proposals';
import { buildTranscript, hasActiveTurn, type TurnState } from '@/lib/conversations/transcript';
import { formatTimestamp } from '@/lib/projects/format';
import { cn } from '@/lib/utils';

type ConversationHistoryProps = {
  projectId: string;
  conversationId: string;
  messages: readonly ConversationMessage[];
  turns: readonly ConversationTurnView[];
  ai: ConversationAiStatus;
  /** C3.1: proposal requests, shown under the AI reply they were made from. */
  generations?: readonly TaskProposalGenerationView[];
};

const Timestamp = ({ value }: { value: number }) => (
  <time dateTime={new Date(value).toISOString()} className="text-muted-foreground tabular-nums">
    {formatTimestamp(value)}
  </time>
);

const toneClasses: Record<TurnState['tone'], string> = {
  pending: 'text-muted-foreground',
  running: 'text-info',
  stopping: 'text-warning',
  failed: 'text-destructive',
  stopped: 'text-muted-foreground',
  interrupted: 'text-warning',
};

const TurnStatus = ({
  state,
  projectId,
  conversationId,
  turnId,
}: {
  state: TurnState;
  projectId: string;
  conversationId: string;
  turnId: string;
}) => (
  <div
    role="status"
    aria-live="polite"
    className="flex max-w-[85%] flex-col gap-2 rounded-xl border border-dashed px-4 py-3 text-sm"
  >
    <p className={cn('flex items-center gap-2 font-medium', toneClasses[state.tone])}>
      {state.tone === 'pending' || state.tone === 'running' || state.tone === 'stopping' ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : state.tone === 'failed' ? (
        <AlertCircle className="size-4" aria-hidden="true" />
      ) : (
        <OctagonX className="size-4" aria-hidden="true" />
      )}
      {state.title}
    </p>
    {state.description === null ? null : (
      <p className="text-xs leading-5 break-words text-muted-foreground">{state.description}</p>
    )}
    <TurnActions
      projectId={projectId}
      conversationId={conversationId}
      turnId={turnId}
      canStop={state.canStop}
      canRetry={state.canRetry}
    />
  </div>
);

/** Chat only; keep the full history when computing turn eligibility. Notes live in Notes. */
export const ConversationHistory = ({
  projectId,
  conversationId,
  messages,
  turns,
  ai,
  generations = [],
}: ConversationHistoryProps) => {
  const bySource = latestGenerationBySource(generations);
  const blockedReason = replyGenerationBlockedReason({
    aiEnabled: ai.enabled,
    turnActive: hasActiveTurn(turns),
    generating: hasActiveGeneration(generations),
  });
  if (!messages.some((message) => message.kind === 'chat')) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
          <MessagesSquare className="size-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <h2 className="text-base font-semibold">No messages yet</h2>
        <p className="max-w-md text-sm leading-6 text-muted-foreground">
          Ask the AI to help plan this topic, or save a note for yourself. Notes are never sent to
          Claude Code or Codex.
        </p>
      </div>
    );
  }

  return (
    <ol aria-label="Conversation history" className="space-y-4">
      {buildTranscript(messages, turns, ai).map((entry) => {
        const { message } = entry;
        if (entry.kind === 'note') return null;
        if (entry.kind === 'reply') {
          // C3.1: only replies stored by a completed turn can be a task source.
          const eligible = entry.turn?.status === 'completed' && message.kind === 'chat';
          return (
            <li
              key={message.id}
              id={messageAnchor(message.id)}
              className="flex scroll-mt-20 flex-col items-start gap-1 rounded-2xl target:ring-2 target:ring-primary/40 target:ring-offset-4 target:ring-offset-background"
            >
              <article
                aria-label={`AI reply, ${formatTimestamp(message.createdAt)}`}
                className="max-w-[92%] min-w-0 rounded-2xl rounded-tl-sm border bg-card px-4 py-3"
              >
                <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                  <Bot className="size-3.5 self-center text-primary" aria-hidden="true" />
                  <span className="font-semibold text-foreground">AI reply</span>
                  <span className="break-all text-muted-foreground">{entry.meta}</span>
                  <span className="ml-auto">
                    <Timestamp value={message.createdAt} />
                  </span>
                </header>
                <MarkdownContent source={message.content} />
                {entry.turn?.replyTruncated ? (
                  <p className="mt-2 text-xs text-warning">
                    The reply was longer than the storage limit and was shortened.
                  </p>
                ) : null}
              </article>
              {entry.turn?.contextMode === 'project_aware' && entry.turn.repository !== null ? (
                <ReplySources record={entry.turn.repository} />
              ) : null}
              {eligible ? (
                <ReplyTaskActions
                  projectId={projectId}
                  conversationId={conversationId}
                  messageId={message.id}
                  generation={bySource.get(message.id) ?? null}
                  aiEnabled={ai.enabled}
                  blockedReason={blockedReason}
                />
              ) : null}
            </li>
          );
        }
        return (
          <li key={message.id} className="flex flex-col items-end gap-2">
            <article
              aria-label={`Your message, ${formatTimestamp(message.createdAt)}`}
              className="max-w-[85%] min-w-0 rounded-2xl rounded-tr-sm border bg-inset px-4 py-3"
            >
              <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <span className="font-semibold text-foreground">You</span>
                <span className="text-muted-foreground">
                  Sent to AI
                  {entry.attempts > 1 ? ` · ${entry.attempts} attempts` : ''}
                </span>
                <span className="ml-auto">
                  <Timestamp value={message.createdAt} />
                </span>
              </header>
              <p className="text-sm leading-6 break-words whitespace-pre-wrap">{message.content}</p>
            </article>
            {entry.state !== null && entry.turn !== null ? (
              <TurnStatus
                state={entry.state}
                projectId={projectId}
                conversationId={conversationId}
                turnId={entry.turn.id}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};
