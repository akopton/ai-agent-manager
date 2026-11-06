import { z } from 'zod';
import type { TaskRunStatus } from './execution.js';
import { taskTransitions, type TaskStatus } from './task.js';

// TM-01 — Retry, Resume & Discard. Recovery queues a new attempt after a failed, stopped or
// interrupted run; Discard is a logical task-state change. Neither starts an agent, and neither
// resets, cleans, removes or prunes anything in Git: a recovered attempt starts only through an
// explicit Start execution and continues in the task's retained worktree when one exists.
//
// Resume here is a **workspace continuation in a new agent CLI session**, never a restore of the
// previous CLI session (`SPEC.md` §11 describes session resume as optional and not guaranteed).

/** Recovery kinds. Each is a named task transition (`taskTransitions.retry` / `.resume`). */
export const taskRecoveryKinds = ['retry', 'resume'] as const;

export const taskRecoveryKindSchema = z.enum(taskRecoveryKinds);

export type TaskRecoveryKind = z.infer<typeof taskRecoveryKindSchema>;

export const taskRecoveryKindLabels: Readonly<Record<TaskRecoveryKind, string>> = {
  retry: 'Retry',
  resume: 'Resume',
};

/**
 * The states each recovery is offered from (TM-01). This is deliberately **narrower** than the
 * domain table (`taskTransitions.retry` also lists Stopped and Interrupted): both kinds continue in
 * the same retained worktree, so offering both for one state would be two names for one action.
 * Failed → Retry; Stopped and Interrupted → Resume.
 */
export const taskRecoverySourceStatuses: Readonly<Record<TaskRecoveryKind, readonly TaskStatus[]>> =
  {
    retry: ['failed'],
    resume: ['stopped', 'interrupted'],
  };

/** The recovery offered for a task status, or `null` when none is. */
export const recoveryKindForStatus = (status: TaskStatus): TaskRecoveryKind | null =>
  taskRecoveryKinds.find((kind) => taskRecoverySourceStatuses[kind].includes(status)) ?? null;

/** Statuses a task can be discarded from: exactly the domain's `discard` transition. */
export const taskDiscardSourceStatuses: readonly TaskStatus[] = taskTransitions.discard.from;

export const isTaskDiscardableStatus = (status: TaskStatus): boolean =>
  taskDiscardSourceStatuses.includes(status);

/**
 * Whether the previous attempt's agent process can have outlived its run record:
 *
 * - `not_launched`: the run never received an authorization, so the launch boundary never started a
 *   process; or the worker that owned it recorded the outcome itself without a process ID.
 * - `process_group`: a process ID was recorded; the caller must probe that process group, and
 *   refuse while it exists.
 * - `unknown`: a restarted worker reconciled the run after it was authorized but before its process
 *   ID was recorded. Nobody can tell whether a process was started, so the operator must confirm
 *   that no agent process is still working in the worktree.
 */
export type PriorProcessAssessment = 'not_launched' | 'process_group' | 'unknown';

export const assessPriorProcess = (run: {
  status: TaskRunStatus;
  pid: number | null;
  authorizationId: string | null;
  errorCode: string | null;
}): PriorProcessAssessment => {
  if (run.pid !== null) return 'process_group';
  if (run.authorizationId === null) return 'not_launched';
  return run.status === 'interrupted' && run.errorCode === 'worker_restarted'
    ? 'unknown'
    : 'not_launched';
};

/**
 * How the prior process was ruled out when the recovery was recorded. Stored with the recovery so
 * the worker's claim can require the same confirmation again.
 */
export const recoveryProcessChecks = [
  'not_launched',
  'process_group_gone',
  'operator_confirmed',
] as const;

export const recoveryProcessCheckSchema = z.enum(recoveryProcessChecks);

export type RecoveryProcessCheck = z.infer<typeof recoveryProcessCheckSchema>;

/**
 * `Retry` / `Resume` for the attempt the operator saw. `runId` makes a stale page fail instead of
 * recovering a different attempt. `processStopConfirmed` is required only when the previous
 * process cannot be ruled out automatically (`assessPriorProcess` → `unknown`).
 */
export const recoverTaskInputSchema = z.strictObject({
  runId: z.uuid(),
  processStopConfirmed: z.boolean().default(false),
});

export type RecoverTaskInput = z.input<typeof recoverTaskInputSchema>;

/**
 * `Discard` for the attempt the operator saw. `confirmed: true` records the deliberate decision;
 * Discard deletes nothing and touches no Git data.
 */
export const discardTaskInputSchema = z.strictObject({
  runId: z.uuid(),
  confirmed: z.literal(true, { error: 'Confirm that you want to discard this task.' }),
});

export type DiscardTaskInput = z.input<typeof discardTaskInputSchema>;

/** Expected reasons a Retry, Resume or Discard request is rejected. */
export const taskRecoveryErrorCodes = [
  'invalid_recovery_input',
  /** The task's status does not offer this recovery. */
  'recovery_not_available',
  /** The task's status does not allow Discard. */
  'discard_not_available',
  /** A newer attempt exists than the one the operator saw. */
  'task_run_changed',
  /** A run of the task is active. */
  'task_run_active',
  /** An Approve & Push publication holds the task. */
  'publication_in_progress',
  /** A recovery or change request already waits for the next attempt. */
  'recovery_already_requested',
  /** The retained worktree cannot be continued safely; nothing was changed. */
  'workspace_unavailable',
  /** The previous attempt's process group still exists (or its ID was reused). */
  'process_may_be_running',
  /** The previous process cannot be ruled out automatically; the operator must confirm. */
  'process_stop_unconfirmed',
] as const;

export const taskRecoveryErrorCodeSchema = z.enum(taskRecoveryErrorCodes);

export type TaskRecoveryErrorCode = z.infer<typeof taskRecoveryErrorCodeSchema>;

export class TaskRecoveryError extends Error {
  override name = 'TaskRecoveryError';

  constructor(
    readonly code: TaskRecoveryErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}
