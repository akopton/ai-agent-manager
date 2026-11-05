import { Bot, Flame } from 'lucide-react';
import {
  taskPriorityLabels,
  taskStatusLabels,
  type AgentRuntime,
  type TaskPriority,
  type TaskStatus,
} from '@ai-agent-manager/core';

import { Badge } from '@/components/ui/badge';
import { agentRuntimeLabels, describeModel } from '@/lib/tasks/board';

type BadgeVariant =
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info';

// Status color lives in compact labels and dots only; board columns stay neutral.
const statusVariants: Readonly<Record<TaskStatus, BadgeVariant>> = {
  backlog: 'outline',
  queued: 'info',
  in_progress: 'success',
  review: 'default',
  done: 'secondary',
  stopped: 'warning',
  interrupted: 'warning',
  failed: 'destructive',
  discarded: 'outline',
};

/** Background class for the small status indicator shown in board column headers. */
export const taskStatusDotClassName: Readonly<Record<TaskStatus, string>> = {
  backlog: 'bg-muted-foreground/60',
  queued: 'bg-info',
  in_progress: 'bg-success',
  review: 'bg-primary',
  done: 'bg-success/50',
  stopped: 'bg-warning',
  interrupted: 'bg-warning',
  failed: 'bg-destructive',
  discarded: 'bg-muted-foreground/40',
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
