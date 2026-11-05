import { z } from 'zod';
import { agentRuntimeSchema, modelSelectionSchema } from './agent-runtime.js';
import { projectBranchNameSchema, projectIdSchema } from './project.js';

export const taskIdSchema = z.uuid();

export type TaskId = z.infer<typeof taskIdSchema>;

/**
 * Product-level task states (`SPEC.md` §7, `ARCHITECTURE.md` §5.1). Stored identifiers are
 * snake_case; `taskStatusLabels` holds the documented display names. A task's status is separate
 * from the status of its individual runs and from its publishing state (`ARCHITECTURE.md` §5.2).
 */
export const taskStatuses = [
  'backlog',
  'queued',
  'in_progress',
  'review',
  'done',
  'stopped',
  'interrupted',
  'failed',
  'discarded',
] as const;

export const taskStatusSchema = z.enum(taskStatuses);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskStatusLabels: Readonly<Record<TaskStatus, string>> = {
  backlog: 'Backlog',
  queued: 'Queued',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  failed: 'Failed',
  discarded: 'Discarded',
};

/** Task priority (`SPEC.md` §5). `Urgent` is a separate flag that overrides normal ordering. */
export const taskPriorities = ['critical', 'high', 'normal', 'low'] as const;

export const taskPrioritySchema = z.enum(taskPriorities);

export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const taskPriorityDefault: TaskPriority = 'normal';

