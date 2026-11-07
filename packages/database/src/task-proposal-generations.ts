import {
  activeConversationTurnStatuses,
  ConversationError,
  conversationDisclosure,
  evaluateConversationConsent,
  formatSourceReference,
  parseRepositoryContextRecord,
  requestTaskProposalsInputSchema,
  retryableConversationTurnStatuses,
  retryTaskProposalGenerationInputSchema,
  taskProposalGenerationIdSchema,
  truncateText,
  type ConversationHistoryEntry,
  type ConversationTurnStatus,
  type ParsedTaskProposal,
  type RequestTaskProposalsInput,
  type RetryTaskProposalGenerationInput,
  type TaskProposalSourceReferences,
} from '@ai-agent-manager/core';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import type { z } from 'zod';
import type { DatabaseConnection } from './client.js';
import { getConversationConsent, loadHistory, requireConsent } from './conversation-turns.js';
import { evaluateStoredProjectSourceAccess } from './project-source-access.js';
import {
  activeTurnError,
  findScoped,
  hasActiveGeneration,
  hasActiveTurn,
  parseScope,
  runningConversationWorkByRuntime,
  type ConversationRecord,
  type Scope,
  type Transaction,
} from './conversations.js';
import {
  conversationMessages,
  conversations,
  conversationTurns,
  taskProposalGenerations,
  taskProposals,
} from './schema.js';

// C3 — task proposal generations. The web process records an explicit operator request as a
// `queued` generation; the worker claims it, runs the CLI through the conversation gate and
// finishes it. Only `finishTaskProposalGeneration` with `completed` stores proposals, all as
// `draft`, in the same transaction. A generation never appends a message, never edits existing
// proposals and never creates, queues or starts a task: this module has no access to task,
// worker-command, worktree or Git code.

type Database = DatabaseConnection['db'];

export type TaskProposalGenerationRecord = typeof taskProposalGenerations.$inferSelect;
export type TaskProposalRecord = typeof taskProposals.$inferSelect;

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

const generationNotFound = (): ConversationError =>
  new ConversationError(
    'task_proposal_generation_not_found',
    'The task proposal request does not exist.',
  );

const requestConflict = (): ConversationError =>
  new ConversationError(
    'conversation_request_conflict',
    'This request was already used for something else. Reload the page and try again.',
  );

/** Refuses when AI is off or an AI request of this conversation is active. */
const assertCanGenerate = (tx: Transaction, conversation: ConversationRecord): void => {
  requireConsent(tx);
  if (hasActiveTurn(tx, conversation.id)) {
    throw activeTurnError();
  }
  if (hasActiveGeneration(tx, conversation.id)) {
    throw new ConversationError(
      'conversation_turn_active',
      'Task proposals are already being generated in this conversation. Wait for them or stop the generation first.',
    );
  }
};

/**
 * Loads the source of a C3.1 generation by its ID, server-side: it must be an AI reply
 * (`assistant`, `chat`) of **this** conversation that a completed turn stored. Anything else, a
 * note, a user message, or a message of another conversation or project, is refused.
 */
const requireSourceReply = (
  tx: Transaction,
  conversation: ConversationRecord,
  messageId: string,
): { id: string; sequence: number; content: string } => {
  const message = tx
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, messageId),
        eq(conversationMessages.conversationId, conversation.id),
      ),
    )
    .get();
  if (message === undefined) {
    throw new ConversationError(
      'task_proposal_source_not_found',
      'The selected AI reply does not exist in this conversation.',
    );
  }
  const completed = tx
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.assistantMessageId, message.id),
        eq(conversationTurns.status, 'completed'),
      ),
    )
    .get();
  if (message.role !== 'assistant' || message.kind !== 'chat' || completed === undefined) {
    throw new ConversationError(
      'task_proposal_source_invalid',
      'Tasks can be generated only from a completed AI reply, not from your messages or notes.',
    );
  }
  return { id: message.id, sequence: message.sequence, content: message.content };
};

