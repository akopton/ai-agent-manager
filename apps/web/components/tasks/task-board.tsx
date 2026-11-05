import { taskStatusLabels, type Task, type TaskStatus } from '@ai-agent-manager/core';

import { TaskCard } from '@/components/tasks/task-card';
import { cn } from '@/lib/utils';
import {
  groupTasksByStatus,
  primaryBoardStatuses,
  secondaryBoardStatuses,
} from '@/lib/tasks/board';

const columnDescriptions: Readonly<Record<TaskStatus, string>> = {
  backlog: 'Saved, not authorized to run',
  queued: 'Eligible for the scheduler',
  in_progress: 'An agent is working',
  review: 'Awaiting your decision',
  done: 'Committed and pushed',
  stopped: 'Stopped by you',
  interrupted: 'Ended unexpectedly',
  failed: 'Execution failed',
  discarded: 'Result rejected',
};

type ColumnProps = {
  status: TaskStatus;
  tasks: Task[];
  projectDefaultBranch: string;
  compact?: boolean;
};

const BoardColumn = ({ status, tasks, projectDefaultBranch, compact = false }: ColumnProps) => (
  <section
    aria-labelledby={`column-${status}`}
    className={cn(
      'flex min-w-0 flex-col gap-3 rounded-xl border bg-muted/40 p-3',
      compact ? undefined : 'min-h-48 snap-start',
    )}
  >
    <header className="flex items-baseline justify-between gap-2">
      <div className="min-w-0">
        <h3 id={`column-${status}`} className="text-sm font-semibold">
          {taskStatusLabels[status]}
        </h3>
        <p className="text-xs text-muted-foreground">{columnDescriptions[status]}</p>
      </div>
      <span
        className="rounded-full bg-background px-2 py-0.5 text-xs font-medium tabular-nums"
        aria-label={`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}
      >
        {tasks.length}
      </span>
    </header>
    {tasks.length === 0 ? (
      <p className="text-xs text-muted-foreground">No tasks</p>
    ) : (
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id}>
            <TaskCard task={task} projectDefaultBranch={projectDefaultBranch} />
          </li>
        ))}
      </ul>
    )}
  </section>
);

type TaskBoardProps = { tasks: readonly Task[]; projectDefaultBranch: string };

/**
 * The main flow as five columns (scrolling sideways on narrow screens) and the four other states
 * as a compact second row, so every documented state is always visible.
 */
export const TaskBoard = ({ tasks, projectDefaultBranch }: TaskBoardProps) => {
  const groups = groupTasksByStatus(tasks);
  return (
    <div className="space-y-6">
      <h2 className="sr-only">Main flow</h2>
      <div
        role="group"
        aria-label="Main flow"
        className="-mx-6 grid snap-x auto-cols-[minmax(15rem,80%)] grid-flow-col gap-3 overflow-x-auto px-6 pb-2 sm:auto-cols-[minmax(15rem,45%)] lg:mx-0 lg:grid-flow-row lg:grid-cols-5 lg:overflow-visible lg:px-0"
      >
        {primaryBoardStatuses.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={groups[status]}
            projectDefaultBranch={projectDefaultBranch}
          />
        ))}
      </div>
      <div role="group" aria-labelledby="other-states-title" className="space-y-3">
        <h2 id="other-states-title" className="text-sm font-semibold text-muted-foreground">
          Other states
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {secondaryBoardStatuses.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              tasks={groups[status]}
              projectDefaultBranch={projectDefaultBranch}
              compact
            />
          ))}
        </div>
      </div>
    </div>
  );
};
