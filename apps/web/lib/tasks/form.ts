import { modelValueProblem } from '@/lib/models/model-selection';
import {
  taskPriorityDefault,
  type AgentRuntime,
  type Task,
  type TaskPriority,
  type UpdateTaskInput,
} from '@ai-agent-manager/core';
import type { TaskEditability } from '@/lib/tasks/actions';
import {
  createProjectTaskRequestSchema,
  type CreateProjectTaskData,
  type CreateProjectTaskRequest,
} from '@/lib/tasks/contracts';

// Form state for creating and editing tasks. Kept free of React so it can be tested directly. The
// values are validated with the same domain schema the server uses; the server validates again.

/** Value of the model field that means `Default` (no model override). */
export const defaultModel = '';

/** Value of the base branch select that means "the project's default base branch". */
export const projectDefaultBranch = '';

export type TaskFormValues = {
  title: string;
  prompt: string;
  agentRuntime: AgentRuntime;
  /** An explicit model identifier, or `defaultModel`. */
  modelId: string;
  /** A branch name, or `projectDefaultBranch`. */
  baseBranch: string;
  priority: TaskPriority;
  urgent: boolean;
};

export type TaskFormField = keyof TaskFormValues;

export type TaskFieldErrors = Partial<Record<TaskFormField, string>>;

export const newTaskFormValues = (): TaskFormValues => ({
  title: '',
  prompt: '',
  agentRuntime: 'claude',
  modelId: defaultModel,
  baseBranch: projectDefaultBranch,
  priority: taskPriorityDefault,
  urgent: false,
});

export const taskFormValuesFromTask = (task: Task): TaskFormValues => ({
  title: task.title,
  prompt: task.prompt,
  agentRuntime: task.agentRuntime,
  modelId: task.modelId ?? defaultModel,
  baseBranch: task.baseBranch ?? projectDefaultBranch,
  priority: task.priority,
  urgent: task.urgent,
});

/**
 * Switching the runtime resets the model to `Default` (`SPEC.md` §5): a model identifier meant for
 * one CLI is never silently passed to the other.
 */
export const changeRuntime = (
  values: TaskFormValues,
  agentRuntime: AgentRuntime,
): TaskFormValues =>
  agentRuntime === values.agentRuntime
    ? values
    : { ...values, agentRuntime, modelId: defaultModel };

const toRequest = (values: TaskFormValues): CreateProjectTaskRequest => ({
  title: values.title,
  prompt: values.prompt,
  agentRuntime: values.agentRuntime,
  modelId: values.modelId.trim() === defaultModel ? null : values.modelId,
  baseBranch: values.baseBranch === projectDefaultBranch ? null : values.baseBranch,
  priority: values.priority,
  urgent: values.urgent,
});

const taskFormFields = new Set<string>([
  'title',
  'prompt',
  'agentRuntime',
  'modelId',
  'baseBranch',
  'priority',
  'urgent',
]);

export const isTaskFormField = (key: string): key is TaskFormField => taskFormFields.has(key);

type Validated = { ok: true; data: CreateProjectTaskData } | { ok: false; fields: TaskFieldErrors };

const validate = (values: TaskFormValues): Validated => {
  const parsed = createProjectTaskRequestSchema.safeParse(toRequest(values));
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const fields: TaskFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (isTaskFormField(key) && fields[key] === undefined) {
      fields[key] = issue.message;
    }
  }
  return { ok: false, fields };
};

export type CreateTaskFormResult =
  { ok: true; request: CreateProjectTaskData } | { ok: false; fields: TaskFieldErrors };

/** The model must fit the selected runtime (same rule as the server). */
const modelFields = (data: CreateProjectTaskData): TaskFieldErrors | null => {
  const problem = modelValueProblem(data.agentRuntime, data.modelId ?? '');
  return problem === null ? null : { modelId: problem };
};

/** Validates the form for a new task. */
export const buildCreateTaskRequest = (values: TaskFormValues): CreateTaskFormResult => {
  const result = validate(values);
  if (!result.ok) {
    return result;
  }
  const fields = modelFields(result.data);
  return fields === null ? { ok: true, request: result.data } : { ok: false, fields };
};

export type TaskUpdateResult =
  { ok: true; update: UpdateTaskInput | null } | { ok: false; fields: TaskFieldErrors };

/**
 * Validates the form and returns only the editable fields that differ from `task`
 * (`update: null` when nothing changed). Fields the domain does not allow to change in the task's
 * status are never sent.
 */
export const buildTaskUpdate = (
  task: Task,
  values: TaskFormValues,
  editability: TaskEditability,
): TaskUpdateResult => {
  // Locked fields keep their stored values, so they can neither fail validation nor be sent.
  const effective: TaskFormValues = {
    ...taskFormValuesFromTask(task),
    ...(editability.content
      ? {
          title: values.title,
          prompt: values.prompt,
          agentRuntime: values.agentRuntime,
          modelId: values.modelId,
          baseBranch: values.baseBranch,
        }
      : {}),
    ...(editability.priority ? { priority: values.priority, urgent: values.urgent } : {}),
  };
  const result = validate(effective);
  if (!result.ok) {
    return result;
  }
  const { data } = result;
  // Checked only when the runtime or model changes, so a stored custom ID stays editable.
  if (data.agentRuntime !== task.agentRuntime || data.modelId !== task.modelId) {
    const fields = modelFields(data);
    if (fields !== null) {
      return { ok: false, fields };
    }
  }
  const update: UpdateTaskInput = {
    ...(data.title === task.title ? {} : { title: data.title }),
    ...(data.prompt === task.prompt ? {} : { prompt: data.prompt }),
    ...(data.agentRuntime === task.agentRuntime ? {} : { agentRuntime: data.agentRuntime }),
    ...(data.modelId === task.modelId ? {} : { modelId: data.modelId }),
    ...(data.baseBranch === task.baseBranch ? {} : { baseBranch: data.baseBranch }),
    ...(data.priority === task.priority ? {} : { priority: data.priority }),
    ...(data.urgent === task.urgent ? {} : { urgent: data.urgent }),
  };
  return { ok: true, update: Object.keys(update).length === 0 ? null : update };
};
