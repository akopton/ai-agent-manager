import type { ComponentProps } from 'react';
import { Bot, Flame, FolderArchive } from 'lucide-react';
import {
  taskPriorityLabels,
  taskStatusLabels,
  type AgentRuntime,
  type TaskPriority,
  type TaskStatus,
} from '@ai-agent-manager/core';

import { Badge } from '@/components/ui/badge';
import { agentRuntimeLabels, describeModel } from '@/lib/tasks/board';

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>['variant']>;

// Board columns stay neutral. Status tones
// use fixed status tokens, never the user-selected accent.
const statusVariants: Readonly<Record<TaskStatus, BadgeVariant>> = {
  backlog: 'outline',
  queued: 'info',
  in_progress: 'success',
  review: 'review',
  done: 'secondary',
  stopped: 'warning',
  interrupted: 'warning',
  failed: 'destructive',
  discarded: 'outline',
};

const priorityVariants: Readonly<Record<TaskPriority, BadgeVariant>> = {
  critical: 'destructive',
  high: 'secondary',
  normal: 'outline',
  low: 'outline',
};

export const TaskStatusBadge = ({ status }: { status: TaskStatus }) => (
  <Badge variant={statusVariants[status]}>{taskStatusLabels[status]}</Badge>
);

export const TaskPriorityBadge = ({ priority }: { priority: TaskPriority }) => (
  <Badge variant={priorityVariants[priority]}>{taskPriorityLabels[priority]} priority</Badge>
);

/** Organizational visibility (TM-02), shown next to the unchanged status. */
export const ArchivedBadge = () => (
  <Badge variant="outline">
    <FolderArchive aria-hidden="true" />
    Archived
  </Badge>
);

export const UrgentBadge = () => (
  <Badge variant="destructive">
    <Flame aria-hidden="true" />
    Urgent
  </Badge>
);

export const TaskRuntimeBadge = ({
  agentRuntime,
  modelId,
}: {
  agentRuntime: AgentRuntime;
  modelId: string | null;
}) => (
  <Badge variant="outline" className="max-w-full">
    <Bot aria-hidden="true" />
    <span className="truncate">
      {agentRuntimeLabels[agentRuntime]} · {describeModel(modelId)}
    </span>
  </Badge>
);
