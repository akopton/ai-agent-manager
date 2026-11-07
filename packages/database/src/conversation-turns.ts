import {
  acceptConversationDisclosureInputSchema,
  activeConversationTurnStatuses,
  conversationDisclosure,
  conversationMessageIdSchema,
  ConversationError,
  conversationReplyMaxLength,
  evaluateConversationConsent,
  retryableConversationTurnStatuses,
  retryConversationTurnInputSchema,
  sendConversationMessageInputSchema,
  truncateText,
  type AgentRuntime,
  type ConversationConsent,
  type ConversationHistoryEntry,
  type ConversationTurnStatus,
  type RetryConversationTurnInput,
  type SendConversationMessageInput,
} from '@ai-agent-manager/core';
import { and, asc, desc, eq, inArray, isNotNull, lt, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseConnection } from './client.js';
import {
  activeTurnError,
  appendMessage,
  findScoped,
  hasActiveTurn,
  parseScope,
  type ConversationMessageRecord,
  type ConversationRecord,
  type Scope,
  type Transaction,
} from './conversations.js';
import {
  conversationMessages,
  conversations,
  conversationSettings,
  conversationTurns,
} from './schema.js';

// C2 — CLI-backed conversation turns. The web process records a user `chat` message and a
// `queued` turn in one IMMEDIATE transaction and returns at once; the worker claims the turn,
// runs the CLI and finishes it. Only `finishConversationTurn` with `completed` appends an
// assistant message, so a failed, stopped or interrupted CLI never produces a reply. Nothing here
// launches a process, touches a task, a worker command, a worktree or Git.

type Database = DatabaseConnection['db'];

export type ConversationTurnRecord = typeof conversationTurns.$inferSelect;

const immediate = { behavior: 'immediate' } as const;
const activeStatuses = [...activeConversationTurnStatuses];

const invalidInput = (error: z.ZodError): ConversationError =>
  new ConversationError(
    'invalid_conversation_input',
    error.issues[0]?.message ?? 'The input is invalid.',
    { issues: error.issues.map(({ path, message }) => ({ path: path.join('.'), message })) },
  );

const conversationNotFound = (): ConversationError =>
  new ConversationError('conversation_not_found', 'The conversation does not exist.');

const turnNotFound = (): ConversationError =>
  new ConversationError('conversation_turn_not_found', 'The reply request does not exist.');

// ---------------------------------------------------------------------------------------------
// Consent (separate from Trusted Local execution consent)
// ---------------------------------------------------------------------------------------------

/** The operator's AI Conversations consent; off when no row exists. */
export const getConversationConsent = (db: Database | Transaction): ConversationConsent => {
  const row = db.select().from(conversationSettings).where(eq(conversationSettings.id, 1)).get();
  return {
    enabled: row?.enabled ?? false,
    disclosureVersion: row?.disclosureVersion ?? null,
    acceptedAt: row?.acceptedAt ?? null,
  };
};

/** Records the explicit acceptance of the current AI Conversations disclosure. */
export const acceptConversationDisclosure = (
  db: Database,
  { input, now }: { input: unknown; now: number },
): ConversationConsent => {
  const parsed = acceptConversationDisclosureInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  if (parsed.data.disclosureVersion !== conversationDisclosure.version) {
    throw new ConversationError(
      'conversation_ai_stale',
      'The disclosure you accepted is not the current one. Reload the page and read it again.',
    );
  }
  db.insert(conversationSettings)
    .values({
      id: 1,
      enabled: true,
      disclosureVersion: conversationDisclosure.version,
      acceptedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: conversationSettings.id,
      set: {
        enabled: true,
        disclosureVersion: conversationDisclosure.version,
        acceptedAt: now,
        updatedAt: now,
      },
    })
    .run();
  return getConversationConsent(db);
};

/**
 * Turns AI replies off and clears the acceptance. Queued turns are failed by the worker's next
 * claim; a running turn is not stopped automatically (Stop does that).
 */
