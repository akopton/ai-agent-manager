import {
  ConversationError,
  describeModelSelectionProblem,
  resolveTaskProposalUpdate,
  taskIdSchema,
  taskProposalActionInputSchema,
  taskProposalIdSchema,
  updateTaskProposalInputSchema,
  type TaskProposalActionInput,
  type UpdateTaskProposalInput,
} from '@ai-agent-manager/core';
import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { DatabaseConnection } from './client.js';
import { findScoped, parseScope, type Scope, type Transaction } from './conversations.js';
import { taskProposalGenerations, taskProposals } from './schema.js';
import type { TaskProposalRecord } from './task-proposal-generations.js';
import { createTask, findTaskById, type TaskRecord } from './tasks.js';

// C3 — operator commands on task proposals: edit, reject, reopen and approve. Each runs in one
// IMMEDIATE transaction and is scoped by project **and** conversation, so another project's
// proposal is reported as missing. Approval is the only path from a proposal to a task: it calls
// the same `createTask` command as manual task creation, inside the same transaction as the
// proposal's status change, so it creates exactly one `Backlog` task or nothing. Nothing here
// queues, starts or transitions a task, writes a worker command, creates a worktree or runs Git.

type Database = DatabaseConnection['db'];

const immediate = { behavior: 'immediate' } as const;

const invalidInput = (error: z.ZodError): ConversationError =>
  new ConversationError(
    'invalid_conversation_input',
    error.issues[0]?.message ?? 'The input is invalid.',
    { issues: error.issues.map(({ path, message }) => ({ path: path.join('.'), message })) },
  );

const conversationNotFound = (): ConversationError =>
  new ConversationError('conversation_not_found', 'The conversation does not exist.');

const proposalNotFound = (): ConversationError =>
  new ConversationError('task_proposal_not_found', 'The task proposal does not exist.');

const proposalChanged = (revision: number): ConversationError =>
  new ConversationError(
    'task_proposal_changed',
    'The proposal changed in the meantime. Reload the page and review it again.',
    { revision },
  );

const notEditable = (proposal: TaskProposalRecord, message: string): ConversationError =>
  new ConversationError('task_proposal_not_editable', message, { status: proposal.status });

/** A model that does not fit the selected runtime, reported on the `modelId` field. */
const invalidModel = (message: string): ConversationError =>
  new ConversationError('invalid_conversation_input', message, {
    issues: [{ path: 'modelId', message }],
  });

/** The proposal, scoped by project and conversation; anything else is reported as missing. */
const findProposalScoped = (
  tx: Database | Transaction,
  scope: Scope,
  proposalId: string,
): TaskProposalRecord => {
  const conversation = findScoped(tx, parseScope(scope));
  if (conversation === undefined) {
    throw conversationNotFound();
  }
  const parsed = taskProposalIdSchema.safeParse(proposalId);
  const proposal = parsed.success
    ? tx
        .select()
        .from(taskProposals)
        .where(
          and(
            eq(taskProposals.id, parsed.data),
            eq(taskProposals.conversationId, conversation.id),
            eq(taskProposals.projectId, conversation.projectId),
          ),
        )
        .get()
    : undefined;
  if (proposal === undefined) {
    throw proposalNotFound();
  }
  return proposal;
};

/** Writes a status or field change guarded by the revision the command checked. */
const writeGuarded = (
  tx: Transaction,
  proposal: TaskProposalRecord,
  values: Partial<TaskProposalRecord>,
  now: number,
): TaskProposalRecord => {
  const updated = tx
    .update(taskProposals)
    .set({ ...values, revision: proposal.revision + 1, updatedAt: now })
    .where(and(eq(taskProposals.id, proposal.id), eq(taskProposals.revision, proposal.revision)))
    .returning()
    .get();
  if (updated === undefined) {
    throw proposalChanged(proposal.revision);
  }
  return updated;
};

/**
 * The conversation's proposals in a stable order (generation, then the AI's order), or
 * `undefined` for a conversation that does not belong to the project.
 */
export const listTaskProposals = (db: Database, scope: Scope): TaskProposalRecord[] | undefined => {
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
    .select({ proposal: taskProposals })
    .from(taskProposals)
    .innerJoin(taskProposalGenerations, eq(taskProposalGenerations.id, taskProposals.generationId))
    .where(
      and(
        eq(taskProposals.conversationId, conversation.id),
        eq(taskProposals.projectId, conversation.projectId),
      ),
    )
    .orderBy(
      asc(taskProposalGenerations.createdAt),
      asc(taskProposalGenerations.id),
      asc(taskProposals.position),
    )
    .all()
    .map(({ proposal }) => proposal);
};

export const findTaskProposal = (
  db: Database,
  { scope, proposalId }: { scope: Scope; proposalId: string },
): TaskProposalRecord => findProposalScoped(db, scope, proposalId);

/** The proposal whose approval created this task, if any (the task's origin reference). */
export const findTaskProposalByTask = (
  db: Database,
  taskId: string,
): TaskProposalRecord | undefined => {
  const parsed = taskIdSchema.safeParse(taskId);
  return parsed.success
    ? db.select().from(taskProposals).where(eq(taskProposals.taskId, parsed.data)).get()
    : undefined;
};

