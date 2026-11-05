import Link from 'next/link';
import { FileDiff, GitBranch } from 'lucide-react';
import type { Task } from '@ai-agent-manager/core';

import { TaskActions } from '@/components/tasks/task-actions';
import {
  TaskPriorityBadge,
  TaskRuntimeBadge,
  TaskStatusBadge,
  UrgentBadge,
} from '@/components/tasks/task-badges';
import { Button } from '@/components/ui/button';
import { taskReviewUrl } from '@/lib/review/format';
import { taskUrl } from '@/lib/tasks/board';

type TaskCardProps = { task: Task; projectDefaultBranch: string };

export const TaskCard = ({ task, projectDefaultBranch }: TaskCardProps) => (
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
    {task.status === 'review' ? (
      <Button asChild size="sm" variant="outline">
        <Link href={taskReviewUrl(task.projectId, task.id)}>
          <FileDiff aria-hidden="true" />
          Review changes
        </Link>
      </Button>
    ) : null}
    <TaskActions projectId={task.projectId} task={task} size="sm" />
  </article>
);
