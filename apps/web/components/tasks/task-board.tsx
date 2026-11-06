import { taskStatusLabels, type Task, type TaskStatus } from '@ai-agent-manager/core';

import { taskStatusDotClassName } from '@/components/tasks/task-badges';
import { TaskCard } from '@/components/tasks/task-card';
import { cn } from '@/lib/utils';
import type { TaskRecoveryOptions } from '@/lib/tasks/recovery';
import type { TaskArchiveOption } from '@/lib/tasks/workspace';
import {
  groupTasksByStatus,
  primaryBoardStatuses,
  secondaryBoardStatuses,
} from '@/lib/tasks/board';

const columnDescriptions: Readonly<Record<TaskStatus, string>> = {
  backlog: 'Saved, not authorized to run',
  // No automatic scheduler in v1: a queued task runs only after Start execution on its page.
  queued: 'Runs only when you start it',
  in_progress: 'An agent is working',
  review: 'Awaiting your decision',
  done: 'Committed and pushed',
  stopped: 'Stopped by you',
  interrupted: 'Ended unexpectedly',
  failed: 'Execution failed',
  discarded: 'Result rejected',
};

type RecoveryOptionsByTask = Readonly<Record<string, TaskRecoveryOptions>>;
type ArchiveOptionsByTask = Readonly<Record<string, TaskArchiveOption>>;

type ColumnProps = {
  status: TaskStatus;
  tasks: Task[];
  projectDefaultBranch: string;
  recoveryOptions: RecoveryOptionsByTask;
  archiveOptions: ArchiveOptionsByTask;
  compact?: boolean;
};

const BoardColumn = ({
  status,
  tasks,
  projectDefaultBranch,
  recoveryOptions,
  archiveOptions,
  compact = false,
}: ColumnProps) => (
  <section
    aria-labelledby={`column-${status}`}
    className={cn(
      'flex min-w-0 flex-col gap-3 rounded-xl border p-3',
      compact ? 'bg-card/50' : 'min-h-48 snap-start bg-card',
    )}
  >
    <header className="flex items-start justify-between gap-2 px-0.5">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span
            className={cn('size-1.5 shrink-0 rounded-full', taskStatusDotClassName[status])}
            aria-hidden="true"
          />
          <h3 id={`column-${status}`} className="text-sm font-semibold">
            {taskStatusLabels[status]}
          </h3>
        </div>
        <p className="text-xs text-muted-foreground">{columnDescriptions[status]}</p>
      </div>
      <span
        className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums"
        aria-label={`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}
      >
        {tasks.length}
      </span>
    </header>
    {tasks.length === 0 ? (
      <p className="px-0.5 text-xs text-muted-foreground/80">No tasks</p>
    ) : (
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id}>
            <TaskCard
              task={task}
              projectDefaultBranch={projectDefaultBranch}
              recoveryOptions={recoveryOptions[task.id] ?? null}
              archiveOption={archiveOptions[task.id] ?? null}
            />
          </li>
        ))}
      </ul>
    )}
  </section>
);

type TaskBoardProps = {
  tasks: readonly Task[];
  projectDefaultBranch: string;
  /** Retry/Resume and Discard options by task ID (TM-01); tasks without an entry offer neither. */
  recoveryOptions?: RecoveryOptionsByTask;
  /** Archive options by task ID (TM-02); tasks without an entry offer no Archive. */
  archiveOptions?: ArchiveOptionsByTask;
};

/**
 * The main flow as five columns (scrolling sideways on narrow screens) and the four other states
 * as a compact second row, so every documented state is always visible.
 */
export const TaskBoard = ({
  tasks,
  projectDefaultBranch,
  recoveryOptions = {},
  archiveOptions = {},
}: TaskBoardProps) => {
  const groups = groupTasksByStatus(tasks);
  return (
    <div className="space-y-6">
      <h2 className="sr-only">Main flow</h2>
      <div
        role="group"
        aria-label="Main flow"
        className="-mx-6 grid snap-x scroll-px-6 auto-cols-[minmax(15rem,80%)] grid-flow-col gap-3 overflow-x-auto px-6 pb-2 sm:auto-cols-[minmax(15rem,45%)] lg:mx-0 lg:grid-flow-row lg:grid-cols-5 lg:scroll-px-0 lg:overflow-visible lg:px-0"
      >
        {primaryBoardStatuses.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={groups[status]}
            projectDefaultBranch={projectDefaultBranch}
            recoveryOptions={recoveryOptions}
            archiveOptions={archiveOptions}
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
              recoveryOptions={recoveryOptions}
              archiveOptions={archiveOptions}
              compact
            />
          ))}
        </div>
      </div>
    </div>
  );
};

type ArchivedTaskListProps = {
  tasks: readonly Task[];
  projectDefaultBranch: string;
  archiveOptions?: ArchiveOptionsByTask;
};

/** The Archived tasks view (TM-02): archived tasks, newest first, each with Restore. */
export const ArchivedTaskList = ({
  tasks,
  projectDefaultBranch,
  archiveOptions = {},
}: ArchivedTaskListProps) => (
  <section aria-labelledby="archived-tasks-title" className="space-y-3">
    <h2 id="archived-tasks-title" className="sr-only">
      Archived tasks
    </h2>
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tasks.map((task) => (
        <li key={task.id}>
          <TaskCard
            task={task}
            projectDefaultBranch={projectDefaultBranch}
            archiveOption={archiveOptions[task.id] ?? null}
          />
        </li>
      ))}
    </ul>
  </section>
);
