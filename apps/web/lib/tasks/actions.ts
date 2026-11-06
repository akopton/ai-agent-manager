import {
  availableTaskActions,
  taskContentEditableStatuses,
  taskPriorityEditableStatuses,
  type TaskAction,
  type TaskStatus,
} from '@ai-agent-manager/core';

// The body-less task actions the web app exposes as generic buttons. They are a subset of the
// domain's named transitions; worker-only transitions (start, complete, stop, fail, interrupt,
// mark done) are never offered. Request Changes needs feedback and a reviewed attempt, so it has
// its own route on the Review Changes page. Retry, Resume and Discard (TM-01) need the attempt the
// operator saw and a confirmation dialog, so they have their own component and routes.

export const userTaskActions = [
  'queue',
  'return_to_backlog',
] as const satisfies readonly TaskAction[];

export type UserTaskAction = (typeof userTaskActions)[number];

export const userTaskActionLabels: Readonly<Record<UserTaskAction, string>> = {
  queue: 'Queue',
  return_to_backlog: 'Return to Backlog',
};

/** URL segment of each action's route under `/api/projects/:projectId/tasks/:taskId/`. */
export const userTaskActionSegments: Readonly<Record<UserTaskAction, string>> = {
  queue: 'queue',
  return_to_backlog: 'return-to-backlog',
};

const isUserTaskAction = (action: TaskAction): action is UserTaskAction =>
  (userTaskActions as readonly TaskAction[]).includes(action);

/** The exposed actions that the domain allows from `status`. */
export const availableUserTaskActions = (status: TaskStatus): UserTaskAction[] =>
  availableTaskActions(status).filter(isUserTaskAction);

export type TaskEditability = { content: boolean; priority: boolean };

/** Which task fields the domain allows to change in `status`. */
export const taskEditability = (status: TaskStatus): TaskEditability => ({
  content: taskContentEditableStatuses.includes(status),
  priority: taskPriorityEditableStatuses.includes(status),
});

/**
 * An honest note about what can be done with a task in each status in this version. Actions that
 * depend on agent execution, run history or review are named but not offered.
 */
export const taskStatusNotes: Readonly<Record<TaskStatus, string>> = {
  backlog: 'Saved but not authorized to run. Edit it freely, then queue it when it is ready.',
  queued:
    'Eligible to run. There is no automatic scheduler yet: start it explicitly with Start execution (requires Trusted Local Mode and a trusted project), or return it to Backlog. After Request Changes, Retry or Resume, the next run continues in the existing worktree. Priority and the Urgent flag can still be changed.',
  in_progress:
    'An agent is working on this task in its own worktree. Stop terminates the agent’s process group; files are kept.',
  review:
    'The agent process completed and no observable Git mutation was found. Open Review Changes to inspect what the agent changed, then request changes (the task returns to Queued and waits for an explicit Start) or Approve & Push. Discard rejects the result without deleting the worktree or branch.',
  stopped:
    'Execution was stopped. The worktree and partial files are kept. Resume queues a new attempt that continues in the same worktree with a new agent session; it runs only after an explicit Start execution. Discard marks the task as rejected without deleting anything.',
  interrupted:
    'Execution was interrupted (worker shutdown or restart) and is never resumed automatically. The worktree is kept. Resume queues a new attempt that continues in the same worktree with a new agent session; it runs only after an explicit Start execution. Discard marks the task as rejected without deleting anything.',
  failed:
    'Execution failed or its Git integrity check blocked review. The worktree and evidence are kept. Retry queues a new attempt that continues with the existing worktree changes (or creates the worktree if it never existed); it runs only after an explicit Start execution. Discard marks the task as rejected without deleting anything.',
  discarded:
    'Final state. The result was rejected; the task, its attempts and records stay in history. The worktree and task branch, if any, were not removed; cleanup is not available yet.',
  done: 'Final state. The approved changes were committed and pushed to the task branch.',
};
