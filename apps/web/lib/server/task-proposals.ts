import { randomUUID } from 'node:crypto';
import {
  ConversationError,
  isActiveConversationTurnStatus,
  projectIdSchema,
  type TaskStatus,
} from '@ai-agent-manager/core';
import {
  approveTaskProposal,
  findProjectById,
  findTaskProposal,
  findTaskProposalGeneration,
  findTaskProposalByTask,
  listTaskProposalGenerations,
  listTaskProposals,
  rejectTaskProposal,
  reopenTaskProposal,
  requestTaskProposalGenerationStop,
  requestTaskProposals,
  retryTaskProposalGeneration,
  updateTaskProposal,
  type DatabaseConnection,
  type ProjectRecord,
  type TaskProposalGenerationRecord,
  type TaskProposalRecord,
} from '@ai-agent-manager/database';
import { z } from 'zod';
import type {
  RequestTaskProposalsRequest,
  TaskProposalGenerationView,
  TaskProposalView,
} from '@/lib/conversations/contracts';
import { assertRegisteredBranch } from '@/lib/server/projects';

// C3 — task proposal commands for the web app. Every command resolves the project from the route
// and is scoped by conversation, so another project's proposal is reported as missing. A proposal
// request only stores a queued generation (the worker runs the CLI). Approval is an explicit
// operator mutation: it creates exactly one Backlog task through the database command, which uses
// the manual task creation command. Nothing here queues or starts a task, writes a worker command,
// creates a worktree or changes the repository; an explicit base branch is only checked with
// read-only Git queries, as for manual task creation.

type Database = DatabaseConnection['db'];

export type TaskProposalServiceOptions = { now?: () => number; createId?: () => string };

const requireProject = (db: Database, projectId: string): ProjectRecord => {
  const parsed = projectIdSchema.safeParse(projectId);
  const project = parsed.success ? findProjectById(db, parsed.data) : undefined;
  if (project === undefined) {
    throw new ConversationError('project_not_found', 'The project does not exist.');
  }
  return project;
};

const manifestSchema = z.object({
  includedSequences: z.array(z.number()),
  omittedMessages: z.number(),
  notesExcluded: z.number(),
});

const parseContext = (json: string | null): TaskProposalGenerationView['context'] => {
  if (json === null) return null;
  try {
    const manifest = manifestSchema.safeParse(JSON.parse(json));
    return manifest.success
      ? {
          includedMessages: manifest.data.includedSequences.length,
          omittedMessages: manifest.data.omittedMessages,
          notesExcluded: manifest.data.notesExcluded,
        }
      : null;
  } catch {
    return null;
  }
};

/** The UI view of a generation. The prompt is never exposed. */
export const toGenerationView = (
  generation: TaskProposalGenerationRecord,
): TaskProposalGenerationView => ({
  id: generation.id,
  status: generation.status,
  active: isActiveConversationTurnStatus(generation.status),
  retryOfGenerationId: generation.retryOfGenerationId,
  agentRuntime: generation.agentRuntime,
  requestedModelId: generation.requestedModelId,
  effectiveModelId: generation.effectiveModelId,
  languageMode: generation.languageMode,
  instructions: generation.instructions,
  sourceMessageId: generation.sourceMessageId,
  basedOnSequence: generation.basedOnSequence,
  cliVersion: generation.cliVersion,
  errorCode: generation.errorCode,
  errorMessage: generation.errorMessage,
  proposalCount: generation.proposalCount,
  skippedCount: generation.skippedCount,
  note: generation.outputNote,
  context: parseContext(generation.contextManifestJson),
  createdAt: generation.createdAt,
  startedAt: generation.startedAt,
  endedAt: generation.endedAt,
  stopRequestedAt: generation.stopRequestedAt,
});

/**
 * The UI view of a proposal. The AI's suggestion (including the runtime and model it was
 * generated with) is kept apart from the operator's current values.
 */
