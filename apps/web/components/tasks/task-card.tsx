import Link from 'next/link';
import { FileDiff, GitBranch } from 'lucide-react';
import type { Task } from '@ai-agent-manager/core';

import { TaskActions } from '@/components/tasks/task-actions';
import { TaskArchiveActions } from '@/components/tasks/task-archive-actions';
import { TaskRecoveryActions } from '@/components/tasks/task-recovery-actions';
import {
  ArchivedBadge,
  TaskPriorityBadge,
  TaskRuntimeBadge,
  TaskStatusBadge,
  UrgentBadge,
} from '@/components/tasks/task-badges';
import { Button } from '@/components/ui/button';
import { taskReviewUrl } from '@/lib/review/format';
import { taskUrl } from '@/lib/tasks/board';
import type { TaskRecoveryOptions } from '@/lib/tasks/recovery';
import type { TaskArchiveOption } from '@/lib/tasks/workspace';

type TaskCardProps = {
  task: Task;
  projectDefaultBranch: string;
  /** Retry/Resume and Discard options derived by the server, if the task offers any. */
  recoveryOptions?: TaskRecoveryOptions | null;
  /** Archive/Restore availability derived by the server (TM-02). */
  archiveOption?: TaskArchiveOption | null;
};

export const TaskCard = ({
  task,
  projectDefaultBranch,
  recoveryOptions,
  archiveOption,
}: TaskCardProps) => (
  <article
    aria-labelledby={`task-${task.id}-title`}
    className="space-y-3 rounded-lg border bg-elevated p-3 text-sm transition-colors hover:border-border-strong"
  >
    <h4
      id={`task-${task.id}-title`}
      className="text-[0.9375rem] leading-5 font-medium break-words text-foreground"
    >
      <Link
        href={taskUrl(task.projectId, task.id)}
        className="rounded-sm underline-offset-4 hover:text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {task.title}
      </Link>
    </h4>
    <div className="flex flex-wrap gap-1.5">
      <TaskStatusBadge status={task.status} />
      {task.archivedAt !== null ? <ArchivedBadge /> : null}
      {task.urgent ? <UrgentBadge /> : null}
      <TaskPriorityBadge priority={task.priority} />
      <TaskRuntimeBadge agentRuntime={task.agentRuntime} modelId={task.modelId} />
    </div>
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <GitBranch className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {task.baseBranch ?? projectDefaultBranch}
        {task.baseBranch === null ? ' (default)' : null}
      </span>
    </p>
    {task.status === 'review' && task.archivedAt === null ? (
      <Button asChild size="sm" variant="outline">
        <Link href={taskReviewUrl(task.projectId, task.id)}>
          <FileDiff aria-hidden="true" />
          Review changes
        </Link>
      </Button>
    ) : null}
    {task.archivedAt === null ? (
      <>
        <TaskActions projectId={task.projectId} task={task} size="sm" />
        <TaskRecoveryActions
          projectId={task.projectId}
          task={task}
          options={recoveryOptions}
          size="sm"
        />
      </>
    ) : null}
    <TaskArchiveActions projectId={task.projectId} task={task} option={archiveOption} size="sm" />
  </article>
);