const insertGeneration = (
  tx: Transaction,
  conversation: ConversationRecord,
  values: {
    id: string;
    requestId: string;
    instructions: string;
    source: { id: string; sequence: number; content: string };
    retryOfGenerationId: string | null;
    now: number;
  },
): TaskProposalGenerationRecord => {
  const generation = tx
    .insert(taskProposalGenerations)
    .values({
      id: values.id,
      conversationId: conversation.id,
      retryOfGenerationId: values.retryOfGenerationId,
      requestId: values.requestId,
      status: 'queued',
      // Snapshot: later settings changes and messages do not affect this generation.
      agentRuntime: conversation.agentRuntime,
      requestedModelId: conversation.modelId,
      languageMode: conversation.languageMode,
      instructions: values.instructions,
      // C3.1: the source reply and an immutable snapshot of its text; retries reuse both.
      sourceMessageId: values.source.id,
      sourceContent: values.source.content,
      basedOnSequence: values.source.sequence,
      createdAt: values.now,
      updatedAt: values.now,
    })
    .returning()
    .get();
  tx.update(conversations)
    .set({ updatedAt: values.now })
    .where(eq(conversations.id, conversation.id))
    .run();
  return generation;
};

export type RequestTaskProposalsResult = {
  generation: TaskProposalGenerationRecord;
  /** `false` when the same request was already stored and the stored generation returns. */
  created: boolean;
};

/**
 * Records the operator's explicit request for task proposals from one completed AI reply (C3.1)
 * as a `queued` generation, with a snapshot of the reply's text loaded here by its ID. Returns at
 * once; no process is started here. Refused while AI replies are off, while a chat turn or another
 * generation of this conversation is active, and for a source that is not a completed AI reply of
 * this conversation. A repeat with the same `requestId`, source and instructions returns the
 * stored generation; a new request ID for the same source is a deliberate new generation.
 */
export const requestTaskProposals = (
  db: Database,
  {
    scope,
    generationId,
    input,
    now,
  }: { scope: Scope; generationId: string; input: RequestTaskProposalsInput; now: number },
): RequestTaskProposalsResult => {
  const ids = parseScope(scope);
  const parsedId = taskProposalGenerationIdSchema.safeParse(generationId);
  if (!parsedId.success) {
    throw new ConversationError('invalid_conversation_input', 'Invalid identifiers.');
  }
  const parsed = requestTaskProposalsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  const { requestId, instructions, sourceMessageId } = parsed.data;

  return db.transaction((tx) => {
    const conversation = findScoped(tx, ids);
    if (conversation === undefined) {
      throw conversationNotFound();
    }
    const existing = tx
      .select()
      .from(taskProposalGenerations)
      .where(eq(taskProposalGenerations.requestId, requestId))
      .get();
    if (existing !== undefined) {
      if (
        existing.conversationId !== conversation.id ||
        existing.retryOfGenerationId !== null ||
        existing.sourceMessageId !== sourceMessageId ||
        existing.instructions !== instructions
      ) {
        throw requestConflict();
      }
      return { generation: existing, created: false };
    }
    assertCanGenerate(tx, conversation);
    const source = requireSourceReply(tx, conversation, sourceMessageId);
    const generation = insertGeneration(tx, conversation, {
      id: parsedId.data,
      requestId,
      instructions,
      source,
      retryOfGenerationId: null,
      now,
    });
    return { generation, created: true };
  }, immediate);
};

const findGenerationScoped = (
  tx: Database | Transaction,
  conversation: ConversationRecord,
  generationId: string,
): TaskProposalGenerationRecord => {
  const parsed = taskProposalGenerationIdSchema.safeParse(generationId);
  const generation = parsed.success
    ? tx
        .select()
        .from(taskProposalGenerations)
        .where(
          and(
            eq(taskProposalGenerations.id, parsed.data),
            eq(taskProposalGenerations.conversationId, conversation.id),
          ),
        )
        .get()
    : undefined;
  if (generation === undefined) {
    throw generationNotFound();
  }
  return generation;
};