export const toProposalView = (
  proposal: TaskProposalRecord,
  generation: Pick<TaskProposalGenerationRecord, 'agentRuntime' | 'requestedModelId'>,
): TaskProposalView => {
  const suggested = {
    title: proposal.suggestedTitle,
    prompt: proposal.suggestedPrompt,
    priority: proposal.suggestedPriority,
    agentRuntime: generation.agentRuntime,
    modelId: generation.requestedModelId,
  };
  return {
    id: proposal.id,
    projectId: proposal.projectId,
    conversationId: proposal.conversationId,
    generationId: proposal.generationId,
    position: proposal.position,
    status: proposal.status,
    title: proposal.title,
    prompt: proposal.prompt,
    agentRuntime: proposal.agentRuntime,
    modelId: proposal.modelId,
    priority: proposal.priority,
    baseBranch: proposal.baseBranch,
    suggested,
    edited:
      proposal.title !== suggested.title ||
      proposal.prompt !== suggested.prompt ||
      proposal.priority !== suggested.priority ||
      proposal.agentRuntime !== suggested.agentRuntime ||
      proposal.modelId !== suggested.modelId ||
      proposal.baseBranch !== null,
    rationale: proposal.rationale,
    dependencies: proposal.dependencies,
    revision: proposal.revision,
    taskId: proposal.taskId,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    approvedAt: proposal.approvedAt,
    rejectedAt: proposal.rejectedAt,
  };
};

export type ConversationProposals = {
  generations: TaskProposalGenerationView[];
  proposals: TaskProposalView[];
};

/**
 * Generations and proposals of the conversation, or `undefined` when the conversation does not
 * belong to the project.
 */
export const findConversationProposals = (
  db: Database,
  scope: { projectId: string; conversationId: string },
): ConversationProposals | undefined => {
  const generations = listTaskProposalGenerations(db, scope);
  const proposals = listTaskProposals(db, scope);
  if (generations === undefined || proposals === undefined) {
    return undefined;
  }
  const byId = new Map(generations.map((generation) => [generation.id, generation]));
  return {
    generations: generations.map(toGenerationView),
    proposals: proposals.flatMap((proposal) => {
      const generation = byId.get(proposal.generationId);
      return generation === undefined ? [] : [toProposalView(proposal, generation)];
    }),
  };
};

export const getConversationProposals = (
  db: Database,
  projectId: string,
  conversationId: string,
): ConversationProposals => {
  const project = requireProject(db, projectId);
  const result = findConversationProposals(db, { projectId: project.id, conversationId });
  if (result === undefined) {
    throw new ConversationError('conversation_not_found', 'The conversation does not exist.');
  }
  return result;
};

const viewOf = (
  db: Database,
  scope: { projectId: string; conversationId: string },
  proposal: TaskProposalRecord,
): TaskProposalView =>
  toProposalView(
    proposal,
    findTaskProposalGeneration(db, { scope, generationId: proposal.generationId }),
  );

/**
 * Records the operator's explicit request for task proposals; the worker runs the CLI. Returns
 * at once and starts no process. A repeat with the same `requestId` returns the stored request.
 */
export const requestProjectTaskProposals = (
  db: Database,
  projectId: string,
  conversationId: string,
  request: RequestTaskProposalsRequest,
  { now = Date.now, createId = randomUUID }: TaskProposalServiceOptions = {},
): { generation: TaskProposalGenerationView; created: boolean } => {
  const project = requireProject(db, projectId);
  const { generation, created } = requestTaskProposals(db, {
    scope: { projectId: project.id, conversationId },
    generationId: createId(),
    input: request,
    now: now(),
  });
  return { generation: toGenerationView(generation), created };
};

export const getProjectTaskProposalGeneration = (
  db: Database,
  projectId: string,
  conversationId: string,
  generationId: string,
): TaskProposalGenerationView => {
  const project = requireProject(db, projectId);
  return toGenerationView(
    findTaskProposalGeneration(db, {
      scope: { projectId: project.id, conversationId },
      generationId,
    }),
  );
};

export const stopProjectTaskProposalGeneration = (
  db: Database,
  projectId: string,
  conversationId: string,
  generationId: string,
  { now = Date.now }: Pick<TaskProposalServiceOptions, 'now'> = {},
): TaskProposalGenerationView => {
  const project = requireProject(db, projectId);
  return toGenerationView(
    requestTaskProposalGenerationStop(db, {
      scope: { projectId: project.id, conversationId },
      generationId,
      now: now(),
    }),
  );
};