/**
 * Edits a draft. Only drafts change; the AI's suggested values (`suggested_*`) never do. The
 * revision must match, so a stale editor never overwrites newer edits. Switching the runtime
 * without a model resets the model to `Default`; a model listed for the other runtime is refused.
 */
export const updateTaskProposal = (
  db: Database,
  {
    scope,
    proposalId,
    input,
    now,
  }: { scope: Scope; proposalId: string; input: UpdateTaskProposalInput; now: number },
): TaskProposalRecord => {
  const parsed = updateTaskProposalInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  return db.transaction((tx) => {
    const current = findProposalScoped(tx, scope, proposalId);
    if (current.status !== 'draft') {
      throw notEditable(
        current,
        current.status === 'approved'
          ? 'This proposal is approved; its task is on the board. Edit the task instead.'
          : 'This proposal is rejected. Reopen it before editing.',
      );
    }
    if (current.revision !== parsed.data.revision) {
      throw proposalChanged(current.revision);
    }
    const changes = resolveTaskProposalUpdate(current, parsed.data);
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
    return writeGuarded(
      tx,
      current,
      {
        title: changes.title,
        prompt: changes.prompt,
        agentRuntime: changes.agentRuntime,
        modelId: changes.modelId,
        priority: changes.priority,
        baseBranch: changes.baseBranch,
      },
      now,
    );
  }, immediate);
};

const parseAction = (input: TaskProposalActionInput): number => {
  const parsed = taskProposalActionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  return parsed.data.revision;
};

/** Rejects a draft. Repeating it is harmless; an approved proposal cannot be rejected. */
export const rejectTaskProposal = (
  db: Database,
  {
    scope,
    proposalId,
    input,
    now,
  }: { scope: Scope; proposalId: string; input: TaskProposalActionInput; now: number },
): TaskProposalRecord => {
  const revision = parseAction(input);
  return db.transaction((tx) => {
    const current = findProposalScoped(tx, scope, proposalId);
    if (current.status === 'rejected') {
      return current;
    }
    if (current.status === 'approved') {
      throw notEditable(current, 'This proposal is already approved and cannot be rejected.');
    }
    if (current.revision !== revision) {
      throw proposalChanged(current.revision);
    }
    return writeGuarded(tx, current, { status: 'rejected', rejectedAt: now }, now);
  }, immediate);
};

/** Reopens a rejected proposal as a draft (the deliberate way back). Repeating it is harmless. */
export const reopenTaskProposal = (
  db: Database,
  {
    scope,
    proposalId,
    input,
    now,
  }: { scope: Scope; proposalId: string; input: TaskProposalActionInput; now: number },
): TaskProposalRecord => {
  const revision = parseAction(input);
  return db.transaction((tx) => {
    const current = findProposalScoped(tx, scope, proposalId);
    if (current.status === 'draft') {
      return current;
    }
    if (current.status === 'approved') {
      throw notEditable(current, 'This proposal is approved; its task is on the board.');
    }
    if (current.revision !== revision) {
      throw proposalChanged(current.revision);
    }
    return writeGuarded(tx, current, { status: 'draft', rejectedAt: null }, now);
  }, immediate);
};

export type ApproveTaskProposalResult = {
  proposal: TaskProposalRecord;
  task: TaskRecord;
  /** `false` when the proposal was already approved and its existing task is returned. */
  created: boolean;
};

/**
 * Approves a draft into the project's Backlog. In one IMMEDIATE transaction it creates exactly
 * one task with the proposal's current values through `createTask` (the manual task creation
 * command, with all its validation; the task starts in `Backlog`), and marks the proposal
 * approved with the task's ID. Any failure rolls back both. Repeating an approval returns the
 * existing task (`created: false`) and never creates another one. A rejected proposal must be
 * reopened first; a stale revision is refused. Never queues or starts the task.
 */
export const approveTaskProposal = (
  db: Database,
  {
    scope,
    proposalId,
    taskId,
    input,
    now,
  }: {
    scope: Scope;
    proposalId: string;
    taskId: string;
    input: TaskProposalActionInput;
    now: number;
  },
): ApproveTaskProposalResult => {
  const revision = parseAction(input);
  return db.transaction((tx) => {
    const current = findProposalScoped(tx, scope, proposalId);
    if (current.status === 'approved') {
      const existing = current.taskId === null ? undefined : findTaskById(tx, current.taskId);
      if (existing === undefined) {
        throw new Error(`Approved proposal ${current.id} has no task.`);
      }
      return { proposal: current, task: existing, created: false };
    }
    if (current.status === 'rejected') {
      throw notEditable(current, 'This proposal is rejected. Reopen it before approving.');
    }
    if (current.revision !== revision) {
      throw proposalChanged(current.revision);
    }
    // The manual creation command: same validation, same Backlog start. `projectId` comes from
    // the stored proposal, never from the request, so approval cannot target another project.
    const task = createTask(tx, {
      id: taskId,
      input: {
        projectId: current.projectId,
        title: current.title,
        prompt: current.prompt,
        agentRuntime: current.agentRuntime,
        modelId: current.modelId,
        baseBranch: current.baseBranch,
        priority: current.priority,
        urgent: false,
      },
      now,
    });
    const proposal = writeGuarded(
      tx,
      current,
      { status: 'approved', taskId: task.id, approvedAt: now },
      now,
    );
    return { proposal, task, created: true };
  }, immediate);
};
