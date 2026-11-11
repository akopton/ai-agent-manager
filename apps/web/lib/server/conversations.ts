import { randomUUID } from 'node:crypto';
import {
  ConversationError,
  conversationReferenceSnapshotsSchema,
  conversationReferenceLimits,
  conversationDisclosure,
  evaluateConversationConsent,
  evaluateProjectSourceAccess,
  isActiveConversationTurnStatus,
  parseRepositoryContextRecord,
  projectIdSchema,
  projectSourceDisclosure,
  type Conversation,
  type ConversationMessage,
  type UpdateConversationData,
  type UpdateConversationNoteInput,
  type ConversationNoteRevisionInput,
} from '@ai-agent-manager/core';
import {
  acceptConversationDisclosure,
  addConversationNote,
  updateConversationNote,
  deleteConversationNote,
  disableConversationAi,
  getConversationConsent,
  listConversationTurns,
  requestConversationTurnStop,
  retryConversationTurn,
  sendConversationMessage,
  countConversationsByProject,
  createConversation,
  findProjectById,
  findProjectConversation,
  listConversationMessages,
  listProjectConversations,
  updateConversation,
  type ConversationMessageRecord,
  type ConversationRecord,
  type ConversationTurnRecord,
  type DatabaseConnection,
  type ProjectRecord,
} from '@ai-agent-manager/database';
import { z } from 'zod';
import type {
  AddConversationMessageRequest,
  ConversationAiStatus,
  ConversationSettingsView,
  ConversationSummary,
  ConversationTurnView,
  CreateProjectConversationRequest,
  ProjectSourceAccessView,
  SendConversationMessageRequest,
  TaskProposalGenerationView,
  TaskProposalView,
} from '@/lib/conversations/contracts';
import { findConversationProposals } from '@/lib/server/task-proposals';

// Project-scoped conversation commands for the web app. Every lookup resolves the project from the
// route first and treats a conversation of another project as missing. Writes go through the
// validated commands in `@ai-agent-manager/database`. Nothing here launches a process: a chat
// message stores a queued turn and returns at once; the worker runs the CLI (C2). Nothing here
// writes a worker command, creates or changes a task, or reads or writes a repository.

type Database = DatabaseConnection['db'];

const projectNotFound = (): ConversationError =>
  new ConversationError('project_not_found', 'The project does not exist.');

const conversationNotFound = (): ConversationError =>
  new ConversationError('conversation_not_found', 'The conversation does not exist.');

const toConversation = ({
  id,
  projectId,
  title,
  agentRuntime,
  modelId,
  languageMode,
  contextMode,
  revision,
  createdAt,
  updatedAt,
  lastMessageAt,
}: ConversationRecord): Conversation => ({
  id,
  projectId,
  title,
  agentRuntime,
  modelId,
  languageMode,
  contextMode,
  revision,
  createdAt,
  updatedAt,
  lastMessageAt,
});

// The request ID is internal deduplication data and is not part of the public message shape.
const toMessage = ({
  id,
  conversationId,
  sequence,
  role,
  kind,
  content,
  createdAt,
  updatedAt,
  revision,
}: ConversationMessageRecord): ConversationMessage => ({
  id,
  conversationId,
  sequence,
  role,
  kind,
  content,
  createdAt,
  updatedAt,
  revision,
});

const findProject = (db: Database, projectId: string): ProjectRecord | undefined => {
  const parsed = projectIdSchema.safeParse(projectId);
  return parsed.success ? findProjectById(db, parsed.data) : undefined;
};

const requireProject = (db: Database, projectId: string): ProjectRecord => {
  const project = findProject(db, projectId);
  if (project === undefined) {
    throw projectNotFound();
  }
  return project;
};

export type ConversationProject = Pick<ProjectRecord, 'id' | 'name'>;

export type ProjectConversations = {
  project: ConversationProject;
  conversations: ConversationSummary[];
};

/** The project's conversations, or `undefined` when the project does not exist. */
export const getProjectConversations = (
  db: Database,
  projectId: string,
): ProjectConversations | undefined => {
  const project = findProject(db, projectId);
  if (project === undefined) {
    return undefined;
  }
  return {
    project: { id: project.id, name: project.name },
    conversations: listProjectConversations(db, project.id).map((record) => ({
      ...toConversation(record),
      messageCount: record.messageCount,
    })),
  };
};

