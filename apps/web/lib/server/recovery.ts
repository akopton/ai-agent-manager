import { randomUUID } from 'node:crypto';
import {
  assessPriorProcess,
  isActiveTaskRunStatus,
  isTaskDiscardableStatus,
  projectIdSchema,
  recoveryKindForStatus,
  TaskError,
  TaskRecoveryError,
  taskRecoveryKindLabels,
  taskRecoverySourceStatuses,
  taskStatusLabels,
  type DiscardTaskInput,
  type RecoverTaskInput,
  type Task,
  type TaskRecoveryKind,
} from '@ai-agent-manager/core';
import {
  discardTask,
  findBlockingPublication,
  findPendingChangeRequest,
  findPendingRecovery,
  findProjectById,
  findTaskById,
  listTaskReviews,
  listTaskRuns,
  listTaskWorkspaces,
  requestTaskRecovery,
  type DatabaseConnection,
  type ProjectRecordWithTrust,
  type TaskRecord,
} from '@ai-agent-manager/database';
import { isProcessGroupAlive, verifyRetainedTaskWorktree } from '@ai-agent-manager/git';
import type { TaskRecoveryOptions } from '@/lib/tasks/recovery';

// Retry, Resume and Discard (TM-01) for the web app. The web process records the decision and the
// named transition only: it never starts an agent, creates a start request, or writes to Git. Before
// it records a Retry or Resume it re-verifies the retained worktree read-only (the same check the
// worker repeats before launch) and probes the previous attempt's process group, so an unsafe
// continuation is refused here with an actionable message instead of failing later.

type Database = DatabaseConnection['db'];

export type RecoveryServiceOptions = {
  now?: () => number;
  createId?: () => string;
  /** @internal Tests only: replaces the process-group probe. */
  probeProcessGroup?: (pid: number) => boolean;
};

const requireProjectTask = (
  db: Database,
  projectId: string,
  taskId: string,
): { project: ProjectRecordWithTrust; task: TaskRecord } => {
  const parsed = projectIdSchema.safeParse(projectId);
  const project = parsed.success ? findProjectById(db, parsed.data) : undefined;
  if (project === undefined) {
    throw new TaskError('project_not_found', 'The project does not exist.');
  }
  const task = findTaskById(db, taskId);
  if (task === undefined || task.projectId !== project.id) {
    throw new TaskError('task_not_found', 'The task does not exist.');
  }
  return { project, task };
};

const publicationBlockedReason =
  'An Approve & Push publication holds this task. Finish or retry the push first.';

/**
 * The Retry/Resume and Discard options for a task, from database records and a process-group
 * probe. Returns `null` when the task has no run or offers neither action. Read-only.
 */
export const getTaskRecoveryOptions = (
  db: Database,
  task: Pick<Task, 'id' | 'status'>,
  {
    probeProcessGroup = isProcessGroupAlive,
  }: Pick<RecoveryServiceOptions, 'probeProcessGroup'> = {},
): TaskRecoveryOptions | null => {
  const kind = recoveryKindForStatus(task.status);
  const discardable = isTaskDiscardableStatus(task.status);
  if (kind === null && !discardable) return null;
  const [latest] = listTaskRuns(db, task.id);
  if (latest === undefined) return null;
  const active = isActiveTaskRunStatus(latest.status);
  const blocked = findBlockingPublication(db, task.id) !== undefined;
  const workspaceRetained = listTaskWorkspaces(db, task.id).length > 0;

  let recovery: TaskRecoveryOptions['recovery'] = null;
  if (kind !== null) {
    const assessment = assessPriorProcess(latest);
    const processAlive =
      assessment === 'process_group' && latest.pid !== null && probeProcessGroup(latest.pid);
    const waiting =
      findPendingChangeRequest(db, task.id) !== undefined ||
      findPendingRecovery(db, task.id) !== undefined;
    const unavailableReason = active
      ? 'An attempt of this task is still active.'
      : blocked
        ? publicationBlockedReason
        : waiting
          ? 'A change request or recovery already waits for the next attempt.'
          : processAlive
            ? `The process group of attempt ${latest.attempt} (pid ${latest.pid ?? 'unknown'}) still exists, so its agent may still be running. Make sure no agent of that attempt is still working in the worktree, stop it if needed, then reload.`
            : null;
    recovery = {
      kind,
      available: unavailableReason === null,
      unavailableReason,
      workspaceRetained,
      processConfirmationRequired: assessment === 'unknown',
      carriesFeedback: listTaskReviews(db, task.id).length > 0,
    };
  }

  const discardReason = active
    ? 'An attempt of this task is still active.'
    : blocked
      ? 'An Approve & Push publication holds this task; it cannot be discarded while the push is pending.'
      : null;
  return {
    runId: latest.id,
    attempt: latest.attempt,
    recovery,
    discard: discardable
      ? { available: discardReason === null, unavailableReason: discardReason, workspaceRetained }
      : null,
  };
};

