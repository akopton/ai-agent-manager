import {
  taskPriorities,
  taskStatuses,
  type AgentRuntime,
  type Task,
  type TaskStatus,
} from '@ai-agent-manager/core';

// Pure helpers for the project board. They only arrange and describe stored tasks; status changes
// happen through the named task actions on the server.

/** The documented main flow, shown as board columns (`SPEC.md` §4.2). */
export const primaryBoardStatuses = [
  'backlog',
  'queued',
  'in_progress',
  'review',
  'done',
] as const satisfies readonly TaskStatus[];

/** States outside the main flow, shown as a compact second row so every state stays visible. */
export const secondaryBoardStatuses = [
  'stopped',
  'interrupted',
  'failed',
  'discarded',
] as const satisfies readonly TaskStatus[];

export const agentRuntimeLabels: Readonly<Record<AgentRuntime, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** `null` means `Default`: the CLI's own configuration decides the model at run time. */
export const describeModel = (modelId: string | null): string => modelId ?? 'Default';

export const describeBaseBranch = (baseBranch: string | null, projectDefault: string): string =>
  baseBranch ?? `${projectDefault} (project default)`;

const priorityRank = (task: Task): number => taskPriorities.indexOf(task.priority);

const byId = (a: Task, b: Task): number => a.id.localeCompare(b.id);

/**
 * Within one project, mirrors the scheduler order for queued tasks (`SPEC.md` §6): Urgent first,
 * then task priority, then the time enqueued.
 */
const compareQueued = (a: Task, b: Task): number =>
  Number(b.urgent) - Number(a.urgent) ||
  priorityRank(a) - priorityRank(b) ||
  (a.queuedAt ?? 0) - (b.queuedAt ?? 0) ||
  byId(a, b);

const compareBacklog = (a: Task, b: Task): number =>
  Number(b.urgent) - Number(a.urgent) ||
  priorityRank(a) - priorityRank(b) ||
  a.createdAt - b.createdAt ||
  byId(a, b);

const compareRecent = (a: Task, b: Task): number => b.updatedAt - a.updatedAt || byId(a, b);

const comparators: Partial<Record<TaskStatus, (a: Task, b: Task) => number>> = {
  backlog: compareBacklog,
  queued: compareQueued,
};

/** Groups tasks by status, each group in its display order. Every status has an entry. */
export const groupTasksByStatus = (tasks: readonly Task[]): Record<TaskStatus, Task[]> => {
  const groups = Object.fromEntries(taskStatuses.map((status) => [status, [] as Task[]])) as Record<
    TaskStatus,
    Task[]
  >;
  for (const task of tasks) {
    groups[task.status].push(task);
  }
  for (const status of taskStatuses) {
    groups[status].sort(comparators[status] ?? compareRecent);
  }
  return groups;
};

export type ProjectTaskCounts = { total: number; byStatus: Record<TaskStatus, number> };

export const emptyTaskCounts = (): ProjectTaskCounts => ({
  total: 0,
  byStatus: Object.fromEntries(taskStatuses.map((status) => [status, 0])) as Record<
    TaskStatus,
    number
  >,
});

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const attentionStatuses: readonly TaskStatus[] = ['stopped', 'interrupted', 'failed'];

/** Short summary for the project library, for example `4 tasks · 1 queued · 1 needs attention`. */
export const summarizeTaskCounts = (counts: ProjectTaskCounts): string => {
  if (counts.total === 0) {
    return 'No tasks';
  }
  const attention = attentionStatuses.reduce((sum, status) => sum + counts.byStatus[status], 0);
  return [
    plural(counts.total, 'task'),
    counts.byStatus.queued > 0 ? `${counts.byStatus.queued} queued` : undefined,
    counts.byStatus.in_progress > 0 ? `${counts.byStatus.in_progress} in progress` : undefined,
    counts.byStatus.review > 0 ? `${counts.byStatus.review} in review` : undefined,
    attention > 0 ? `${attention} ${attention === 1 ? 'needs' : 'need'} attention` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
};

export const taskBoardUrl = (projectId: string): string => `/projects/${projectId}/board`;

export const taskUrl = (projectId: string, taskId: string): string =>
  `/projects/${projectId}/tasks/${taskId}`;
