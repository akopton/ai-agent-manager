import {
  conversationLanguageModeLabels,
  type AgentRuntime,
  type ConversationMessage,
} from '@ai-agent-manager/core';
import type { ConversationAiStatus, ConversationTurnView } from '@/lib/conversations/contracts';
import { describeModelChoice } from '@/lib/models/model-selection';

// Pure presentation model of a conversation transcript: notes, sent messages with the state of
// their latest reply request, and replies with the runtime and model that produced them. Kept free
// of React so every state can be tested directly.

const runtimeNames: Readonly<Record<AgentRuntime, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export type TurnTone = 'pending' | 'running' | 'stopping' | 'failed' | 'stopped' | 'interrupted';

export type TurnState = {
  tone: TurnTone;
  title: string;
  description: string | null;
  canStop: boolean;
  canRetry: boolean;
};

export type TranscriptEntry =
  | { kind: 'note'; message: ConversationMessage }
  | {
      kind: 'sent';
      message: ConversationMessage;
      /** The latest reply request for this message. */
      turn: ConversationTurnView | null;
      /** `null` once answered. */
      state: TurnState | null;
      attempts: number;
    }
  | {
      kind: 'reply';
      message: ConversationMessage;
      turn: ConversationTurnView | null;
      meta: string;
    };

/** Describes what the operator sees for a reply request that is not (yet) answered. */
export const describeTurnState = (
  turn: ConversationTurnView,
  { retryable, aiEnabled }: { retryable: boolean; aiEnabled: boolean },
): TurnState | null => {
  const name = runtimeNames[turn.agentRuntime];
  const canRetry = retryable && aiEnabled;
  switch (turn.status) {
    case 'completed':
      return null;
    case 'queued':
      return {
        tone: 'pending',
        title: 'Waiting for the worker…',
        description: `The message is saved. The worker sends it to ${name} when it is running.`,
        canStop: true,
        canRetry: false,
      };
    case 'running':
      return {
        tone: 'running',
        title: turn.startedAt === null ? `Starting ${name}…` : `${name} is writing a reply…`,
        description: null,
        canStop: true,
        canRetry: false,
      };
    case 'stopping':
      return {
        tone: 'stopping',
        title: 'Stopping…',
        description: `Terminating the ${name} process group. No reply will be stored.`,
        canStop: false,
        canRetry: false,
      };
    case 'cancelled':
      return {
        tone: 'stopped',
        title: 'Stopped',
        description: turn.errorMessage ?? 'No reply was stored.',
        canStop: false,
        canRetry,
      };
    case 'interrupted':
      return {
        tone: 'interrupted',
        title: 'Interrupted',
        description: turn.errorMessage ?? 'The worker stopped before a reply was stored.',
        canStop: false,
        canRetry,
      };
    case 'failed':
      return {
        tone: 'failed',
        title: 'No reply',
        description: turn.errorMessage ?? `${name} failed. No reply was stored.`,
        canStop: false,
        canRetry,
      };
  }
};

/** "Claude Code · Opus (latest) (opus) → claude-opus-5-5 · Polish" for a reply. */
export const describeReplyMeta = (turn: ConversationTurnView): string => {
  const requested = describeModelChoice(turn.agentRuntime, turn.requestedModelId);
  const reported =
    turn.effectiveModelId === null || turn.effectiveModelId === turn.requestedModelId
      ? ''
      : ` → ${turn.effectiveModelId}`;
  return [
    runtimeNames[turn.agentRuntime],
    `${requested}${reported}`,
    conversationLanguageModeLabels[turn.languageMode],
  ].join(' · ');
};

/** Builds the transcript in history order. */
export const buildTranscript = (
  messages: readonly ConversationMessage[],
  turns: readonly ConversationTurnView[],
  ai: ConversationAiStatus,
): TranscriptEntry[] => {
  const latestTurn = turns.at(-1);
  const lastMessage = messages.at(-1);
  const byUserMessage = new Map<string, ConversationTurnView[]>();
  const byReply = new Map<string, ConversationTurnView>();
  for (const turn of turns) {
    byUserMessage.set(turn.userMessageId, [...(byUserMessage.get(turn.userMessageId) ?? []), turn]);
    if (turn.assistantMessageId !== null) byReply.set(turn.assistantMessageId, turn);
  }
  return messages.map((message): TranscriptEntry => {
    if (message.kind === 'note') {
      return { kind: 'note', message };
    }
    if (message.role === 'assistant') {
      const turn = byReply.get(message.id) ?? null;
      return {
        kind: 'reply',
        message,
        turn,
        meta: turn === null ? 'AI reply' : describeReplyMeta(turn),
      };
    }
    const attempts = byUserMessage.get(message.id) ?? [];
    const turn = attempts.at(-1) ?? null;
    const retryable = turn !== null && turn.id === latestTurn?.id && lastMessage?.id === message.id;
    return {
      kind: 'sent',
      message,
      turn,
      state: turn === null ? null : describeTurnState(turn, { retryable, aiEnabled: ai.enabled }),
      attempts: attempts.length,
    };
  });
};

/** Whether any reply request is still pending or running (the page then refreshes itself). */
export const hasActiveTurn = (turns: readonly ConversationTurnView[]): boolean =>
  turns.some((turn) => turn.active);