/** Options for every board task that offers Retry, Resume or Discard, keyed by task ID. */
export const getBoardRecoveryOptions = (
  db: Database,
  tasks: readonly Pick<Task, 'id' | 'status'>[],
  options: Pick<RecoveryServiceOptions, 'probeProcessGroup'> = {},
): Record<string, TaskRecoveryOptions> => {
  const result: Record<string, TaskRecoveryOptions> = {};
  for (const task of tasks) {
    const found = getTaskRecoveryOptions(db, task, options);
    if (found !== null) result[task.id] = found;
  }
  return result;
};

/**
 * Records `Retry` (Failed) or `Resume` (Stopped, Interrupted) and returns the task in `Queued`. A
 * retained worktree is re-verified read-only first; if it cannot be continued safely, nothing is
 * recorded and the worktree is left exactly as it is. No agent starts: the operator must click
 * Start execution, which goes through the worker's claim, consent, trust and capacity checks.
 */
export const recoverProjectTask = async (
  db: Database,
  projectId: string,
  taskId: string,
  kind: TaskRecoveryKind,
  input: RecoverTaskInput,
  {
    now = Date.now,
    createId = randomUUID,
    probeProcessGroup = isProcessGroupAlive,
  }: RecoveryServiceOptions = {},
): Promise<Task> => {
  const { project, task } = requireProjectTask(db, projectId, taskId);
  // Early, cheap refusal; the transaction checks the status again.
  if (!taskRecoverySourceStatuses[kind].includes(task.status)) {
    throw new TaskRecoveryError(
      'recovery_not_available',
      `${taskRecoveryKindLabels[kind]} is not available while the task is ${taskStatusLabels[task.status]}.`,
      { status: task.status, kind },
    );
  }
  const taskWorkspaces = listTaskWorkspaces(db, task.id);
  if (taskWorkspaces.length > 1) {
    throw new TaskRecoveryError(
      'workspace_unavailable',
      'This task has more than one worktree record, so it is unclear which one to continue. Nothing was queued or changed.',
    );
  }
  const [workspace] = taskWorkspaces;
  if (workspace !== undefined) {
    const check = await verifyRetainedTaskWorktree({
      repository: project,
      taskId: task.id,
      workspace,
      // The recorded root; the worker additionally requires it to be its configured root.
      worktreeRoot: workspace.worktreeRoot,
    });
    if (!check.ok) {
      throw new TaskRecoveryError(
        'workspace_unavailable',
        `The retained worktree cannot be continued safely: ${check.reason}. Nothing was queued, reset or cleaned. Inspect the worktree (${workspace.path}); if you no longer want this task, Discard it — the worktree and branch are kept.`,
        { reason: check.reason },
      );
    }
  }
  const { task: queued } = requestTaskRecovery(db, {
    id: createId(),
    taskId: task.id,
    kind,
    input,
    expectedWorkspaceId: workspace?.id ?? null,
    probeProcessGroup,
    now: now(),
  });
  return { ...queued };
};

/**
 * Discards the task after an explicit confirmation. A logical state change only: no run, event,
 * review or publication record is deleted, and the worktree and task branch are not touched.
 */
export const discardProjectTask = (
  db: Database,
  projectId: string,
  taskId: string,
  input: DiscardTaskInput,
  { now = Date.now }: Pick<RecoveryServiceOptions, 'now'> = {},
): Task => {
  const { task } = requireProjectTask(db, projectId, taskId);
  return { ...discardTask(db, { taskId: task.id, input, now: now() }) };
};