export const listConversations = (db: Database, projectId: string): ConversationSummary[] =>
  getProjectConversations(db, requireProject(db, projectId).id)?.conversations ?? [];

export type ConversationDetail = {
  project: ConversationProject & Pick<ProjectRecord, 'defaultBaseBranch'>;
  conversation: Conversation;
  messages: ConversationMessage[];
  turns: ConversationTurnView[];
  ai: ConversationAiStatus;
  /** C3: explicit task proposal requests and the proposals they stored. */
  generations: TaskProposalGenerationView[];
  proposals: TaskProposalView[];
  /** C4: whether this project allows sharing source with Project-Aware conversations. */
  sourceAccess: ProjectSourceAccessView;
};

/** The project's source-sharing permission, from persisted state only (no repository access). */
export const toProjectSourceAccessView = (project: ProjectRecord): ProjectSourceAccessView => {
  const decision = evaluateProjectSourceAccess(project);
  return {
    current: decision.ok,
    access: project.conversationSourceAccess,
    reason: decision.ok ? 'allowed' : decision.reason,
    allowedAt: project.conversationSourceAllowedAt,
    localPath: project.localPath,
    gitCommonDir: project.gitCommonDir,
    disclosure: {
      version: projectSourceDisclosure.version,
      title: projectSourceDisclosure.title,
      statements: [...projectSourceDisclosure.statements],
    },
  };
};

const manifestSchema = z.object({
  includedSequences: z.array(z.number()),
  omittedMessages: z.number(),
  notesExcluded: z.number(),
});

/** The UI view of a turn. The prompt and the manifest's internals are never exposed. */
export const toTurnView = (
  turn: ConversationTurnRecord,
  availableSourceIds?: ReadonlySet<string>,
): ConversationTurnView => {
  let context: ConversationTurnView['context'] = null;
  if (turn.contextManifestJson !== null) {
    try {
      const manifest = manifestSchema.safeParse(JSON.parse(turn.contextManifestJson));
      context = manifest.success
        ? {
            includedMessages: manifest.data.includedSequences.length,
            omittedMessages: manifest.data.omittedMessages,
            notesExcluded: manifest.data.notesExcluded,
          }
        : null;
    } catch {
      context = null;
    }
  }
  return {
    references: conversationReferenceSnapshotsSchema
      .parse(JSON.parse(turn.referencesJson))
      .map(({ sourceId, kind, role, content }) => ({
        sourceId,
        kind,
        role,
        preview: content.slice(0, conversationReferenceLimits.previewCharacters),
        sourceAvailable: availableSourceIds?.has(sourceId) ?? true,
      })),
    id: turn.id,
    status: turn.status,
    active: isActiveConversationTurnStatus(turn.status),
    userMessageId: turn.userMessageId,
    assistantMessageId: turn.assistantMessageId,
    retryOfTurnId: turn.retryOfTurnId,
    agentRuntime: turn.agentRuntime,
    requestedModelId: turn.requestedModelId,
    effectiveModelId: turn.effectiveModelId,
    languageMode: turn.languageMode,
    cliVersion: turn.cliVersion,
    errorCode: turn.errorCode,
    errorMessage: turn.errorMessage,
    replyTruncated: turn.replyTruncated,
    contextMode: turn.contextMode,
    contextStage:
      turn.contextMode === 'project_aware' && isActiveConversationTurnStatus(turn.status)
        ? turn.contextStage
        : null,
    repository: parseRepositoryContextRecord(turn.repositoryContextJson),
    context,
    createdAt: turn.createdAt,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    stopRequestedAt: turn.stopRequestedAt,
  };
};

/** Whether AI replies can be requested, from the persisted AI Conversations consent only. */
export const getConversationAiStatus = (db: Database): ConversationAiStatus => {
  const decision = evaluateConversationConsent(getConversationConsent(db));
  if (decision.ok) {
    return { enabled: true, reason: 'enabled' };
  }
  return {
    enabled: false,
    reason: decision.code === 'conversation_ai_stale' ? 'stale' : 'disabled',
  };
};