/**
 * Asks again after the latest generation **of the same source reply** failed, was stopped or was
 * interrupted. The new generation keeps the source reference, the source snapshot and the
 * instructions, uses the conversation's **current** runtime, model and language, and never
 * touches proposals of earlier generations. Never automatic. C3 generations without a source
 * cannot be retried; generate from an AI reply instead.
 */
export const retryTaskProposalGeneration = (
  db: Database,
  {
    scope,
    generationId,
    newGenerationId,
    input,
    now,
  }: {
    scope: Scope;
    generationId: string;
    newGenerationId: string;
    input: RetryTaskProposalGenerationInput;
    now: number;
  },
): RequestTaskProposalsResult => {
  const ids = parseScope(scope);
  const parsed = retryTaskProposalGenerationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  const parsedNewId = taskProposalGenerationIdSchema.safeParse(newGenerationId);
  if (!parsedNewId.success) {
    throw new ConversationError('invalid_conversation_input', 'Invalid identifiers.');
  }
  return db.transaction((tx) => {
    const conversation = findScoped(tx, ids);
    if (conversation === undefined) {
      throw conversationNotFound();
    }
    const source = findGenerationScoped(tx, conversation, generationId);
    const repeated = tx
      .select()
      .from(taskProposalGenerations)
      .where(eq(taskProposalGenerations.requestId, parsed.data.requestId))
      .get();
    if (repeated !== undefined) {
      if (repeated.retryOfGenerationId !== source.id) {
        throw requestConflict();
      }
      return { generation: repeated, created: false };
    }
    if (
      source.sourceMessageId === null ||
      source.sourceContent === null ||
      source.basedOnSequence < 1
    ) {
      throw new ConversationError(
        'task_proposal_generation_not_retryable',
        'This proposal request was made from the whole conversation before C3.1 and cannot be retried. Use Generate tasks under an AI reply instead.',
      );
    }
    const latest = tx
      .select({ id: taskProposalGenerations.id })
      .from(taskProposalGenerations)
      .where(
        and(
          eq(taskProposalGenerations.conversationId, conversation.id),
          eq(taskProposalGenerations.sourceMessageId, source.sourceMessageId),
        ),
      )
      .orderBy(desc(taskProposalGenerations.createdAt), desc(taskProposalGenerations.id))
      .get();
    if (
      !(retryableConversationTurnStatuses as readonly ConversationTurnStatus[]).includes(
        source.status,
      ) ||
      latest?.id !== source.id
    ) {
      throw new ConversationError(
        'task_proposal_generation_not_retryable',
        'Only the latest failed, stopped or interrupted request for this AI reply can be retried. Generate tasks again instead.',
      );
    }
    assertCanGenerate(tx, conversation);
    const generation = insertGeneration(tx, conversation, {
      id: parsedNewId.data,
      requestId: parsed.data.requestId,
      instructions: source.instructions,
      // The same source and the same snapshot as the original request.
      source: {
        id: source.sourceMessageId,
        sequence: source.basedOnSequence,
        content: source.sourceContent,
      },
      retryOfGenerationId: source.id,
      now,
    });
    return { generation, created: true };
  }, immediate);
};

/**
 * Records the operator's Stop. A queued generation is cancelled at once; a running one becomes
 * `stopping` and the worker terminates the CLI's process group. Nothing is stored either way.
 */
export const requestTaskProposalGenerationStop = (
  db: Database,
  { scope, generationId, now }: { scope: Scope; generationId: string; now: number },
): TaskProposalGenerationRecord => {
  const ids = parseScope(scope);
  return db.transaction((tx) => {
    const conversation = findScoped(tx, ids);
    if (conversation === undefined) {
      throw conversationNotFound();
    }
    const generation = findGenerationScoped(tx, conversation, generationId);
    const update = (
      from: 'queued' | 'running',
      values: Partial<TaskProposalGenerationRecord>,
    ): TaskProposalGenerationRecord => {
      const updated = tx
        .update(taskProposalGenerations)
        .set({ ...values, stopRequestedAt: now, updatedAt: now })
        .where(
          and(
            eq(taskProposalGenerations.id, generation.id),
            eq(taskProposalGenerations.status, from),
          ),
        )
        .returning()
        .get();
      if (updated === undefined) {
        throw new Error(`Generation ${generation.id} changed while it was being stopped.`);
      }
      return updated;
    };
    switch (generation.status) {
      case 'queued':
        return update('queued', {
          status: 'cancelled',
          errorMessage: 'Stopped before the CLI was started. No proposals were stored.',
          endedAt: now,
        });
      case 'running':
        return update('running', { status: 'stopping' });
      case 'stopping':
      case 'cancelled':
        return generation;
      default:
        throw new ConversationError(
          'task_proposal_generation_not_active',
          'This proposal request already finished; there is nothing to stop.',
        );
    }
  }, immediate);
};

