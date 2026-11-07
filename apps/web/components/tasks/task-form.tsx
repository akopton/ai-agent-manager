'use client';

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Info, Loader2, ShieldCheck } from 'lucide-react';
import { z } from 'zod';
import {
  agentRuntimeSchema,
  agentRuntimes,
  taskPriorities,
  taskPriorityLabels,
  taskPrioritySchema,
  taskPromptMaxLength,
  taskTitleMaxLength,
  type Task,
} from '@ai-agent-manager/core';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ModelSelect } from '@/components/models/model-select';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { requestJson, type ClientError, type ClientResult } from '@/lib/projects/api-client';
import { taskEditability } from '@/lib/tasks/actions';
import { agentRuntimeLabels, taskBoardUrl, taskUrl } from '@/lib/tasks/board';
import { taskResponseSchema } from '@/lib/tasks/contracts';
import { createdTaskUrl, savedTaskUrl } from '@/lib/tasks/feedback';
import {
  buildCreateTaskRequest,
  buildTaskUpdate,
  changeRuntime,
  isTaskFormField,
  newTaskFormValues,
  projectDefaultBranch,
  taskFormValuesFromTask,
  type TaskFieldErrors,
  type TaskFormField,
  type TaskFormValues,
} from '@/lib/tasks/form';

const invalidRequestDetailsSchema = z.object({ fields: z.record(z.string(), z.string()) });

