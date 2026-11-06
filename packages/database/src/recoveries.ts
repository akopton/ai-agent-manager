import {
  assessPriorProcess,
  discardTaskInputSchema,
  isActiveTaskRunStatus,
  isTaskDiscardableStatus,
  recoverTaskInputSchema,
  taskIdSchema,
  TaskError,
  TaskRecoveryError,
  taskRecoverySourceStatuses,
  taskStatusLabels,
  type DiscardTaskInput,
  type RecoverTaskInput,
  type RecoveryProcessCheck,
  type TaskRecoveryKind,
} from '@ai-agent-manager/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { DatabaseConnection } from './client.js';
import { findBlockingPublication } from './publications.js';
import { findPendingChangeRequest } from './reviews.js';
import { reviews, taskRecoveries, taskRuns, tasks, workspaces } from './schema.js';
import { transitionTask, type TaskRecord } from './tasks.js';

// TM-01 — Retry, Resume and Discard. Each command checks and changes the task in one IMMEDIATE
// transaction, so the attempt the operator saw is the attempt the decision is recorded for. Nothing
// here starts an agent, creates a start request or touches Git: a recovered attempt runs only after
// an explicit Start execution, and Discard deletes no record, worktree or branch.

type Database = DatabaseConnection['db'];

export type TaskRecoveryRecord = typeof taskRecoveries.$inferSelect;

/** Probes whether a process group may still exist (`isProcessGroupAlive` from `packages/git`). */
export type ProcessGroupProbe = (pid: number) => boolean;

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';

const invalidInput = (error: z.ZodError): TaskRecoveryError =>
  new TaskRecoveryError(
    'invalid_recovery_input',
    error.issues[0]?.message ?? 'The request is invalid.',
    {
      issues: error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
    },
  );

const parseTaskId = (taskId: string): string => {
  const parsed = taskIdSchema.safeParse(taskId);
  if (!parsed.success) {
    throw new TaskError('task_not_found', 'The task does not exist.');
  }
  return parsed.data;
};

const alreadyRequested = (): TaskRecoveryError =>
  new TaskRecoveryError(
    'recovery_already_requested',
    'This attempt was already retried or resumed. Reload the page.',
  );

/**
 * Decides how a still-running process of the previous attempt is ruled out, or throws. Shared by
 * the request (web) and the claim (worker): the claim repeats the decision right before it binds
 * the next attempt, so a process that reappeared or a confirmation that was never given refuses the
 * start instead of overlapping two agents in one worktree.
 */
export const decidePriorProcess = (
  run: Pick<
    typeof taskRuns.$inferSelect,
    'attempt' | 'status' | 'pid' | 'authorizationId' | 'errorCode'
  >,
  {
    probe,
    operatorConfirmed,
  }: { probe: ProcessGroupProbe | undefined; operatorConfirmed: boolean },
): RecoveryProcessCheck => {
  const assessment = assessPriorProcess(run);
  if (assessment === 'not_launched') return 'not_launched';
  if (assessment === 'process_group') {
    // Without a probe nothing can be ruled out (fail-closed).
    if (run.pid === null || probe === undefined || probe(run.pid)) {
      throw new TaskRecoveryError(
        'process_may_be_running',
        `The process group of attempt ${run.attempt} (pid ${run.pid ?? 'unknown'}) still exists, so its agent may still be running. Make sure no agent of that attempt is still working in the worktree, stop it if needed, then try again. (The ID may also belong to an unrelated process that reused it.)`,
        { attempt: run.attempt, pid: run.pid },
      );
    }
    return 'process_group_gone';
  }
  if (!operatorConfirmed) {
    throw new TaskRecoveryError(
      'process_stop_unconfirmed',
      `Attempt ${run.attempt} was interrupted by a worker restart after it was authorized but before its process ID was recorded, so AI Agent Manager cannot check whether its agent is still running. Two agents in one worktree could overwrite each other's changes. Verify yourself that no agent process of that attempt, or process it started, is still working in the task worktree, then confirm this explicitly.`,
      { attempt: run.attempt },
    );
  }
  return 'operator_confirmed';
};

export type RequestTaskRecoveryResult = { recovery: TaskRecoveryRecord; task: TaskRecord };

/**
 * Records `Retry` (Failed) or `Resume` (Stopped, Interrupted) for the task's latest attempt and
 * applies the named transition (→ Queued). Requires: the attempt the operator saw is still the
 * latest and not active; no Approve & Push publication holds the task; no change request or other
 * recovery waits; the task's workspace is the one the caller verified (`expectedWorkspaceId`, or
 * none); and a prior process is ruled out (`decidePriorProcess`). The latest review decision of the
 * task is carried, because no attempt after it reached review: its feedback is still unaddressed.
 * Never starts an agent or touches Git.
 */