/** The conversation's generations, oldest first; `undefined` for another project's conversation. */
export const listTaskProposalGenerations = (
  db: Database,
  scope: Scope,
): TaskProposalGenerationRecord[] | undefined => {
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
    .from(taskProposalGenerations)
    .where(eq(taskProposalGenerations.conversationId, conversation.id))
    .orderBy(asc(taskProposalGenerations.createdAt), asc(taskProposalGenerations.id))
    .all();
};

/** One generation of this conversation, or `conversation_not_found` / `…generation_not_found`. */
export const findTaskProposalGeneration = (
  db: Database,
  { scope, generationId }: { scope: Scope; generationId: string },
): TaskProposalGenerationRecord => {
  const conversation = findScoped(db, parseScope(scope));
  if (conversation === undefined) {
    throw conversationNotFound();
  }
  return findGenerationScoped(db, conversation, generationId);
};

// ---------------------------------------------------------------------------------------------
// Worker commands
// ---------------------------------------------------------------------------------------------

export const findTaskProposalGenerationById = (
  db: Database,
  generationId: string,
): TaskProposalGenerationRecord | undefined =>
  db
    .select()
    .from(taskProposalGenerations)
    .where(eq(taskProposalGenerations.id, generationId))
    .get();

/** What the worker needs to run one claimed generation. */
export type ClaimedTaskProposalGeneration = {
  generation: TaskProposalGenerationRecord;
  conversation: ConversationRecord;
  /**
   * C3 generations only: completed exchanges up to `basedOnSequence`. Always empty for a C3.1
   * generation, whose only content is `generation.sourceContent`.
   */
  history: ConversationHistoryEntry[];
  notesExcluded: number;
  /**
   * C4: when the source reply was a project-aware reply, the repository excerpts it was written
   * from (paths and line ranges, never content), so task prompts can name the files. Only while
   * the project still allows source sharing; otherwise `null`.
   */
  sourceReferences: TaskProposalSourceReferences | null;
};

export type ClaimTaskProposalGenerationResult =
  { claimed: true; claim: ClaimedTaskProposalGeneration } | { claimed: false };

/**
 * Claims the oldest queued generation whose runtime has a free conversation slot (shared with
 * chat turns). Without a current AI Conversations consent, every queued generation fails with an
 * actionable message instead of starting.
 */
