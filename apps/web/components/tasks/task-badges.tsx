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

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

const statusVariants: Readonly<Record<TaskStatus, BadgeVariant>> = {
  backlog: 'outline',
  queued: 'secondary',
  in_progress: 'default',
  review: 'default',
  done: 'secondary',
  stopped: 'outline',
  interrupted: 'destructive',
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