export const disableConversationAi = (
  db: Database,
  { now }: { now: number },
): ConversationConsent => {
  db.insert(conversationSettings)
    .values({ id: 1, enabled: false, disclosureVersion: null, acceptedAt: null, updatedAt: now })
    .onConflictDoUpdate({
      target: conversationSettings.id,
      set: { enabled: false, disclosureVersion: null, acceptedAt: null, updatedAt: now },
    })
    .run();
  return getConversationConsent(db);
};

const requireConsent = (tx: Transaction): void => {
  const decision = evaluateConversationConsent(getConversationConsent(tx));
  if (!decision.ok) {
    throw new ConversationError(decision.code, decision.message);
  }
};

// ---------------------------------------------------------------------------------------------
// Web commands
// ---------------------------------------------------------------------------------------------

const insertTurn = (
  tx: Transaction,
  conversation: ConversationRecord,
  values: {
    id: string;
    userMessageId: string;
    requestId: string;
    retryOfTurnId: string | null;
    now: number;
  },
): ConversationTurnRecord =>
  tx
    .insert(conversationTurns)
    .values({
      id: values.id,
      conversationId: conversation.id,
      userMessageId: values.userMessageId,
      retryOfTurnId: values.retryOfTurnId,
      requestId: values.requestId,
      status: 'queued',
      // Snapshot: later settings changes apply to later turns only.
      agentRuntime: conversation.agentRuntime,
      requestedModelId: conversation.modelId,
      languageMode: conversation.languageMode,
      createdAt: values.now,
      updatedAt: values.now,
    })
    .returning()
    .get();

export type SendConversationMessageResult = {
  message: ConversationMessageRecord;
  turn: ConversationTurnRecord;
  /** `false` when the same request was already stored and the stored message and turn return. */
  created: boolean;
};

const uuid = z.uuid();

/**
 * Stores a user `chat` message and a `queued` turn that asks the worker for an AI reply. Returns
 * immediately; no process is started here. Refused while AI replies are off, while another turn of
 * this conversation is active, and for a request ID used for something else. A repeated request
 * with the same ID and content returns the stored message and turn (`created: false`).
 */
export const sendConversationMessage = (
  db: Database,
  {
    scope,
    messageId,
    turnId,
    input,
    now,
  }: {
    scope: Scope;
    messageId: string;
    turnId: string;
    input: SendConversationMessageInput;
    now: number;
  },
): SendConversationMessageResult => {
  const ids = parseScope(scope);
  const parsedMessageId = conversationMessageIdSchema.safeParse(messageId);
  const parsedTurnId = uuid.safeParse(turnId);
  if (!parsedMessageId.success || !parsedTurnId.success) {
    throw new ConversationError('invalid_conversation_input', 'Invalid identifiers.');
  }
  const parsed = sendConversationMessageInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  const { requestId, content } = parsed.data;

  return db.transaction((tx) => {
    const conversation = findScoped(tx, ids);
    if (conversation === undefined) {
      throw conversationNotFound();
    }
    const existing = tx
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.requestId, requestId))
      .get();
    if (existing !== undefined) {
      const turn = tx
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.requestId, requestId))
        .get();
      if (
        existing.conversationId !== conversation.id ||
        existing.kind !== 'chat' ||
        existing.content !== content ||
        turn === undefined
      ) {
        throw new ConversationError(
          'conversation_request_conflict',
          'This request was already used for a different message. Reload the page and try again.',
        );
      }
      return { message: existing, turn, created: false };
    }
    if (
      tx
        .select({ id: conversationTurns.id })
        .from(conversationTurns)
        .where(eq(conversationTurns.requestId, requestId))
        .get() !== undefined
    ) {
      throw new ConversationError(
        'conversation_request_conflict',
        'This request was already used. Reload the page and try again.',
      );
    }
    requireConsent(tx);
    if (hasActiveTurn(tx, conversation.id)) {
      throw activeTurnError();
    }
    const message = appendMessage(tx, conversation, {
      id: parsedMessageId.data,
      role: 'user',
      kind: 'chat',
      content,
      requestId,
      now,
    });
    const turn = insertTurn(tx, conversation, {
      id: parsedTurnId.data,
      userMessageId: message.id,
      requestId,
      retryOfTurnId: null,
      now,
    });
    return { message, turn, created: true };
  }, immediate);
};