export const retryProjectTaskProposalGeneration = (
  db: Database,
  projectId: string,
  conversationId: string,
  generationId: string,
  request: { requestId: string },
  { now = Date.now, createId = randomUUID }: TaskProposalServiceOptions = {},
): { generation: TaskProposalGenerationView; created: boolean } => {
  const project = requireProject(db, projectId);
  const { generation, created } = retryTaskProposalGeneration(db, {
    scope: { projectId: project.id, conversationId },
    generationId,
    newGenerationId: createId(),
    input: request,
    now: now(),
  });
  return { generation: toGenerationView(generation), created };
};

export const getProjectTaskProposal = (
  db: Database,
  projectId: string,
  conversationId: string,
  proposalId: string,
): TaskProposalView => {
  const project = requireProject(db, projectId);
  const scope = { projectId: project.id, conversationId };
  return viewOf(db, scope, findTaskProposal(db, { scope, proposalId }));
};

/**
 * Edits a draft. A newly chosen explicit base branch must exist in the registered repository
 * (read-only check, as for manual task creation).
 */
export const updateProjectTaskProposal = async (
  db: Database,
  projectId: string,
  conversationId: string,
  proposalId: string,
  request: Parameters<typeof updateTaskProposal>[1]['input'],
  { now = Date.now }: Pick<TaskProposalServiceOptions, 'now'> = {},
): Promise<TaskProposalView> => {
  const project = requireProject(db, projectId);
  const scope = { projectId: project.id, conversationId };
  const current = findTaskProposal(db, { scope, proposalId });
  if (
    current.status === 'draft' &&
    typeof request.baseBranch === 'string' &&
    request.baseBranch !== current.baseBranch
  ) {
    await assertRegisteredBranch(project, request.baseBranch);
  }
  return viewOf(
    db,
    scope,
    updateTaskProposal(db, { scope, proposalId, input: request, now: now() }),
  );
};

export const rejectProjectTaskProposal = (
  db: Database,
  projectId: string,
  conversationId: string,
  proposalId: string,
  request: { revision: number },
  { now = Date.now }: Pick<TaskProposalServiceOptions, 'now'> = {},
): TaskProposalView => {
  const project = requireProject(db, projectId);
  const scope = { projectId: project.id, conversationId };
  return viewOf(
    db,
    scope,
    rejectTaskProposal(db, { scope, proposalId, input: request, now: now() }),
  );
};

export const reopenProjectTaskProposal = (
  db: Database,
  projectId: string,
  conversationId: string,
  proposalId: string,
  request: { revision: number },
  { now = Date.now }: Pick<TaskProposalServiceOptions, 'now'> = {},
): TaskProposalView => {
  const project = requireProject(db, projectId);
  const scope = { projectId: project.id, conversationId };
  return viewOf(
    db,
    scope,
    reopenTaskProposal(db, { scope, proposalId, input: request, now: now() }),
  );
};

/**
 * Approves a draft into the project's Backlog: exactly one task, created with the proposal's
 * current values in the same transaction that marks the proposal approved. An explicit base
 * branch must still exist (read-only check). Repeating the request returns the existing task.
 * The task is never queued or started; that stays a separate operator action on the board.
 */
export const approveProjectTaskProposal = async (
  db: Database,
  projectId: string,
  conversationId: string,
  proposalId: string,
  request: { revision: number },
  { now = Date.now, createId = randomUUID }: TaskProposalServiceOptions = {},
): Promise<{
  proposal: TaskProposalView;
  task: { id: string; title: string; status: TaskStatus };
  created: boolean;
}> => {
  const project = requireProject(db, projectId);
  const scope = { projectId: project.id, conversationId };
  const current = findTaskProposal(db, { scope, proposalId });
  if (current.status === 'draft' && current.baseBranch !== null) {
    await assertRegisteredBranch(project, current.baseBranch);
  }
  const { proposal, task, created } = approveTaskProposal(db, {
    scope,
    proposalId,
    taskId: createId(),
    input: request,
    now: now(),
  });
  return {
    proposal: viewOf(db, scope, proposal),
    task: { id: task.id, title: task.title, status: task.status },
    created,
  };
};

/** The proposal (and conversation) a task was created from, for the task's origin line. */
export const findTaskOrigin = (
  db: Database,
  taskId: string,
): { conversationId: string; proposalId: string } | undefined => {
  const proposal = findTaskProposalByTask(db, taskId);
  return proposal === undefined
    ? undefined
    : { conversationId: proposal.conversationId, proposalId: proposal.id };
};
