import { randomUUID } from 'node:crypto';
import {
  ConversationError,
  projectIdSchema,
  type Conversation,
  type ConversationMessage,
  type UpdateConversationData,
} from '@ai-agent-manager/core';
import {
  addConversationNote,
  countConversationsByProject,
  createConversation,
  findProjectById,
  findProjectConversation,
  listConversationMessages,
  listProjectConversations,
  updateConversation,
  type ConversationMessageRecord,
  type ConversationRecord,
  type DatabaseConnection,
  type ProjectRecord,
} from '@ai-agent-manager/database';
import type {
  AddConversationMessageRequest,
  ConversationSummary,
  CreateProjectConversationRequest,
} from '@/lib/conversations/contracts';

// Project-scoped conversation commands for the web app (C1). Every lookup resolves the project
// from the route first and treats a conversation of another project as missing. Writes go through
// the validated commands in `@ai-agent-manager/database`. Nothing here launches an agent, writes
// a worker command, creates or changes a task, or reads or writes a repository.

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
}: ConversationMessageRecord): ConversationMessage => ({
  id,
  conversationId,
  sequence,
  role,
  kind,
  content,
  createdAt,
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
  project: ConversationProject;
  conversation: Conversation;
  messages: ConversationMessage[];
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
  if (conversation === undefined || messages === undefined) {
    return undefined;
  }
  return {
    project: { id: project.id, name: project.name },
    conversation: toConversation(conversation),
    messages: messages.map(toMessage),
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