const findTurnScoped = (
  tx: Transaction,
  conversation: ConversationRecord,
  turnId: string,
): ConversationTurnRecord => {
  const parsed = uuid.safeParse(turnId);
  const turn = parsed.success
    ? tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, parsed.data),
            eq(conversationTurns.conversationId, conversation.id),
          ),
        )
        .get()
    : undefined;
  if (turn === undefined) {
    throw turnNotFound();
  }
  return turn;
};

/**
 * Asks for a new reply to the message of a failed, stopped or interrupted turn. Only the latest
 * turn can be retried, and only while its message is still the last one in the history, so the
 * reply always directly follows its message. The new turn uses the conversation's **current**
 * runtime, model and language. Never automatic.
 */
export const retryConversationTurn = (
  db: Database,
  {
    scope,
    turnId,
    newTurnId,
    input,
    now,
  }: {
    scope: Scope;
    turnId: string;
    newTurnId: string;
    input: RetryConversationTurnInput;
    now: number;
  },
): { turn: ConversationTurnRecord; created: boolean } => {
  const ids = parseScope(scope);
  const parsed = retryConversationTurnInputSchema.safeParse(input);
  const parsedNewTurnId = uuid.safeParse(newTurnId);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  if (!parsedNewTurnId.success) {
    throw new ConversationError('invalid_conversation_input', 'Invalid identifiers.');
  }
  return db.transaction((tx) => {
    const conversation = findScoped(tx, ids);
    if (conversation === undefined) {
      throw conversationNotFound();
    }
    const source = findTurnScoped(tx, conversation, turnId);
    const repeated = tx
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.requestId, parsed.data.requestId))
      .get();
    if (repeated !== undefined) {
      if (repeated.retryOfTurnId !== source.id) {
        throw new ConversationError(
          'conversation_request_conflict',
          'This request was already used. Reload the page and try again.',
        );
      }
      return { turn: repeated, created: false };
    }
    const latest = tx
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.conversationId, conversation.id))
      .orderBy(desc(conversationTurns.createdAt), desc(conversationTurns.id))
      .get();
    const lastMessage = tx
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversation.id))
      .orderBy(desc(conversationMessages.sequence))
      .get();
    if (
      !(retryableConversationTurnStatuses as readonly ConversationTurnStatus[]).includes(
        source.status,
      ) ||
      latest?.id !== source.id ||
      lastMessage?.id !== source.userMessageId
    ) {
      throw new ConversationError(
        'conversation_turn_not_retryable',
        'Only the latest failed, stopped or interrupted reply can be retried, while its message is still the last one. Send a new message instead.',
      );
    }
    requireConsent(tx);
    if (hasActiveTurn(tx, conversation.id)) {
      throw activeTurnError();
    }
    const turn = insertTurn(tx, conversation, {
      id: parsedNewTurnId.data,
      userMessageId: source.userMessageId,
      requestId: parsed.data.requestId,
      retryOfTurnId: source.id,
      now,
    });
    tx.update(conversations)
      .set({ updatedAt: now })
      .where(eq(conversations.id, conversation.id))
      .run();
    return { turn, created: true };
  }, immediate);
};

/**
 * Records the operator's Stop. A queued turn is cancelled at once (no process was started); a
 * running turn becomes `stopping` and the worker terminates the CLI's process group. Repeating
 * Stop is harmless. Stopping a finished turn is refused with `conversation_turn_not_active`.
 */