export const claimTaskProposalGeneration = (
  db: Database,
  {
    workerInstanceId,
    now,
    maxActivePerRuntime = 1,
  }: { workerInstanceId: string; now: number; maxActivePerRuntime?: number },
): ClaimTaskProposalGenerationResult =>
  db.transaction((tx) => {
    const queued = tx
      .select()
      .from(taskProposalGenerations)
      .where(eq(taskProposalGenerations.status, 'queued'))
      .orderBy(asc(taskProposalGenerations.createdAt), asc(taskProposalGenerations.id))
      .all();
    if (queued.length === 0) {
      return { claimed: false };
    }
    const decision = evaluateConversationConsent(getConversationConsent(tx));
    if (!decision.ok) {
      for (const generation of queued) {
        tx.update(taskProposalGenerations)
          .set({
            status: 'failed',
            errorCode: decision.code,
            errorMessage: decision.message,
            endedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(taskProposalGenerations.id, generation.id),
              eq(taskProposalGenerations.status, 'queued'),
            ),
          )
          .run();
      }
      return { claimed: false };
    }
    const running = runningConversationWorkByRuntime(tx);
    const next = queued.find(
      (generation) => (running.get(generation.agentRuntime) ?? 0) < maxActivePerRuntime,
    );
    if (next === undefined) {
      return { claimed: false };
    }
    const generation = tx
      .update(taskProposalGenerations)
      .set({
        status: 'running',
        workerInstanceId,
        securityMode: 'trusted_local',
        disclosureVersion: conversationDisclosure.version,
        claimedAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(taskProposalGenerations.id, next.id), eq(taskProposalGenerations.status, 'queued')),
      )
      .returning()
      .get();
    const conversation = tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, next.conversationId))
      .get();
    if (generation === undefined || conversation === undefined) {
      throw new Error(`Proposal generation ${next.id} could not be claimed consistently.`);
    }
    // C3.1 generations send only their source snapshot (on the row) and load no history. Only a
    // C3 generation queued before the upgrade still uses the answered history.
    const { history, notesExcluded } =
      generation.sourceContent === null
        ? loadHistory(tx, conversation.id, generation.basedOnSequence + 1)
        : { history: [], notesExcluded: 0 };
    const sourceReferences =
      generation.sourceMessageId === null
        ? null
        : loadSourceReferences(tx, conversation, generation.sourceMessageId);
    return {
      claimed: true,
      claim: { generation, conversation, history, notesExcluded, sourceReferences },
    };
  }, immediate);

/** Repository references of a project-aware source reply (C4); `null` when there are none. */
const loadSourceReferences = (
  tx: Transaction,
  conversation: ConversationRecord,
  sourceMessageId: string,
): TaskProposalSourceReferences | null => {
  const turn = tx
    .select({
      contextMode: conversationTurns.contextMode,
      json: conversationTurns.repositoryContextJson,
    })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.conversationId, conversation.id),
        eq(conversationTurns.assistantMessageId, sourceMessageId),
        eq(conversationTurns.status, 'completed'),
      ),
    )
    .get();
  if (turn === undefined || turn.contextMode !== 'project_aware') return null;
  const record = parseRepositoryContextRecord(turn.json);
  if (record === null || record.sources.length === 0) return null;
  if (!evaluateStoredProjectSourceAccess(tx, conversation.projectId).ok) return null;
  return {
    sourceMode: record.sourceMode,
    commit: record.commit,
    files: record.sources.map(formatSourceReference),
  };
};

export type TaskProposalGenerationProgress = Partial<
  Pick<
    TaskProposalGenerationRecord,
    | 'launchProfileId'
    | 'cliVersion'
    | 'contextManifestJson'
    | 'pid'
    | 'startedAt'
    | 'effectiveModelId'
  >
>;

/** Records launch facts of an active generation. Never changes its status. */
export const updateTaskProposalGenerationProgress = (
  db: Database,
  generationId: string,
  progress: TaskProposalGenerationProgress,
  now: number,
): void => {
  db.update(taskProposalGenerations)
    .set({ ...progress, updatedAt: now })
    .where(
      and(
        eq(taskProposalGenerations.id, generationId),
        inArray(taskProposalGenerations.status, activeStatuses),
      ),
    )
    .run();
};

