import {
  activeConversationTurnStatuses,
  addConversationNoteInputSchema,
  ConversationError,
  conversationIdSchema,
  conversationMessageIdSchema,
  createConversationInputSchema,
  describeModelSelectionProblem,
  projectIdSchema,
  resolveConversationUpdate,
  updateConversationInputSchema,
  type AddConversationNoteInput,
  type ConversationMessageKind,
  type ConversationMessageRole,
  type CreateConversationInput,
  type UpdateConversationInput,
} from '@ai-agent-manager/core';
import { and, asc, count, desc, eq, inArray, max } from 'drizzle-orm';
import type { z } from 'zod';
import type { DatabaseConnection } from './client.js';
import { conversationMessages, conversations, conversationTurns, projects } from './schema.js';

// AI Conversations persistence (C1; C2 turns live in `conversation-turns.ts`). Every read and command is scoped by the project ID as well
// as the conversation ID, so a conversation of another project is reported as missing and its
// messages are never returned. Each command runs in one IMMEDIATE transaction. Nothing here
// launches an agent, writes a worker command, touches a task or calls Git.

type Database = DatabaseConnection['db'];
/** @internal Shared with `conversation-turns.ts`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type ConversationRecord = typeof conversations.$inferSelect;
export type ConversationMessageRecord = typeof conversationMessages.$inferSelect;
export type ConversationSummaryRecord = ConversationRecord & { messageCount: number };

const immediate = { behavior: 'immediate' } as const;

/** A model that does not fit the selected runtime, reported on the `modelId` field. */
const invalidModel = (message: string): ConversationError =>
  new ConversationError('invalid_conversation_input', message, {
    issues: [{ path: 'modelId', message }],
  });

const invalidInput = (error: z.ZodError): ConversationError =>
  new ConversationError(
    'invalid_conversation_input',
    error.issues[0]?.message ?? 'The conversation input is invalid.',
    { issues: error.issues.map(({ path, message }) => ({ path: path.join('.'), message })) },
  );

/** @internal Shared with `conversation-turns.ts`. */
export const hasActiveTurn = (db: Database | Transaction, conversationId: string): boolean =>
  db
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.conversationId, conversationId),
        inArray(conversationTurns.status, [...activeConversationTurnStatuses]),
      ),
    )
    .get() !== undefined;

/** @internal Shared with `conversation-turns.ts`. */
export const activeTurnError = (): ConversationError =>
  new ConversationError(
    'conversation_turn_active',
    'A reply is still pending in this conversation. Wait for it or stop it first.',
  );

const conversationNotFound = (): ConversationError =>
  new ConversationError('conversation_not_found', 'The conversation does not exist.');

const projectNotFound = (): ConversationError =>
  new ConversationError('project_not_found', 'The project does not exist.');

export type Scope = { projectId: string; conversationId: string };

/**
 * Parses both IDs; a malformed ID cannot name an existing row, so it is reported as missing.
 *
 * @internal Shared with `conversation-turns.ts`.
 */
export const parseScope = ({ projectId, conversationId }: Scope): Scope => {
  const project = projectIdSchema.safeParse(projectId);
  const conversation = conversationIdSchema.safeParse(conversationId);
  if (!project.success || !conversation.success) {
    throw conversationNotFound();
  }
  return { projectId: project.data, conversationId: conversation.data };
};

/** @internal Shared with `conversation-turns.ts`. */
export const findScoped = (
  db: Database | Transaction,
  { projectId, conversationId }: Scope,
): ConversationRecord | undefined =>
  db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.projectId, projectId)))
    .get();

/**
 * Creates a conversation in an existing project with an empty history. `id` is an
 * application-generated UUID; `now` is Unix milliseconds.
 */
export const createConversation = (
  db: Database,
  { id, input, now }: { id: string; input: CreateConversationInput; now: number },
): ConversationRecord => {
  const parsedId = conversationIdSchema.safeParse(id);
  if (!parsedId.success) {
    throw invalidInput(parsedId.error);
  }
  const parsed = createConversationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  const data = parsed.data;
  const modelProblem = describeModelSelectionProblem(data.agentRuntime, data.modelId);
  if (modelProblem !== null) {
    throw invalidModel(modelProblem);
  }

  return db.transaction((tx) => {
    const project = tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, data.projectId))
      .get();
    if (project === undefined) {
      throw projectNotFound();
    }
    return tx
      .insert(conversations)
      .values({
        ...data,
        id: parsedId.data,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
      })
      .returning()
      .get();
  }, immediate);
};

/** The conversation, or `undefined` when it does not exist in this project. */
export const findProjectConversation = (
  db: Database,
  scope: Scope,
): ConversationRecord | undefined => {
  const project = projectIdSchema.safeParse(scope.projectId);
  const conversation = conversationIdSchema.safeParse(scope.conversationId);
  if (!project.success || !conversation.success) {
    return undefined;
  }
  return findScoped(db, { projectId: project.data, conversationId: conversation.data });
};

/**
 * Lists one project's conversations with their message counts, most recently changed first.
 * Conversations of other projects are never included.
 */
export const listProjectConversations = (
  db: Database,
  projectId: string,
): ConversationSummaryRecord[] => {
  const parsed = projectIdSchema.safeParse(projectId);
  if (!parsed.success) {
    return [];
  }
  const rows = db
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, parsed.data))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .all();
  if (rows.length === 0) {
    return [];
  }
  const counts = new Map(
    db
      .select({ conversationId: conversationMessages.conversationId, count: count() })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(eq(conversations.projectId, parsed.data))
      .groupBy(conversationMessages.conversationId)
      .all()
      .map(({ conversationId, count: total }) => [conversationId, total]),
  );
  return rows.map((row) => ({ ...row, messageCount: counts.get(row.id) ?? 0 }));
};