export const requestConversationTurnStop = (
  db: Database,
  { scope, turnId, now }: { scope: Scope; turnId: string; now: number },
): ConversationTurnRecord => {
  const ids = parseScope(scope);
  return db.transaction((tx) => {
    const conversation = findScoped(tx, ids);
    if (conversation === undefined) {
      throw conversationNotFound();
    }
    const turn = findTurnScoped(tx, conversation, turnId);
    switch (turn.status) {
      case 'queued':
        return tx
          .update(conversationTurns)
          .set({
            status: 'cancelled',
            stopRequestedAt: now,
            errorMessage: 'Stopped before the CLI was started.',
            endedAt: now,
            updatedAt: now,
          })
          .where(and(eq(conversationTurns.id, turn.id), eq(conversationTurns.status, 'queued')))
          .returning()
          .get();
      case 'running':
        return tx
          .update(conversationTurns)
          .set({ status: 'stopping', stopRequestedAt: now, updatedAt: now })
          .where(and(eq(conversationTurns.id, turn.id), eq(conversationTurns.status, 'running')))
          .returning()
          .get();
      case 'stopping':
      case 'cancelled':
        return turn;
      default:
        throw new ConversationError(
          'conversation_turn_not_active',
          'This reply already finished; there is nothing to stop.',
        );
    }
  }, immediate);
};

/** The conversation's turns, oldest first, or `undefined` for a conversation of another project. */
export const listConversationTurns = (
  db: Database,
  scope: Scope,
): ConversationTurnRecord[] | undefined => {
  let ids: Scope;
  try {
    ids = parseScope(scope);
  } catch {
    return undefined;
  }
  const conversation = findScoped(db, ids);
  if (conversation === undefined) {
    return undefined;
  }
  return db
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.conversationId, conversation.id))
    .orderBy(asc(conversationTurns.createdAt), asc(conversationTurns.id))
    .all();
};

// ---------------------------------------------------------------------------------------------
// Worker commands
// ---------------------------------------------------------------------------------------------

export const findConversationTurn = (
  db: Database,
  turnId: string,
): ConversationTurnRecord | undefined =>
  db.select().from(conversationTurns).where(eq(conversationTurns.id, turnId)).get();

/** What the worker needs to run one claimed turn. */
export type ClaimedConversationTurn = {
  turn: ConversationTurnRecord;
  conversation: ConversationRecord;
  userMessage: ConversationMessageRecord;
  /** Completed earlier exchanges (user message, then its reply), in history order. */
  history: ConversationHistoryEntry[];
  /** Notes before this message; never sent. */
  notesExcluded: number;
};

/** Earlier completed exchanges before `beforeSequence`. Failed, unanswered messages are left out. */
const loadHistory = (
  tx: Transaction,
  conversationId: string,
  beforeSequence: number,
): { history: ConversationHistoryEntry[]; notesExcluded: number } => {
  const completed = tx
    .select({
      userMessageId: conversationTurns.userMessageId,
      assistantMessageId: conversationTurns.assistantMessageId,
    })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.conversationId, conversationId),
        eq(conversationTurns.status, 'completed'),
        isNotNull(conversationTurns.assistantMessageId),
      ),
    )
    .all();
  const included = new Set(
    completed.flatMap(({ userMessageId, assistantMessageId }) =>
      assistantMessageId === null ? [] : [userMessageId, assistantMessageId],
    ),
  );
  const messages = tx
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        lt(conversationMessages.sequence, beforeSequence),
      ),
    )
    .orderBy(asc(conversationMessages.sequence))
    .all();
  return {
    history: messages
      .filter((message) => message.kind === 'chat' && included.has(message.id))
      .map(({ id, sequence, role, content }) => ({ id, sequence, role, content })),
    notesExcluded: messages.filter((message) => message.kind === 'note').length,
  };
};

export type ClaimConversationTurnResult =
  { claimed: true; claim: ClaimedConversationTurn } | { claimed: false };