/**
 * The conversation with its full history, or `undefined` for an unknown project or a conversation
 * that does not belong to it.
 */
export const findConversationDetail = (
  db: Database,
  projectId: string,
  conversationId: string,
): ConversationDetail | undefined => {
  const project = findProject(db, projectId);
  if (project === undefined) {
    return undefined;
  }
  const scope = { projectId: project.id, conversationId };
  const conversation = findProjectConversation(db, scope);
  const messages = listConversationMessages(db, scope);
  const turns = listConversationTurns(db, scope);
  const proposals = findConversationProposals(db, scope);
  if (
    conversation === undefined ||
    messages === undefined ||
    turns === undefined ||
    proposals === undefined
  ) {
    return undefined;
  }
  const availableSourceIds = new Set(messages.map((message) => message.id));
  return {
    project: { id: project.id, name: project.name, defaultBaseBranch: project.defaultBaseBranch },
    conversation: toConversation(conversation),
    messages: messages.map(toMessage),
    turns: turns.map((turn) => toTurnView(turn, availableSourceIds)),
    ai: getConversationAiStatus(db),
    generations: proposals.generations,
    proposals: proposals.proposals,
    sourceAccess: toProjectSourceAccessView(project),
  };
};

export const getConversationDetail = (
  db: Database,
  projectId: string,
  conversationId: string,
): ConversationDetail => {
  requireProject(db, projectId);
  const detail = findConversationDetail(db, projectId, conversationId);
  if (detail === undefined) {
    throw conversationNotFound();
  }
  return detail;
};

export type ProjectConversationOverview = {
  project: ConversationProject;
  count: number;
  lastUpdatedAt: number | null;
};

/** Every project with its number of conversations, for the Conversations area. */
export const listConversationOverview = (
  db: Database,
  projects: readonly ConversationProject[],
): ProjectConversationOverview[] => {
  const counts = new Map(countConversationsByProject(db).map((row) => [row.projectId, row]));
  return projects.map((project) => ({
    project: { id: project.id, name: project.name },
    count: counts.get(project.id)?.count ?? 0,
    lastUpdatedAt: counts.get(project.id)?.lastUpdatedAt ?? null,
  }));
};

export type ConversationServiceOptions = { now?: () => number; createId?: () => string };

export const createProjectConversation = (
  db: Database,
  projectId: string,
  request: CreateProjectConversationRequest,
  { now = Date.now, createId = randomUUID }: ConversationServiceOptions = {},
): Conversation => {
  const project = requireProject(db, projectId);
  return toConversation(
    createConversation(db, {
      id: createId(),
      input: { ...request, projectId: project.id },
      now: now(),
    }),
  );
};

export const updateProjectConversation = (
  db: Database,
  projectId: string,
  conversationId: string,
  request: UpdateConversationData,
  { now = Date.now }: Pick<ConversationServiceOptions, 'now'> = {},
): Conversation => {
  const project = requireProject(db, projectId);
  return toConversation(
    updateConversation(db, {
      scope: { projectId: project.id, conversationId },
      input: request,
      now: now(),
    }),
  );
};

/**
 * Saves an operator note. It is stored only: no agent is started and no reply is produced. A
 * repeated request returns the stored note with `created: false`.
 */
export const addProjectConversationNote = (
  db: Database,
  projectId: string,
  conversationId: string,
  request: AddConversationMessageRequest,
  { now = Date.now, createId = randomUUID }: ConversationServiceOptions = {},
): { message: ConversationMessage; created: boolean } => {
  const project = requireProject(db, projectId);
  const { message, created } = addConversationNote(db, {
    scope: { projectId: project.id, conversationId },
    id: createId(),
    input: request,
    now: now(),
  });
  return { message: toMessage(message), created };
};

/**
 * Stores a chat message and a queued turn; the worker produces the reply. Returns at once and
 * starts no process. A repeated request returns the stored message and turn (`created: false`).
 */
