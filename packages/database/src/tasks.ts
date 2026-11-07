import {
  createTaskInputSchema,
  describeModelSelectionProblem,
  isTaskUpdateAllowed,
  resolveTaskTransition,
  resolveTaskUpdate,
  taskActionSchema,
  TaskError,
  taskIdSchema,
  taskStatusLabels,
  updateTaskInputSchema,
  type CreateTaskInput,
  type TaskAction,
  type TaskStatus,
  type UpdateTaskInput,
} from '@ai-agent-manager/core';
import { and, asc, count, eq, isNotNull, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { DatabaseConnection } from './client.js';
import { projects, tasks, workerCommands, workspaces } from './schema.js';

export type TaskRecord = typeof tasks.$inferSelect;

type Database = DatabaseConnection['db'];

// Task commands validate their input and enforce the lifecycle themselves, so every caller (web
// routes, worker, future conversations) gets the same rules. Each command runs in one IMMEDIATE
// transaction: the status it checks is the status it changes, even across processes.

const invalidInput = (error: z.ZodError): TaskError =>
  new TaskError('invalid_task_input', error.issues[0]?.message ?? 'The task input is invalid.', {
    issues: error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
  });

const taskNotFound = (): TaskError => new TaskError('task_not_found', 'The task does not exist.');

const parseTaskId = (id: string): string => {
  const parsed = taskIdSchema.safeParse(id);
  if (!parsed.success) {
    throw taskNotFound();
  }
  return parsed.data;
};

const findTask = (db: Database, id: string): TaskRecord | undefined =>
  db.select().from(tasks).where(eq(tasks.id, id)).get();

/**
 * Transitions that end a run the worker already owns. They stay possible for an archived task so a
 * run can never be left without its outcome; archiving requires that no run is active, so in
 * practice they never meet an archived task.
 */
const runOutcomeActions: readonly TaskAction[] = [
  'complete_execution',
  'stop',
  'fail',
  'interrupt',
  'mark_done',
];

/** A model that does not fit the selected runtime, reported on the `modelId` field. */
const invalidModel = (message: string): TaskError =>
  new TaskError('invalid_task_input', message, { issues: [{ path: 'modelId', message }] });

const archivedError = (): TaskError =>
  new TaskError('task_archived', 'The task is archived. Restore it before changing it.');

/**
 * Creates a task in `Backlog` for an existing project. Never queues the task, starts an agent or
 * touches the repository. `id` is an application-generated UUID; `now` is Unix milliseconds.
 */
export const createTask = (
  db: Database,
  { id, input, now }: { id: string; input: CreateTaskInput; now: number },
): TaskRecord => {
  const parsedId = taskIdSchema.safeParse(id);
  if (!parsedId.success) {
    throw invalidInput(parsedId.error);
  }
  const parsed = createTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  const data = parsed.data;
  const modelProblem = describeModelSelectionProblem(data.agentRuntime, data.modelId);
  if (modelProblem !== null) {
    throw invalidModel(modelProblem);
  }

  return db.transaction(
    (tx) => {
      const project = tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, data.projectId))
        .get();
      if (project === undefined) {
        throw new TaskError('project_not_found', 'The project does not exist.');
      }
      return tx
        .insert(tasks)
        .values({
          ...data,
          id: parsedId.data,
          status: 'backlog',
          queuedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    },
    { behavior: 'immediate' },
  );
};

/** Returns the task, or `undefined` when no task has this ID. */
export const findTaskById = (db: Database, id: string): TaskRecord | undefined => {
  const parsed = taskIdSchema.safeParse(id);
  return parsed.success ? findTask(db, parsed.data) : undefined;
};

/** Lists one project's tasks in creation order. Tasks of other projects are never included. */
export const listProjectTasks = (db: Database, projectId: string): TaskRecord[] =>
  db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.createdAt), asc(tasks.id))
    .all();

export type ProjectTaskStatusCount = { projectId: string; status: TaskStatus; count: number };

/**
 * Counts active (not archived) tasks per project and status in one grouped query. Projects
 * without active tasks are absent from the result.
 */
export const countTasksByProjectAndStatus = (db: Database): ProjectTaskStatusCount[] =>
  db
    .select({ projectId: tasks.projectId, status: tasks.status, count: count() })
    .from(tasks)
    .where(isNull(tasks.archivedAt))
    .groupBy(tasks.projectId, tasks.status)
    .all();

/** Counts archived tasks per project (TM-02). Projects without archived tasks are absent. */
export const countArchivedTasksByProject = (db: Database): { projectId: string; count: number }[] =>
  db
    .select({ projectId: tasks.projectId, count: count() })
    .from(tasks)
    .where(isNotNull(tasks.archivedAt))
    .groupBy(tasks.projectId)
    .all();