export const taskPriorityLabels: Readonly<Record<TaskPriority, string>> = {
  critical: 'Critical',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export const taskTitleMaxLength = 200;

export const taskTitleSchema = z
  .string()
  .trim()
  .min(1, 'Enter a task title.')
  .max(taskTitleMaxLength, `Use at most ${taskTitleMaxLength} characters.`);

export const taskPromptMaxLength = 50_000;

/** The task description sent to the agent together with global and project instructions. */
export const taskPromptSchema = z
  .string()
  .trim()
  .min(1, 'Enter the task prompt.')
  .max(taskPromptMaxLength, `Use at most ${taskPromptMaxLength.toLocaleString('en')} characters.`);

/**
 * Optional base branch override. `null` means the project's default base branch, resolved when
 * the task first starts. Shape check only: the branch must also exist in the repository.
 */
export const taskBaseBranchSchema = projectBranchNameSchema.nullable();

/**
 * A new task. It always starts in `Backlog`: saving a task never queues it, launches an agent or
 * creates a worktree (`SPEC.md` §5). `modelId: null` means `Default`.
 */
export const createTaskInputSchema = z.strictObject({
  projectId: projectIdSchema,
  title: taskTitleSchema,
  prompt: taskPromptSchema,
  agentRuntime: agentRuntimeSchema,
  modelId: modelSelectionSchema.default(null),
  baseBranch: taskBaseBranchSchema.default(null),
  priority: taskPrioritySchema.default(taskPriorityDefault),
  urgent: z.boolean().default(false),
});

export type CreateTaskInput = z.input<typeof createTaskInputSchema>;

export type CreateTaskData = z.output<typeof createTaskInputSchema>;

/**
 * Partial update of a task's editable fields. The project and status are never edited here:
 * status changes only through named transitions (`taskTransitions`).
 */
export const updateTaskInputSchema = z
  .strictObject({
    title: taskTitleSchema.optional(),
    prompt: taskPromptSchema.optional(),
    agentRuntime: agentRuntimeSchema.optional(),
    modelId: modelSelectionSchema.optional(),
    baseBranch: taskBaseBranchSchema.optional(),
    priority: taskPrioritySchema.optional(),
    urgent: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Change at least one field.',
  });

export type UpdateTaskInput = z.input<typeof updateTaskInputSchema>;

export type UpdateTaskData = z.output<typeof updateTaskInputSchema>;

/** A stored task. Timestamps are Unix milliseconds. */
export const taskSchema = z.object({
  id: taskIdSchema,
  projectId: projectIdSchema,
  title: z.string(),
  prompt: z.string(),
  agentRuntime: agentRuntimeSchema,
  modelId: z.string().nullable(),
  baseBranch: z.string().nullable(),
  priority: taskPrioritySchema,
  urgent: z.boolean(),
  status: taskStatusSchema,
  /** When the task last entered `Queued`; `null` until queued and after a return to `Backlog`. */
  queuedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export type Task = z.infer<typeof taskSchema>;

/**
 * Named task transitions (`ARCHITECTURE.md` §5.1). Every status change goes through one of these;
 * a status is never set directly.
 *
 * - `queue`: explicit user action; makes the task eligible for the scheduler.
 * - `return_to_backlog`: the user withdraws a queued task.
 * - `start`: the worker claimed the task and reserved capacity.
 * - `complete_execution`: the run ended and its changes await review, even if nothing changed.
 * - `stop`: the user's stop was confirmed after process reconciliation.
 * - `fail`: the run failed, including a launch failure after the claim.
 * - `interrupt`: the run was interrupted or could not be reconciled on restart.
 * - `request_changes`: review feedback enqueues a new run on the retained workspace.
 * - `retry`: enqueue a new attempt after a stop, interruption or failure.
 * - `resume`: enqueue a continuation of the previous session; adapter support is checked by the
 *   caller, the task state machine only limits the source states.
 * - `discard`: the user rejects the result; nothing is deleted.
 * - `mark_done`: the approved changes were committed and pushed. Publishing progress and push
 *   failures are tracked as publish state while the task stays in `Review`.
 */
export const taskActions = [
  'queue',
  'return_to_backlog',
  'start',
  'complete_execution',
  'stop',
  'fail',
  'interrupt',
  'request_changes',
  'retry',
  'resume',
  'discard',
  'mark_done',
] as const;

export const taskActionSchema = z.enum(taskActions);

export type TaskAction = z.infer<typeof taskActionSchema>;

export type TaskTransitionRule = {
  readonly from: readonly TaskStatus[];
  readonly to: TaskStatus;
};

export const taskTransitions: Readonly<Record<TaskAction, TaskTransitionRule>> = {
  queue: { from: ['backlog'], to: 'queued' },
  return_to_backlog: { from: ['queued'], to: 'backlog' },
  start: { from: ['queued'], to: 'in_progress' },
  complete_execution: { from: ['in_progress'], to: 'review' },
  stop: { from: ['in_progress'], to: 'stopped' },
  fail: { from: ['in_progress'], to: 'failed' },
  interrupt: { from: ['in_progress'], to: 'interrupted' },
  request_changes: { from: ['review'], to: 'queued' },
  retry: { from: ['stopped', 'interrupted', 'failed'], to: 'queued' },
  resume: { from: ['stopped', 'interrupted'], to: 'queued' },
  discard: { from: ['review', 'stopped', 'interrupted', 'failed'], to: 'discarded' },
  mark_done: { from: ['review'], to: 'done' },
};

/** Returns the target status, or `undefined` when the action is not allowed from `from`. */
export const resolveTaskTransition = (
  action: TaskAction,
  from: TaskStatus,
): TaskStatus | undefined => {
  const rule = taskTransitions[action];
  return rule.from.includes(from) ? rule.to : undefined;
};

/** Actions that are allowed from the given status. */
export const availableTaskActions = (status: TaskStatus): TaskAction[] =>
  taskActions.filter((action) => taskTransitions[action].from.includes(status));

/** Statuses in which the title, prompt, runtime, model and base branch may change (`SPEC.md` §7). */
export const taskContentEditableStatuses: readonly TaskStatus[] = ['backlog'];

/** Statuses in which the priority and the urgent flag may change (`Reprioritize`, `SPEC.md` §7). */
export const taskPriorityEditableStatuses: readonly TaskStatus[] = ['backlog', 'queued'];

const contentFields = ['title', 'prompt', 'agentRuntime', 'modelId', 'baseBranch'] as const;

/** Whether an update with these fields is allowed while the task has the given status. */
export const isTaskUpdateAllowed = (status: TaskStatus, update: UpdateTaskData): boolean => {
  const changesContent = contentFields.some((field) => update[field] !== undefined);
  if (changesContent && !taskContentEditableStatuses.includes(status)) {
    return false;
  }
  const changesPriority = update.priority !== undefined || update.urgent !== undefined;
  return !changesPriority || taskPriorityEditableStatuses.includes(status);
};

/**
 * Applies the runtime/model rule (`SPEC.md` §5): switching the runtime without choosing a model
 * resets the model to `Default` instead of passing a model meant for the other runtime.
 */
export const resolveTaskUpdate = (
  current: Pick<Task, 'agentRuntime'>,
  update: UpdateTaskData,
): UpdateTaskData => {
  const runtimeChanged =
    update.agentRuntime !== undefined && update.agentRuntime !== current.agentRuntime;
  if (runtimeChanged && update.modelId === undefined) {
    return { ...update, modelId: null };
  }
  return update;
};

/** Expected reasons a task command is rejected. */
export const taskErrorCodes = [
  'invalid_task_input',
  'project_not_found',
  'task_not_found',
  'task_not_editable',
  'illegal_transition',
] as const;

export const taskErrorCodeSchema = z.enum(taskErrorCodes);

export type TaskErrorCode = z.infer<typeof taskErrorCodeSchema>;

/** A rejected task command. `details` holds safe, structured context such as the statuses. */
export class TaskError extends Error {
  override name = 'TaskError';

  constructor(
    readonly code: TaskErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}