export const requestTaskRecovery = (
  db: Database,
  {
    id,
    taskId,
    kind,
    input,
    expectedWorkspaceId,
    probeProcessGroup,
    now,
  }: {
    id: string;
    taskId: string;
    kind: TaskRecoveryKind;
    input: RecoverTaskInput;
    /** The workspace the caller re-verified in Git, or `null` when the task has none. */
    expectedWorkspaceId: string | null;
    probeProcessGroup: ProcessGroupProbe | undefined;
    now: number;
  },
): RequestTaskRecoveryResult => {
  const parsedTaskId = parseTaskId(taskId);
  const parsed = recoverTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  const { runId, processStopConfirmed } = parsed.data;

  try {
    return db.transaction(
      (tx) => {
        const task = tx.select().from(tasks).where(eq(tasks.id, parsedTaskId)).get();
        if (task === undefined) {
          throw new TaskError('task_not_found', 'The task does not exist.');
        }
        if (!taskRecoverySourceStatuses[kind].includes(task.status)) {
          throw new TaskRecoveryError(
            'recovery_not_available',
            `${kind === 'retry' ? 'Retry' : 'Resume'} is not available while the task is ${taskStatusLabels[task.status]}.`,
            { status: task.status, kind },
          );
        }
        const latest = tx
          .select()
          .from(taskRuns)
          .where(eq(taskRuns.taskId, task.id))
          .orderBy(desc(taskRuns.attempt))
          .limit(1)
          .get();
        if (latest === undefined || latest.id !== runId) {
          throw new TaskRecoveryError(
            'task_run_changed',
            'The latest attempt is not the one you saw. Reload the page.',
          );
        }
        if (isActiveTaskRunStatus(latest.status)) {
          throw new TaskRecoveryError(
            'task_run_active',
            'An attempt of this task is still active.',
          );
        }
        if (findBlockingPublication(tx, task.id) !== undefined) {
          throw new TaskRecoveryError(
            'publication_in_progress',
            'An Approve & Push publication holds this task. Finish or retry the push first.',
          );
        }
        if (
          findPendingChangeRequest(tx, task.id) !== undefined ||
          findPendingRecovery(tx, task.id) !== undefined
        ) {
          throw alreadyRequested();
        }
        const taskWorkspaces = tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.taskId, task.id))
          .all();
        const workspaceId = taskWorkspaces[0]?.id ?? null;
        if (taskWorkspaces.length > 1 || workspaceId !== expectedWorkspaceId) {
          throw new TaskRecoveryError(
            'workspace_unavailable',
            'The task’s worktree record changed while it was being checked. Reload the page.',
          );
        }
        const processCheck = decidePriorProcess(latest, {
          probe: probeProcessGroup,
          operatorConfirmed: processStopConfirmed,
        });
        const latestReview = tx
          .select({ id: reviews.id })
          .from(reviews)
          .where(eq(reviews.taskId, task.id))
          .orderBy(desc(reviews.createdAt), desc(reviews.id))
          .limit(1)
          .get();
        const recovery = tx
          .insert(taskRecoveries)
          .values({
            id,
            taskId: task.id,
            kind,
            sourceRunId: latest.id,
            sourceStatus: task.status,
            workspaceId,
            reviewId: latestReview?.id ?? null,
            processCheck,
            followUpRunId: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        const queued = transitionTask(tx, { id: task.id, action: kind, now });
        return { recovery, task: queued };
      },
      { behavior: 'immediate' },
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw alreadyRequested();
    }
    throw error;
  }
};

/**
 * Discards the task: the named `discard` transition from Review, Stopped, Interrupted or Failed,
 * after an explicit confirmation for the attempt the operator saw. Refused while a run is active or
 * an Approve & Push publication holds the task. Deletes nothing: runs, events, reviews,
 * publications, the workspace record, the worktree and the task branch are all kept.
 */
export const discardTask = (
  db: Database,
  { taskId, input, now }: { taskId: string; input: DiscardTaskInput; now: number },
): TaskRecord => {
  const parsedTaskId = parseTaskId(taskId);
  const parsed = discardTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }
  return db.transaction(
    (tx) => {
      const task = tx.select().from(tasks).where(eq(tasks.id, parsedTaskId)).get();
      if (task === undefined) {
        throw new TaskError('task_not_found', 'The task does not exist.');
      }
      if (!isTaskDiscardableStatus(task.status)) {
        throw new TaskRecoveryError(
          'discard_not_available',
          `The task cannot be discarded while it is ${taskStatusLabels[task.status]}.`,
          { status: task.status },
        );
      }
      const latest = tx
        .select()
        .from(taskRuns)
        .where(eq(taskRuns.taskId, task.id))
        .orderBy(desc(taskRuns.attempt))
        .limit(1)
        .get();
      if (latest === undefined || latest.id !== parsed.data.runId) {
        throw new TaskRecoveryError(
          'task_run_changed',
          'The latest attempt is not the one you saw. Reload the page.',
        );
      }
      if (isActiveTaskRunStatus(latest.status)) {
        throw new TaskRecoveryError('task_run_active', 'An attempt of this task is still active.');
      }
      if (findBlockingPublication(tx, task.id) !== undefined) {
        throw new TaskRecoveryError(
          'publication_in_progress',
          'An Approve & Push publication holds this task. It cannot be discarded while it is being published or its push is pending.',
        );
      }
      return transitionTask(tx, { id: task.id, action: 'discard', now });
    },
    { behavior: 'immediate' },
  );
};

/** The recovery that waits for its attempt, if any (at most one per task). */
export const findPendingRecovery = (db: Database, taskId: string): TaskRecoveryRecord | undefined =>
  db
    .select()
    .from(taskRecoveries)
    .where(and(eq(taskRecoveries.taskId, taskId), isNull(taskRecoveries.followUpRunId)))
    .get();

/** All Retry/Resume decisions of a task, newest first. */
export const listTaskRecoveries = (db: Database, taskId: string): TaskRecoveryRecord[] =>
  db
    .select()
    .from(taskRecoveries)
    .where(eq(taskRecoveries.taskId, taskId))
    .orderBy(desc(taskRecoveries.createdAt), desc(taskRecoveries.id))
    .all();