export type TaskProposalGenerationFinish =
  | {
      status: 'completed';
      proposals: readonly ParsedTaskProposal[];
      skippedCount: number;
      note: string;
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
 * Finishes an active generation exactly once. `completed` stores every validated proposal as a
 * `draft` of the conversation's project in the same transaction, with the generation's runtime
 * and model as defaults and the project default base branch. Returns `undefined` (writing nothing)
 * when the generation is no longer active, so a late or repeated finish never duplicates
 * proposals. Existing proposals are never changed.
 */
export const finishTaskProposalGeneration = (
  db: Database,
  generationId: string,
  finish: TaskProposalGenerationFinish,
  { createProposalId }: { createProposalId: () => string },
): TaskProposalGenerationRecord | undefined =>
  db.transaction((tx) => {
    const generation = tx
      .select()
      .from(taskProposalGenerations)
      .where(
        and(
          eq(taskProposalGenerations.id, generationId),
          inArray(taskProposalGenerations.status, activeStatuses),
        ),
      )
      .get();
    if (generation === undefined) {
      return undefined;
    }
    if (finish.status !== 'completed') {
      return tx
        .update(taskProposalGenerations)
        .set({
          status: finish.status,
          errorCode: finish.errorCode,
          errorMessage:
            finish.errorMessage === null ? null : truncateText(finish.errorMessage, 2_000),
          exitCode: finish.exitCode,
          signal: finish.signal,
          effectiveModelId: finish.effectiveModelId ?? generation.effectiveModelId,
          endedAt: finish.endedAt,
          updatedAt: finish.endedAt,
        })
        .where(eq(taskProposalGenerations.id, generation.id))
        .returning()
        .get();
    }
    const conversation = tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, generation.conversationId))
      .get();
    if (conversation === undefined) {
      throw new Error(`The conversation of generation ${generation.id} no longer exists.`);
    }
    finish.proposals.forEach((proposal, index) => {
      tx.insert(taskProposals)
        .values({
          id: createProposalId(),
          // Always the conversation's own project; a proposal never moves to another project.
          projectId: conversation.projectId,
          conversationId: conversation.id,
          generationId: generation.id,
          position: index + 1,
          status: 'draft',
          title: proposal.title,
          prompt: proposal.prompt,
          agentRuntime: generation.agentRuntime,
          modelId: generation.requestedModelId,
          priority: proposal.priority,
          baseBranch: null,
          suggestedTitle: proposal.title,
          suggestedPrompt: proposal.prompt,
          suggestedPriority: proposal.priority,
          rationale: proposal.rationale,
          dependencies: proposal.dependencies,
          revision: 1,
          createdAt: finish.endedAt,
          updatedAt: finish.endedAt,
        })
        .run();
    });
    tx.update(conversations)
      .set({ updatedAt: finish.endedAt })
      .where(eq(conversations.id, conversation.id))
      .run();
    return tx
      .update(taskProposalGenerations)
      .set({
        status: 'completed',
        proposalCount: finish.proposals.length,
        skippedCount: finish.skippedCount,
        outputNote: finish.note === '' ? null : finish.note,
        errorCode: null,
        errorMessage: null,
        exitCode: finish.exitCode,
        effectiveModelId: finish.effectiveModelId ?? generation.effectiveModelId,
        endedAt: finish.endedAt,
        updatedAt: finish.endedAt,
      })
      .where(eq(taskProposalGenerations.id, generation.id))
      .returning()
      .get();
  }, immediate);

/** Generations a worker holds (`running` or `stopping`), for restart reconciliation. */
export const listRunningTaskProposalGenerations = (db: Database): TaskProposalGenerationRecord[] =>
  db
    .select()
    .from(taskProposalGenerations)
    .where(inArray(taskProposalGenerations.status, ['running', 'stopping']))
    .all();

/** Generations of this worker whose Stop was requested. */
export const listStoppingTaskProposalGenerations = (
  db: Database,
  workerInstanceId: string,
): TaskProposalGenerationRecord[] =>
  db
    .select()
    .from(taskProposalGenerations)
    .where(
      and(
        eq(taskProposalGenerations.status, 'stopping'),
        eq(taskProposalGenerations.workerInstanceId, workerInstanceId),
      ),
    )
    .all();

/** Fails queued generations older than `olderThan`, so an old request never starts unexpectedly. */
export const expireQueuedTaskProposalGenerations = (
  db: Database,
  { olderThan, now }: { olderThan: number; now: number },
): number =>
  db
    .update(taskProposalGenerations)
    .set({
      status: 'failed',
      errorCode: 'request_expired',
      errorMessage:
        'No worker picked up this request in time, so it was not sent. Start the worker and retry.',
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(taskProposalGenerations.status, 'queued'),
        lt(taskProposalGenerations.createdAt, olderThan),
      ),
    )
    .run().changes;
