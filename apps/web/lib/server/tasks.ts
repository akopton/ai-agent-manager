import { randomUUID } from 'node:crypto';
import {
  projectIdSchema,
  TaskError,
  type Task,
  type TaskAction,
  type UpdateTaskData,
} from '@ai-agent-manager/core';
import {
  countArchivedTasksByProject,
  countTasksByProjectAndStatus,
  createTask,
  findProjectById,
  findTaskById,
  listProjectTasks,
  transitionTask,
  updateTask,
  type DatabaseConnection,
  type ProjectRecord,
  type TaskRecord,
} from '@ai-agent-manager/database';
import type { UserTaskAction } from '@/lib/tasks/actions';
import { emptyTaskCounts, type ProjectTaskCounts } from '@/lib/tasks/board';
import type { CreateProjectTaskData } from '@/lib/tasks/contracts';
import { assertRegisteredBranch } from '@/lib/server/projects';

// Project-scoped task commands for the web app. Every lookup resolves the project from the route
// first and rejects tasks of other projects as missing. All writes go through the validated task
// commands in `@ai-agent-manager/database`, which enforce the lifecycle. Nothing here launches an
// agent, creates a worktree or writes to the repository; a base branch override is only checked
// with read-only Git queries against the stored repository path.

type Database = DatabaseConnection['db'];

const projectNotFound = (): TaskError =>
  new TaskError('project_not_found', 'The project does not exist.');

const taskNotFound = (): TaskError => new TaskError('task_not_found', 'The task does not exist.');

const toTask = (record: TaskRecord): Task => ({ ...record });

/** Returns the project record, or throws `project_not_found` for unknown or malformed IDs. */
const requireProject = (db: Database, projectId: string): ProjectRecord => {
  const parsed = projectIdSchema.safeParse(projectId);
  const record = parsed.success ? findProjectById(db, parsed.data) : undefined;
  if (record === undefined) {
    throw projectNotFound();
  }
  return record;
};

/** A task of this project. A task of another project is reported as missing, never returned. */
const requireProjectTask = (db: Database, project: ProjectRecord, taskId: string): TaskRecord => {
  const task = findTaskById(db, taskId);
  if (task === undefined || task.projectId !== project.id) {
    throw taskNotFound();
  }
  return task;
};

export type ProjectBoard = {
  project: Pick<ProjectRecord, 'id' | 'name' | 'defaultBaseBranch'>;
  tasks: Task[];
};

/**
 * The project's tasks in creation order, archived ones included (the board page splits them).
 * Returns `undefined` when the project does not exist.
 */
export const getProjectBoard = (db: Database, projectId: string): ProjectBoard | undefined => {
  const parsed = projectIdSchema.safeParse(projectId);
  const record = parsed.success ? findProjectById(db, parsed.data) : undefined;
  if (record === undefined) {
    return undefined;
  }
  return {
    project: { id: record.id, name: record.name, defaultBaseBranch: record.defaultBaseBranch },
    tasks: listProjectTasks(db, record.id).map(toTask),
  };
};

export const listTasks = (db: Database, projectId: string): Task[] =>
  listProjectTasks(db, requireProject(db, projectId).id).map(toTask);

export const getTask = (db: Database, projectId: string, taskId: string): Task =>
  toTask(requireProjectTask(db, requireProject(db, projectId), taskId));

export type ProjectTask = { project: ProjectBoard['project']; task: Task };

/** The task with its project, or `undefined` for an unknown project or a task of another project. */
export const findProjectTask = (
  db: Database,
  projectId: string,
  taskId: string,
): ProjectTask | undefined => {
  const parsed = projectIdSchema.safeParse(projectId);
  const project = parsed.success ? findProjectById(db, parsed.data) : undefined;
  const task = project === undefined ? undefined : findTaskById(db, taskId);
  if (project === undefined || task === undefined || task.projectId !== project.id) {
    return undefined;
  }
  return {
    project: { id: project.id, name: project.name, defaultBaseBranch: project.defaultBaseBranch },
    task: toTask(task),
  };
};

/**
 * Active task counts per project and status for the project library, plus archived task counts
 * (TM-02). Archived tasks are not part of `total` or `byStatus`.
 */
export const countProjectTasks = (db: Database): Map<string, ProjectTaskCounts> => {
  const counts = new Map<string, ProjectTaskCounts>();
  for (const { projectId, status, count } of countTasksByProjectAndStatus(db)) {
    const entry = counts.get(projectId) ?? emptyTaskCounts();
    entry.byStatus[status] = count;
    entry.total += count;
    counts.set(projectId, entry);
  }
  for (const { projectId, count } of countArchivedTasksByProject(db)) {
    const entry = counts.get(projectId) ?? emptyTaskCounts();
    entry.archived = count;
    counts.set(projectId, entry);
  }
  return counts;
};

export type TaskServiceOptions = { now?: () => number; createId?: () => string };

/**
 * Creates a task in `Backlog`. An explicit base branch must exist in the registered repository;
 * `null` keeps the project default, which is resolved when the task first starts.
 */
export const createProjectTask = async (
  db: Database,
  projectId: string,
  request: CreateProjectTaskData,
  { now = Date.now, createId = randomUUID }: TaskServiceOptions = {},
): Promise<Task> => {
  const project = requireProject(db, projectId);
  if (request.baseBranch !== null) {
    await assertRegisteredBranch(project, request.baseBranch);
  }
  return toTask(
    createTask(db, { id: createId(), input: { ...request, projectId: project.id }, now: now() }),
  );
};

/**
 * Edits a task of this project. The domain decides which fields may change in the current status.
 * A changed explicit base branch must exist in the registered repository.
 */
export const updateProjectTask = async (
  db: Database,
  projectId: string,
  taskId: string,
  request: UpdateTaskData,
  { now = Date.now }: Pick<TaskServiceOptions, 'now'> = {},
): Promise<Task> => {
  const project = requireProject(db, projectId);
  const current = requireProjectTask(db, project, taskId);
  if (
    request.baseBranch !== undefined &&
    request.baseBranch !== null &&
    request.baseBranch !== current.baseBranch
  ) {
    await assertRegisteredBranch(project, request.baseBranch);
  }
  return toTask(updateTask(db, { id: current.id, input: request, now: now() }));
};

/**
 * Applies one of the user-facing transitions (`queue`, `return_to_backlog`) to a task of this
 * project. Illegal transitions are rejected by the domain without changing anything.
 */
export const transitionProjectTask = (
  db: Database,
  projectId: string,
  taskId: string,
  action: UserTaskAction,
  { now = Date.now }: Pick<TaskServiceOptions, 'now'> = {},
): Task => {
  const project = requireProject(db, projectId);
  const current = requireProjectTask(db, project, taskId);
  const domainAction: TaskAction = action;
  return toTask(transitionTask(db, { id: current.id, action: domainAction, now: now() }));
};