/** Moves server-side validation errors next to the field they belong to, where possible. */
const fieldErrorsFromServer = (error: ClientError): TaskFieldErrors | undefined => {
  if (error.code === 'base_branch_not_found') {
    return { baseBranch: error.message };
  }
  const details = invalidRequestDetailsSchema.safeParse(error.details);
  if (error.code !== 'invalid_request' || !details.success) {
    return undefined;
  }
  const entries = Object.entries(details.data.fields).filter(([key]) => isTaskFormField(key));
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

const FieldError = ({ id, message }: { id: string; message: string | undefined }) =>
  message === undefined ? null : (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );

type TaskFormProps = {
  project: { id: string; defaultBaseBranch: string };
  /** Live local branches, or `null` when the repository cannot be read. */
  branches: readonly string[] | null;
  /** The task being edited; omitted when creating a task. */
  task?: Task;
  /**
   * The base branch of the task's existing worktree, or `null`/omitted when it has none. Later
   * attempts continue in that worktree, so the base branch is then locked.
   */
  worktreeBaseBranch?: string | null;
};

export const TaskForm = ({ project, branches, task, worktreeBaseBranch = null }: TaskFormProps) => {
  const router = useRouter();
  const fieldId = useId();
  const initial = task === undefined ? newTaskFormValues() : taskFormValuesFromTask(task);
  const editability =
    task === undefined ? { content: true, priority: true } : taskEditability(task.status);
  const [values, setValues] = useState<TaskFormValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<TaskFieldErrors>({});
  const [error, setError] = useState<ClientError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelReset, setModelReset] = useState(false);
  const [pending, setPending] = useState(false);

  const isDirty = (Object.keys(initial) as TaskFormField[]).some(
    (key) => values[key] !== initial[key],
  );
  const contentLocked = !editability.content;
  const priorityLocked = !editability.priority;
  const baseBranchLocked = contentLocked || worktreeBaseBranch !== null;
  // Keep a stored override selectable even if the branch no longer exists.
  const branchOptions =
    task?.baseBranch !== undefined &&
    task.baseBranch !== null &&
    !(branches ?? []).includes(task.baseBranch)
      ? [task.baseBranch, ...(branches ?? [])]
      : (branches ?? []);

  const update = (field: TaskFormField, next: TaskFormValues) => {
    setValues(next);
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setNotice(null);
  };

  const handleRuntimeChange = (value: string) => {
    const runtime = agentRuntimeSchema.safeParse(value);
    if (!runtime.success) {
      return;
    }
    const next = changeRuntime(values, runtime.data);
    setModelReset(values.modelId.trim() !== '' && next.modelId === '');
    update('agentRuntime', next);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setNotice(null);

    let response: ClientResult<z.infer<typeof taskResponseSchema>>;
    if (task === undefined) {
      const result = buildCreateTaskRequest(values);
      if (!result.ok) {
        setFieldErrors(result.fields);
        return;
      }
      setFieldErrors({});
      setPending(true);
      response = await requestJson(
        'POST',
        `/api/projects/${project.id}/tasks`,
        taskResponseSchema,
        result.request,
      );
    } else {
      const result = buildTaskUpdate(task, values, editability);
      if (!result.ok) {
        setFieldErrors(result.fields);
        return;
      }
      setFieldErrors({});
      if (result.update === null) {
        setNotice('There are no changes to save.');
        return;
      }
      setPending(true);
      response = await requestJson(
        'PATCH',
        `/api/projects/${project.id}/tasks/${task.id}`,
        taskResponseSchema,
        result.update,
      );
    }

    if (!response.ok) {
      setPending(false);
      const fromServer = fieldErrorsFromServer(response.error);
      if (fromServer === undefined) {
        setError(response.error);
      } else {
        setFieldErrors(fromServer);
      }
      return;
    }
    const saved = response.data.task;
    router.push(
      task === undefined
        ? createdTaskUrl(project.id, saved.id)
        : savedTaskUrl(project.id, saved.id),
    );
    router.refresh();
  };

  const describedBy = (field: TaskFormField, hint?: string) =>
    [hint, fieldErrors[field] === undefined ? undefined : `${fieldId}-${field}-error`]
      .filter((value) => value !== undefined)
      .join(' ') || undefined;

  const cancelHref = task === undefined ? taskBoardUrl(project.id) : taskUrl(project.id, task.id);

  return (
    <Card>
      <form onSubmit={handleSubmit} className="contents" noValidate>
        <CardHeader>
          <CardTitle>
            <h2>{task === undefined ? 'Task' : 'Task settings'}</h2>
          </CardTitle>
          <CardDescription>
            {task === undefined
              ? 'New tasks start in Backlog. Saving never queues the task, starts an agent or creates a worktree.'
              : 'Status changes are separate actions on the task page.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {contentLocked ? (
            <Alert>
              <Info aria-hidden="true" />
              <AlertTitle>
                {priorityLocked ? 'This task cannot be edited' : 'Only priority can be changed'}
              </AlertTitle>
              <AlertDescription>
                <p>
                  {priorityLocked
                    ? 'Tasks can be edited only in Backlog, and reprioritized while Queued.'
                    : 'Title, prompt, runtime, model and base branch can change only in Backlog. Return the task to Backlog to edit them.'}
                </p>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${fieldId}-title`}>Title</Label>
              <Input
                id={`${fieldId}-title`}
                name="title"
                value={values.title}
                onChange={(event) => update('title', { ...values, title: event.target.value })}
                maxLength={taskTitleMaxLength}
                disabled={contentLocked}
                required
                aria-invalid={fieldErrors.title !== undefined}
                aria-describedby={describedBy('title')}
              />
              <FieldError id={`${fieldId}-title-error`} message={fieldErrors.title} />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${fieldId}-prompt`}>Prompt</Label>
              <Textarea
                id={`${fieldId}-prompt`}
                name="prompt"
                value={values.prompt}
                onChange={(event) => update('prompt', { ...values, prompt: event.target.value })}
                maxLength={taskPromptMaxLength}
                rows={10}
                disabled={contentLocked}
                required
                placeholder="Describe what the agent should do, including acceptance criteria."
                aria-invalid={fieldErrors.prompt !== undefined}
                aria-describedby={describedBy('prompt', `${fieldId}-prompt-hint`)}
              />
              <p id={`${fieldId}-prompt-hint`} className="text-xs text-muted-foreground">
                Sent to the agent together with the global and project instructions.{' '}
                {values.prompt.length.toLocaleString('en')} /{' '}
                {taskPromptMaxLength.toLocaleString('en')} characters.
              </p>
              <FieldError id={`${fieldId}-prompt-error`} message={fieldErrors.prompt} />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-runtime`}>Agent runtime</Label>
              <NativeSelect
                id={`${fieldId}-runtime`}
                name="agentRuntime"
                value={values.agentRuntime}
                onChange={(event) => handleRuntimeChange(event.target.value)}
                disabled={contentLocked}
                aria-invalid={fieldErrors.agentRuntime !== undefined}
                aria-describedby={describedBy('agentRuntime')}
              >
                {agentRuntimes.map((runtime) => (
                  <option key={runtime} value={runtime}>
                    {agentRuntimeLabels[runtime]}
                  </option>
                ))}
              </NativeSelect>
              <FieldError id={`${fieldId}-agentRuntime-error`} message={fieldErrors.agentRuntime} />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-model`}>Model</Label>
              <ModelSelect
                key={values.agentRuntime}
                id={`${fieldId}-model`}
                runtime={values.agentRuntime}
                value={values.modelId}
                disabled={contentLocked}
                onChange={(modelId) => {
                  setModelReset(false);
                  update('modelId', { ...values, modelId });
                }}
                invalid={fieldErrors.modelId !== undefined}
                describedBy={describedBy(
                  'modelId',
                  modelReset ? `${fieldId}-model-hint` : undefined,
                )}
              />
              {modelReset ? (
                <p id={`${fieldId}-model-hint`} className="text-xs text-muted-foreground">
                  The model was reset to Default because the runtime changed.
                </p>
              ) : null}
              <FieldError id={`${fieldId}-modelId-error`} message={fieldErrors.modelId} />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-branch`}>Base branch</Label>
              <NativeSelect
                id={`${fieldId}-branch`}
                name="baseBranch"
                value={values.baseBranch}
                onChange={(event) =>
                  update('baseBranch', { ...values, baseBranch: event.target.value })
                }
                disabled={baseBranchLocked}
                aria-invalid={fieldErrors.baseBranch !== undefined}
                aria-describedby={describedBy('baseBranch', `${fieldId}-branch-hint`)}
              >
                <option value={projectDefaultBranch}>
                  Project default ({project.defaultBaseBranch})
                </option>
                {branchOptions.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                    {branches !== null && !branches.includes(branch) ? ' (not found)' : ''}
                  </option>
                ))}
              </NativeSelect>
              <p id={`${fieldId}-branch-hint`} className="text-xs text-muted-foreground">
                {worktreeBaseBranch !== null
                  ? `This task already has a worktree based on ${worktreeBaseBranch}. Later attempts continue in it, so the base branch can no longer change.`
                  : branches === null
                    ? 'The repository cannot be read right now, so only the project default can be chosen.'
                    : 'The project default is resolved when the task first starts. An override must exist locally.'}
              </p>
              <FieldError id={`${fieldId}-baseBranch-error`} message={fieldErrors.baseBranch} />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-priority`}>Priority</Label>
              <NativeSelect
                id={`${fieldId}-priority`}
                name="priority"
                value={values.priority}
                onChange={(event) => {
                  const priority = taskPrioritySchema.safeParse(event.target.value);
                  if (priority.success) {
                    update('priority', { ...values, priority: priority.data });
                  }
                }}
                disabled={priorityLocked}
                aria-invalid={fieldErrors.priority !== undefined}
                aria-describedby={describedBy('priority')}
              >
                {taskPriorities.map((priority) => (
                  <option key={priority} value={priority}>
                    {taskPriorityLabels[priority]}
                  </option>
                ))}
              </NativeSelect>
              <FieldError id={`${fieldId}-priority-error`} message={fieldErrors.priority} />
            </div>

            <div className="flex items-start gap-3 sm:col-span-2">
              <input
                id={`${fieldId}-urgent`}
                name="urgent"
                type="checkbox"
                checked={values.urgent}
                onChange={(event) => update('urgent', { ...values, urgent: event.target.checked })}
                disabled={priorityLocked}
                className="mt-0.5 size-4 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                aria-describedby={`${fieldId}-urgent-hint`}
              />
              <div className="space-y-1">
                <Label
                  htmlFor={`${fieldId}-urgent`}
                  className={priorityLocked ? 'cursor-not-allowed' : 'cursor-pointer'}
                >
                  Urgent
                </Label>
                <p id={`${fieldId}-urgent-hint`} className="text-xs text-muted-foreground">
                  Urgent tasks are scheduled before all others, regardless of project and task
                  priority.
                </p>
              </div>
            </div>
          </div>

          {error !== null ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>The task was not saved</AlertTitle>
              <AlertDescription>
                <p>{error.message}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          {notice !== null ? (
            <Alert>
              <Info aria-hidden="true" />
              <AlertDescription>
                <p>{notice}</p>
              </AlertDescription>
            </Alert>
          ) : null}

          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Tasks are stored in AI Agent Manager only. Saving reads the repository to check a base
            branch override and never changes its files, branches or Git configuration.
          </p>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button asChild variant="ghost">
            <Link href={cancelHref}>Cancel</Link>
          </Button>
          <Button
            type="submit"
            disabled={
              pending || (task !== undefined && (!isDirty || (contentLocked && priorityLocked)))
            }
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {pending ? 'Saving…' : task === undefined ? 'Create task' : 'Save changes'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
};
