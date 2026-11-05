import {
  createTaskInputSchema,
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
import { and, asc, count, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { DatabaseConnection } from './client.js';
import { projects, tasks } from './schema.js';

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
 * Counts tasks per project and status in one grouped query (served by the `(project_id, status)`
 * index). Projects without tasks are absent from the result.
 */
export const countTasksByProjectAndStatus = (db: Database): ProjectTaskStatusCount[] =>
  db
    .select({ projectId: tasks.projectId, status: tasks.status, count: count() })
    .from(tasks)
    .groupBy(tasks.projectId, tasks.status)
    .all();

/**
 * Changes editable task fields. Content (title, prompt, runtime, model, base branch) is editable
 * only in `Backlog`; priority and the urgent flag also in `Queued`. Switching the runtime without
 * choosing a model resets the model to `Default`.
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
      if (!isTaskUpdateAllowed(current.status, parsed.data)) {
        throw new TaskError(
          'task_not_editable',
          `These fields cannot be changed while the task is ${taskStatusLabels[current.status]}.`,
          { status: current.status },
        );
      }
      const changes = resolveTaskUpdate(current, parsed.data);
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
        .where(and(eq(tasks.id, taskId), eq(tasks.status, current.status)))
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
 * `queuedAt`; returning to `Backlog` clears it. Pass a transaction to compose the transition with
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
      return updated;
    },
    { behavior: 'immediate' },
  );
};
