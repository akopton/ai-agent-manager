import {
  availableTaskActions,
  taskContentEditableStatuses,
  taskPriorityEditableStatuses,
  type TaskAction,
  type TaskStatus,
} from '@ai-agent-manager/core';

// The task actions the web app exposes today. They are a subset of the domain's named transitions;
// worker-only transitions (start, complete, stop, fail, interrupt, mark done) and actions that
// need run or review records (retry, resume, request changes, discard) are not offered yet.

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
    'Eligible to run. There is no automatic scheduler yet: start it explicitly with Start execution (requires Trusted Local Mode and a trusted project), or return it to Backlog. Priority and the Urgent flag can still be changed.',
  in_progress:
    'An agent is working on this task in its own worktree. Stop terminates the agent’s process group; files are kept.',
  review:
    'The agent process completed and no observable Git mutation was found. Inspect the worktree; Approve & Push, Request Changes and Discard will be available with the review workflow.',
  stopped:
    'Execution was stopped. The worktree and partial files are kept. Retry, Resume and Discard will be available in a later version.',
  interrupted:
    'Execution was interrupted (worker shutdown or restart) and is never resumed automatically. The worktree is kept. Retry, Resume and Discard will be available in a later version.',
  failed:
    'Execution failed or its Git integrity check blocked review. The worktree and evidence are kept. Retry and Discard will be available in a later version.',
  discarded: 'Final state. The result was rejected; the task stays in history.',
  done: 'Final state. The approved changes were committed and pushed to the task branch.',
};