/** Counts conversations per project. Projects without conversations are absent. */
export const countConversationsByProject = (
  db: Database,
): { projectId: string; count: number; lastUpdatedAt: number | null }[] =>
  db
    .select({
      projectId: conversations.projectId,
      count: count(),
      lastUpdatedAt: max(conversations.updatedAt),
    })
    .from(conversations)
    .groupBy(conversations.projectId)
    .all();

/**
 * The conversation's history in its stored order (`sequence`). Returns `undefined` when the
 * conversation does not exist in this project, so another project's messages are never returned.
 */
export const listConversationMessages = (
  db: Database,
  scope: Scope,
): ConversationMessageRecord[] | undefined => {
  const conversation = findProjectConversation(db, scope);
  if (conversation === undefined) {
    return undefined;
  }
  return db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversation.id))
    .orderBy(asc(conversationMessages.sequence))
    .all();
};

/**
 * Changes a conversation's title, runtime, model or language for future messages. The update must
 * name the settings revision it was based on; a stale revision is rejected with
 * `conversation_changed` and nothing is written. Switching the runtime without choosing a model
 * resets the model to `Default`. Past messages are never changed.
 */
export const updateConversation = (
  db: Database,
  { scope, input, now }: { scope: Scope; input: UpdateConversationInput; now: number },
): ConversationRecord => {
  const ids = parseScope(scope);
  const parsed = updateConversationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }

  return db.transaction((tx) => {
    const current = findScoped(tx, ids);
    if (current === undefined) {
      throw conversationNotFound();
    }
    if (current.revision !== parsed.data.revision) {
      throw new ConversationError(
        'conversation_changed',
        'The conversation settings changed in the meantime. Reload the page and try again.',
        { revision: current.revision },
      );
    }
    const changes = resolveConversationUpdate(current, parsed.data);
    if (changes.agentRuntime !== undefined || changes.modelId !== undefined) {
      // Checked only when the runtime or model changes, so a stored custom ID stays editable.
      const problem = describeModelSelectionProblem(
        changes.agentRuntime ?? current.agentRuntime,
        changes.modelId === undefined ? current.modelId : changes.modelId,
      );
      if (problem !== null) {
        throw invalidModel(problem);
      }
    }
    const updated = tx
      .update(conversations)
      .set({
        title: changes.title,
        agentRuntime: changes.agentRuntime,
        modelId: changes.modelId,
        languageMode: changes.languageMode,
        revision: current.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(conversations.id, current.id), eq(conversations.revision, current.revision)))
      .returning()
      .get();
    if (updated === undefined) {
      throw new ConversationError(
        'conversation_changed',
        'The conversation settings changed in the meantime. Reload the page and try again.',
      );
    }
    return updated;
  }, immediate);
};

export type NewMessage = {
  id: string;
  role: ConversationMessageRole;
  kind: ConversationMessageKind;
  content: string;
  requestId: string | null;
  now: number;
};

/**
 * The single place that appends to a history: allocates the next `sequence` of the conversation
 * and touches its activity timestamps. Must run inside the caller's IMMEDIATE transaction, which
 * has already verified the conversation's project. Notes (C1) and CLI-backed `chat` messages (C2)
 * both go through it, so they share one ordering.
 *
 * @internal Shared with `conversation-turns.ts`; not exported from the package.
 */
export const appendMessage = (
  tx: Transaction,
  conversation: ConversationRecord,
  message: NewMessage,
): ConversationMessageRecord => {
  const last = tx
    .select({ sequence: max(conversationMessages.sequence) })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversation.id))
    .get();
  const inserted = tx
    .insert(conversationMessages)
    .values({
      id: message.id,
      conversationId: conversation.id,
      sequence: (last?.sequence ?? 0) + 1,
      role: message.role,
      kind: message.kind,
      content: message.content,
      requestId: message.requestId,
      createdAt: message.now,
    })
    .returning()
    .get();
  tx.update(conversations)
    .set({ updatedAt: message.now, lastMessageAt: message.now })
    .where(eq(conversations.id, conversation.id))
    .run();
  return inserted;
};

export type AddConversationNoteResult = {
  message: ConversationMessageRecord;
  /** `false` when the request ID was already saved and the existing note is returned. */
  created: boolean;
};

/**
 * Saves an operator note at the end of the history. The note is stored only: it is never sent to
 * an agent and never produces a reply. Repeating a request with the same `requestId` and content
 * returns the stored note instead of saving it twice; reusing a request ID for different content or
 * another conversation is rejected with `conversation_request_conflict`.
 */
export const addConversationNote = (
  db: Database,
  {
    scope,
    id,
    input,
    now,
  }: { scope: Scope; id: string; input: AddConversationNoteInput; now: number },
): AddConversationNoteResult => {
  const ids = parseScope(scope);
  const parsedId = conversationMessageIdSchema.safeParse(id);
  if (!parsedId.success) {
    throw invalidInput(parsedId.error);
  }
  const parsed = addConversationNoteInputSchema.safeParse(input);
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
      if (existing.conversationId !== conversation.id || existing.content !== content) {
        throw new ConversationError(
          'conversation_request_conflict',
          'This request was already used for a different message. Reload the page and try again.',
        );
      }
      return { message: existing, created: false };
    }
    // A note between a sent message and its reply would split the exchange (C2).
    if (hasActiveTurn(tx, conversation.id)) {
      throw activeTurnError();
    }
    const message = appendMessage(tx, conversation, {
      id: parsedId.data,
      role: 'user',
      kind: 'note',
      content,
      requestId,
      now,
    });
    return { message, created: true };
  }, immediate);
};