/**
 * Claims the oldest queued turn whose runtime has a free conversation slot (at most
 * `maxActivePerRuntime` running turns per CLI; separate from task execution slots). Consent is
 * re-read in the same IMMEDIATE transaction: without it, every queued turn fails with an
 * actionable message instead of starting.
 */
export const claimConversationTurn = (
  db: Database,
  {
    workerInstanceId,
    now,
    maxActivePerRuntime = 1,
  }: { workerInstanceId: string; now: number; maxActivePerRuntime?: number },
): ClaimConversationTurnResult =>
  db.transaction((tx) => {
    const queued = tx
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.status, 'queued'))
      .orderBy(asc(conversationTurns.createdAt), asc(conversationTurns.id))
      .all();
    if (queued.length === 0) {
      return { claimed: false };
    }
    const decision = evaluateConversationConsent(getConversationConsent(tx));
    if (!decision.ok) {
      for (const turn of queued) {
        tx.update(conversationTurns)
          .set({
            status: 'failed',
            errorCode: decision.code,
            errorMessage: decision.message,
            endedAt: now,
            updatedAt: now,
          })
          .where(and(eq(conversationTurns.id, turn.id), eq(conversationTurns.status, 'queued')))
          .run();
      }
      return { claimed: false };
    }
    const runningByRuntime = new Map<AgentRuntime, number>(
      tx
        .select({ runtime: conversationTurns.agentRuntime, count: sql<number>`count(*)` })
        .from(conversationTurns)
        .where(inArray(conversationTurns.status, ['running', 'stopping']))
        .groupBy(conversationTurns.agentRuntime)
        .all()
        .map(({ runtime, count }) => [runtime, count]),
    );
    const next = queued.find(
      (turn) => (runningByRuntime.get(turn.agentRuntime) ?? 0) < maxActivePerRuntime,
    );
    if (next === undefined) {
      return { claimed: false };
    }
    const turn = tx
      .update(conversationTurns)
      .set({
        status: 'running',
        workerInstanceId,
        securityMode: 'trusted_local',
        disclosureVersion: conversationDisclosure.version,
        claimedAt: now,
        updatedAt: now,
      })
      .where(and(eq(conversationTurns.id, next.id), eq(conversationTurns.status, 'queued')))
      .returning()
      .get();
    const conversation = tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, next.conversationId))
      .get();
    const userMessage = tx
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, next.userMessageId))
      .get();
    if (turn === undefined || conversation === undefined || userMessage === undefined) {
      throw new Error(`Conversation turn ${next.id} could not be claimed consistently.`);
    }
    const { history, notesExcluded } = loadHistory(tx, conversation.id, userMessage.sequence);
    return { claimed: true, claim: { turn, conversation, userMessage, history, notesExcluded } };
  }, immediate);

export type ConversationTurnProgress = Partial<
  Pick<
    ConversationTurnRecord,
    | 'launchProfileId'
    | 'cliVersion'
    | 'contextManifestJson'
    | 'pid'
    | 'startedAt'
    | 'effectiveModelId'
  >
>;

/** Records launch facts of an active turn. Never changes its status. */
export const updateConversationTurnProgress = (
  db: Database,
  turnId: string,
  progress: ConversationTurnProgress,
  now: number,
): void => {
  db.update(conversationTurns)
    .set({ ...progress, updatedAt: now })
    .where(and(eq(conversationTurns.id, turnId), inArray(conversationTurns.status, activeStatuses)))
    .run();
};

export type ConversationTurnFinish =
  | {
      status: 'completed';
      reply: string;
      effectiveModelId: string | null;
      exitCode: number | null;
      endedAt: number;
    }
  | {
      status: 'failed' | 'cancelled' | 'interrupted';
      errorCode: string | null;
      errorMessage: string | null;
      exitCode: number | null;
      signal: string | null;
      effectiveModelId: string | null;
      endedAt: number;
    };