export const sendProjectConversationMessage = (
  db: Database,
  projectId: string,
  conversationId: string,
  request: SendConversationMessageRequest,
  { now = Date.now, createId = randomUUID }: ConversationServiceOptions = {},
): { message: ConversationMessage; turn: ConversationTurnView; created: boolean } => {
  const project = requireProject(db, projectId);
  const { message, turn, created } = sendConversationMessage(db, {
    scope: { projectId: project.id, conversationId },
    messageId: createId(),
    turnId: createId(),
    input: request,
    now: now(),
  });
  const available = new Set(
    listConversationMessages(db, { projectId, conversationId })?.map((message) => message.id),
  );
  return { message: toMessage(message), turn: toTurnView(turn, available), created };
};

/** Records Stop for a turn of this conversation; the worker terminates the CLI. */
export const stopProjectConversationTurn = (
  db: Database,
  projectId: string,
  conversationId: string,
  turnId: string,
  { now = Date.now }: Pick<ConversationServiceOptions, 'now'> = {},
): ConversationTurnView => {
  const project = requireProject(db, projectId);
  const available = new Set(
    listConversationMessages(db, { projectId, conversationId })?.map((message) => message.id),
  );
  return toTurnView(
    requestConversationTurnStop(db, {
      scope: { projectId: project.id, conversationId },
      turnId,
      now: now(),
    }),
    available,
  );
};

/** Queues a new turn for the message of the latest failed, stopped or interrupted turn. */
export const retryProjectConversationTurn = (
  db: Database,
  projectId: string,
  conversationId: string,
  turnId: string,
  request: { requestId: string },
  { now = Date.now, createId = randomUUID }: ConversationServiceOptions = {},
): { turn: ConversationTurnView; created: boolean } => {
  const project = requireProject(db, projectId);
  const { turn, created } = retryConversationTurn(db, {
    scope: { projectId: project.id, conversationId },
    turnId,
    newTurnId: createId(),
    input: request,
    now: now(),
  });
  const available = new Set(
    listConversationMessages(db, { projectId, conversationId })?.map((message) => message.id),
  );
  return { turn: toTurnView(turn, available), created };
};

export const getConversationSettings = (db: Database): ConversationSettingsView => {
  const consent = getConversationConsent(db);
  return {
    disclosure: {
      version: conversationDisclosure.version,
      title: conversationDisclosure.title,
      statements: [...conversationDisclosure.statements],
    },
    enabled: consent.enabled,
    acceptedDisclosureVersion: consent.disclosureVersion,
    acceptedAt: consent.acceptedAt,
    current: consent.enabled && consent.disclosureVersion === conversationDisclosure.version,
  };
};

/** Records the operator's explicit acceptance of the AI Conversations disclosure. */
export const enableConversationAi = (
  db: Database,
  disclosureVersion: string,
  { now = Date.now }: Pick<ConversationServiceOptions, 'now'> = {},
): ConversationSettingsView => {
  acceptConversationDisclosure(db, { input: { disclosureVersion }, now: now() });
  return getConversationSettings(db);
};

/** Turns AI replies off; running turns are not stopped (use Stop). */
export const disableConversationAiReplies = (
  db: Database,
  { now = Date.now }: Pick<ConversationServiceOptions, 'now'> = {},
): ConversationSettingsView => {
  disableConversationAi(db, { now: now() });
  return getConversationSettings(db);
};

export const updateProjectConversationNote = (
  db: Database,
  projectId: string,
  conversationId: string,
  noteId: string,
  input: UpdateConversationNoteInput,
  { now = Date.now }: Pick<ConversationServiceOptions, 'now'> = {},
): ConversationMessage => {
  requireProject(db, projectId);
  return toMessage(
    updateConversationNote(db, { scope: { projectId, conversationId }, noteId, input, now: now() }),
  );
};

export const deleteProjectConversationNote = (
  db: Database,
  projectId: string,
  conversationId: string,
  noteId: string,
  input: ConversationNoteRevisionInput,
  { now = Date.now }: Pick<ConversationServiceOptions, 'now'> = {},
): void => {
  requireProject(db, projectId);
  deleteConversationNote(db, { scope: { projectId, conversationId }, noteId, input, now: now() });
};