/**
 * Changes editable task fields. Content (title, prompt, runtime, model, base branch) is editable
 * only in `Backlog`; priority and the urgent flag also in `Queued`. Switching the runtime without
 * choosing a model resets the model to `Default`. The base branch is fixed once the task has a
 * worktree, because later attempts continue in that worktree.
 */
export const updateTask = (
  db: Database,
  { id, input, now }: { id: string; input: UpdateTaskInput; now: number },
): TaskRecord => {
  const taskId = parseTaskId(id);
  const parsed = updateTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }

  return db.transaction(
    (tx) => {
      const current = findTask(tx, taskId);
      if (current === undefined) {
        throw taskNotFound();
      }
      if (current.archivedAt !== null) {
        throw archivedError();
      }
      if (!isTaskUpdateAllowed(current.status, parsed.data)) {
        throw new TaskError(
          'task_not_editable',
          `These fields cannot be changed while the task is ${taskStatusLabels[current.status]}.`,
          { status: current.status },
        );
      }
      if (
        parsed.data.baseBranch !== undefined &&
        parsed.data.baseBranch !== current.baseBranch &&
        tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.taskId, taskId))
          .get() !== undefined
      ) {
        // A task returned to Backlog after Request Changes, Retry or Resume keeps its worktree,
        // and the next attempt continues in it. Its base was fixed when the worktree was created,
        // so a new base branch would be stored but silently ignored.
        throw new TaskError(
          'task_not_editable',
          'The task already has a worktree, and later attempts continue in it from its original base. The base branch can no longer change.',
          { status: current.status, field: 'baseBranch' },
        );
      }
      const changes = resolveTaskUpdate(current, parsed.data);
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
        .update(tasks)
        .set({
          title: changes.title,
          prompt: changes.prompt,
          agentRuntime: changes.agentRuntime,
          modelId: changes.modelId,
          baseBranch: changes.baseBranch,
          priority: changes.priority,
          urgent: changes.urgent,
          updatedAt: now,
        })
        .where(
          and(eq(tasks.id, taskId), eq(tasks.status, current.status), isNull(tasks.archivedAt)),
        )
        .returning()
        .get();
      if (updated === undefined) {
        throw new TaskError('task_not_editable', 'The task changed. Reload it and try again.');
      }
      return updated;
    },
    { behavior: 'immediate' },
  );
};

/**
 * Applies a named lifecycle transition. Rejects actions that are not allowed from the task's
 * current status with `illegal_transition`; nothing is changed in that case. Queueing actions set
 * `queuedAt`; returning to `Backlog` clears it and rejects a pending start request, so a later
 * Queue never inherits an old Start. Pass a transaction to compose the transition with
 * other writes (for example a run claim) atomically.
 */
export const transitionTask = (
  db: Database,
  { id, action, now }: { id: string; action: TaskAction; now: number },
): TaskRecord => {
  const taskId = parseTaskId(id);
  const parsedAction = taskActionSchema.safeParse(action);
  if (!parsedAction.success) {
    throw invalidInput(parsedAction.error);
  }

  return db.transaction(
    (tx) => {
      const current = findTask(tx, taskId);
      if (current === undefined) {
        throw taskNotFound();
      }
      // An archived task accepts no lifecycle action until it is restored (TM-02).
      if (current.archivedAt !== null && !runOutcomeActions.includes(parsedAction.data)) {
        throw archivedError();
      }
      const to = resolveTaskTransition(parsedAction.data, current.status);
      if (to === undefined) {
        throw new TaskError(
          'illegal_transition',
          `The task cannot ${parsedAction.data.replaceAll('_', ' ')} while it is ${taskStatusLabels[current.status]}.`,
          { action: parsedAction.data, status: current.status },
        );
      }
      const queuedAt = to === 'queued' ? now : to === 'backlog' ? null : current.queuedAt;
      const updated = tx
        .update(tasks)
        .set({ status: to, queuedAt, updatedAt: now })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, current.status)))
        .returning()
        .get();
      if (updated === undefined) {
        throw new TaskError('illegal_transition', 'The task changed. Reload it and try again.', {
          action: parsedAction.data,
          status: current.status,
        });
      }
      if (to === 'backlog') {
        // Withdrawing a task also withdraws its pending start request. Otherwise a request left
        // by a stopped worker would run the task after it is queued again, without a new Start.
        tx.update(workerCommands)
          .set({
            status: 'rejected',
            resultCode: 'task_not_queued',
            resultMessage: 'The task was returned to Backlog before the worker started it.',
            processedAt: now,
          })
          .where(and(eq(workerCommands.taskId, taskId), eq(workerCommands.status, 'pending')))
          .run();
      }
      return updated;
    },
    { behavior: 'immediate' },
  );
};