/**
 * Finishes an active turn exactly once. `completed` appends the assistant message (truncated to
 * `conversationReplyMaxLength`) in the same transaction and links it to the turn. Returns
 * `undefined` when the turn is no longer active (already finished or reconciled), and then writes
 * nothing.
 */
export const finishConversationTurn = (
  db: Database,
  turnId: string,
  finish: ConversationTurnFinish,
  { createMessageId }: { createMessageId: () => string },
): ConversationTurnRecord | undefined =>
  db.transaction((tx) => {
    const turn = tx
      .select()
      .from(conversationTurns)
      .where(
        and(eq(conversationTurns.id, turnId), inArray(conversationTurns.status, activeStatuses)),
      )
      .get();
    if (turn === undefined) {
      return undefined;
    }
    if (finish.status !== 'completed') {
      return tx
        .update(conversationTurns)
        .set({
          status: finish.status,
          errorCode: finish.errorCode,
          errorMessage:
            finish.errorMessage === null ? null : truncateText(finish.errorMessage, 2_000),
          exitCode: finish.exitCode,
          signal: finish.signal,
          effectiveModelId: finish.effectiveModelId ?? turn.effectiveModelId,
          endedAt: finish.endedAt,
          updatedAt: finish.endedAt,
        })
        .where(eq(conversationTurns.id, turn.id))
        .returning()
        .get();
    }
    const conversation = tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, turn.conversationId))
      .get();
    if (conversation === undefined) {
      throw new Error(`The conversation of turn ${turn.id} no longer exists.`);
    }
    const truncated = finish.reply.length > conversationReplyMaxLength;
    const message = appendMessage(tx, conversation, {
      id: createMessageId(),
      role: 'assistant',
      kind: 'chat',
      content: truncated ? truncateText(finish.reply, conversationReplyMaxLength) : finish.reply,
      requestId: null,
      now: finish.endedAt,
    });
    return tx
      .update(conversationTurns)
      .set({
        status: 'completed',
        assistantMessageId: message.id,
        replyTruncated: truncated,
        errorCode: null,
        errorMessage: null,
        exitCode: finish.exitCode,
        effectiveModelId: finish.effectiveModelId ?? turn.effectiveModelId,
        endedAt: finish.endedAt,
        updatedAt: finish.endedAt,
      })
      .where(eq(conversationTurns.id, turn.id))
      .returning()
      .get();
  }, immediate);

/** Turns a worker holds (`running` or `stopping`), for restart reconciliation. */
export const listRunningConversationTurns = (db: Database): ConversationTurnRecord[] =>
  db
    .select()
    .from(conversationTurns)
    .where(inArray(conversationTurns.status, ['running', 'stopping']))
    .all();

/** Turns of this worker whose Stop was requested. */
export const listStoppingConversationTurns = (
  db: Database,
  workerInstanceId: string,
): ConversationTurnRecord[] =>
  db
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.status, 'stopping'),
        eq(conversationTurns.workerInstanceId, workerInstanceId),
      ),
    )
    .all();

/**
 * Fails queued turns older than `olderThan` (the worker was not running when they were sent), so
 * an old message never starts a CLI unexpectedly later. Returns how many were failed.
 */
export const expireQueuedConversationTurns = (
  db: Database,
  { olderThan, now }: { olderThan: number; now: number },
): number =>
  db
    .update(conversationTurns)
    .set({
      status: 'failed',
      errorCode: 'request_expired',
      errorMessage:
        'No worker picked up this request in time, so it was not sent. Start the worker and retry.',
      endedAt: now,
      updatedAt: now,
    })
    .where(and(eq(conversationTurns.status, 'queued'), lt(conversationTurns.createdAt, olderThan)))
    .run().changes;

/** The highest message sequence of a conversation, for tests and diagnostics. */
export const lastConversationSequence = (db: Database, conversationId: string): number =>
  db
    .select({ sequence: max(conversationMessages.sequence) })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .get()?.sequence ?? 0;
