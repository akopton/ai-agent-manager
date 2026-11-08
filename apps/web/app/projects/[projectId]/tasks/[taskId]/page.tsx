import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { ArrowLeft, CheckCircle2, FileDiff, FolderArchive, Info } from 'lucide-react';
import { taskPriorityLabels, taskStatusLabels } from '@ai-agent-manager/core';

import { TaskExecutionActions } from '@/components/execution/task-execution-actions';
import { TaskHeader } from '@/components/tasks/task-header';
import { TaskExecutionPanel } from '@/components/execution/task-execution-panel';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { TaskActions } from '@/components/tasks/task-actions';
import { TaskArchiveActions } from '@/components/tasks/task-archive-actions';
import { TaskRecoveryActions } from '@/components/tasks/task-recovery-actions';
import { TaskWorkspacePanel } from '@/components/tasks/task-workspace-panel';
import {
  ArchivedBadge,
  TaskPriorityBadge,
  TaskRuntimeBadge,
  TaskStatusBadge,
  UrgentBadge,
} from '@/components/tasks/task-badges';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTimestamp } from '@/lib/projects/format';
import { taskReviewUrl } from '@/lib/review/format';
import { getDatabase } from '@/lib/server/database';
import { getTaskExecution } from '@/lib/server/execution';
import { getTaskRecoveryOptions } from '@/lib/server/recovery';
import { loadForPage } from '@/lib/server/load';
import { findTaskOrigin } from '@/lib/server/task-proposals';
import { findProjectTask } from '@/lib/server/tasks';
import { TaskOrigin } from '@/components/tasks/task-origin';
import { TaskEditLink } from '@/components/tasks/task-edit-link';
import { getTaskArchiveOption, getTaskWorkspacePanel } from '@/lib/server/workspace';
import { taskEditability, taskStatusNotes } from '@/lib/tasks/actions';
import {
  agentRuntimeLabels,
  archivedTasksUrl,
  describeBaseBranch,
  describeModel,
  taskBoardUrl,
} from '@/lib/tasks/board';
import { readTaskFeedback } from '@/lib/tasks/feedback';

export const metadata: Metadata = { title: 'Task · AI Agent Manager' };

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </>
);

const feedbackMessages = {
  created: {
    title: 'Task created in Backlog',
    body: 'Nothing was queued or run, and the repository was not changed.',
  },
  saved: { title: 'Task saved', body: 'The repository was not changed.' },
} as const;

const TaskPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => {
  await connection();
  const { projectId, taskId } = await params;
  const feedback = readTaskFeedback(await searchParams);
  const result = await loadForPage(async () => {
    const db = getDatabase();
    const found = findProjectTask(db, projectId, taskId);
    return found === undefined
      ? undefined
      : {
          ...found,
          execution: getTaskExecution(db, found.project.id, found.task.id),
          recoveryOptions: getTaskRecoveryOptions(db, found.task),
          archiveOption: getTaskArchiveOption(db, found.task),
          workspacePanel: await getTaskWorkspacePanel(db, found.project.id, found.task.id),
          origin: findTaskOrigin(db, found.project.id, found.task.id),
        };
  });

  if (!result.ok) {
    return <DatabaseNotReady message={result.message} />;
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project, task, execution, recoveryOptions, archiveOption, workspacePanel, origin } =
    result.data;
  const archived = task.archivedAt !== null;
  // An archived task accepts no lifecycle action or edit until it is restored.
  const editability = archived ? { content: false, priority: false } : taskEditability(task.status);
  const [latestRun] = execution.runs;
  // Changes can be inspected once the latest run has ended and created a worktree.
  const changesInspectable =
    latestRun !== undefined && !latestRun.active && execution.workspace !== null;

  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href={archived ? archivedTasksUrl(project.id) : taskBoardUrl(project.id)}>
            <ArrowLeft aria-hidden="true" />
            {archived ? `${project.name} archived tasks` : `${project.name} board`}
          </Link>
        </Button>
        <TaskHeader
          title={task.title}
          badges={
            <>
              <TaskStatusBadge status={task.status} />
              {archived ? <ArchivedBadge /> : null}
              {task.urgent ? <UrgentBadge /> : null}
              <TaskPriorityBadge priority={task.priority} />
              <TaskRuntimeBadge agentRuntime={task.agentRuntime} modelId={task.modelId} />
            </>
          }
          actions={
            <>
              {archived ? null : (
                <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                  <TaskActions projectId={project.id} task={task} />
                  <TaskExecutionActions projectId={project.id} task={task} execution={execution} />
                  <TaskRecoveryActions
                    projectId={project.id}
                    task={task}
                    options={recoveryOptions}
                  />
                </div>
              )}
              <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                {changesInspectable ? (
                  <Button asChild variant={task.status === 'review' ? 'default' : 'outline'}>
                    <Link href={taskReviewUrl(project.id, task.id)}>
                      <FileDiff aria-hidden="true" />
                      {task.status === 'review' ? 'Review changes' : 'Inspect changes'}
                    </Link>
                  </Button>
                ) : null}
                <TaskEditLink projectId={project.id} taskId={task.id} editability={editability} />
                <TaskArchiveActions
                  projectId={project.id}
                  task={task}
                  option={archiveOption}
                  showUnavailableReason
                />
              </div>
            </>
          }
        />
      </section>

      {feedback !== undefined ? (
        <Alert variant="success">
          <CheckCircle2 aria-hidden="true" />
          <AlertTitle>{feedbackMessages[feedback].title}</AlertTitle>
          <AlertDescription>
            <p>{feedbackMessages[feedback].body}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {archived ? (
        <Alert variant="info">
          <FolderArchive aria-hidden="true" />
          <AlertTitle>Archived</AlertTitle>
          <AlertDescription>
            <p>
              Hidden from the board since {formatTimestamp(task.archivedAt ?? 0)}. Its status (
              {taskStatusLabels[task.status]}), attempts, reviews, publications and worktree are
              unchanged and stay inspectable. Restore it to queue, retry, resume, discard or edit it
              again.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Alert>
        <Info aria-hidden="true" />
        <AlertTitle>{taskStatusLabels[task.status]}</AlertTitle>
        <AlertDescription>
          <p>{taskStatusNotes[task.status]}</p>
        </AlertDescription>
      </Alert>

      <TaskExecutionPanel
        showActions={false}
        projectId={project.id}
        task={{ id: task.id, status: task.status }}
        execution={execution}
      />

      <TaskWorkspacePanel projectId={project.id} task={task} panel={workspacePanel} />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Prompt</h2>
          </CardTitle>
          <CardDescription>
            Sent to the agent together with the global and project instructions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="rounded-lg border bg-inset p-3 font-mono text-sm leading-6 break-words whitespace-pre-wrap">
            {task.prompt}
          </p>
          <div className="mt-3 flex justify-end">
            <TaskEditLink projectId={project.id} taskId={task.id} editability={editability} />
          </div>
        </CardContent>
      </Card>

      {origin === undefined ? null : <TaskOrigin projectId={project.id} origin={origin} />}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Details</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[11rem_1fr]">
            <Field label="Status">{taskStatusLabels[task.status]}</Field>
            <Field label="Agent runtime">{agentRuntimeLabels[task.agentRuntime]}</Field>
            <Field label="Model">
              <span className={task.modelId === null ? undefined : 'font-mono text-xs'}>
                {describeModel(task.modelId)}
              </span>
              {task.modelId === null ? (
                <span className="text-muted-foreground"> (CLI configuration decides)</span>
              ) : null}
            </Field>
            <Field label="Base branch">
              {describeBaseBranch(task.baseBranch, project.defaultBaseBranch)}
            </Field>
            <Field label="Priority">{taskPriorityLabels[task.priority]}</Field>
            <Field label="Urgent">{task.urgent ? 'Yes' : 'No'}</Field>
            <Field label="Created">{formatTimestamp(task.createdAt)}</Field>
            {task.updatedAt !== task.createdAt ? (
              <Field label="Updated">{formatTimestamp(task.updatedAt)}</Field>
            ) : null}
            {task.queuedAt !== null ? (
              <Field label="Queued">{formatTimestamp(task.queuedAt)}</Field>
            ) : null}
            {task.archivedAt !== null ? (
              <Field label="Archived">{formatTimestamp(task.archivedAt)}</Field>
            ) : null}
            <Field label="Runs">
              {execution.runs.length === 0 ? (
                <span className="text-muted-foreground">None yet.</span>
              ) : (
                `${execution.runs.length} (see Execution above)`
              )}
            </Field>
          </dl>
        </CardContent>
      </Card>
    </>
  );
};

export default TaskPage;
