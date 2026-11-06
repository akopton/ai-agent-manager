import {
  activeTaskRunStatuses,
  assessWorkspaceCleanup,
  requestWorkspaceCleanupInputSchema,
  taskIdSchema,
  truncateText,
  WorkspaceCleanupError,
  type RequestWorkspaceCleanupInput,
  type WorkspaceCleanupAssessment,
  type WorkspaceCleanupFacts,
  type WorkspaceCleanupStatus,
} from '@ai-agent-manager/core';
import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { DatabaseConnection } from './client.js';
import { findBlockingPublication } from './publications.js';
import {
  publications,
  reviews,
  taskRecoveries,
  taskRuns,
  tasks,
  workerCommands,
  workspaceCleanups,
  workspaces,
} from './schema.js';
import type { TaskRecord } from './tasks.js';

// TM-02 — Removal of a task's managed local worktree. The web process records an operator request
// (`requested`) after a read-only Git check; the worker claims it (`removing`), re-verifies Git
// state and removes only the linked worktree directory, then records `removed` or `failed`. Every
// state change is a compare-and-swap in one IMMEDIATE transaction that re-reads the task's records,
// so a request is never executed for a task that started to need its worktree again. A partial
// unique index allows at most one requested, running or completed removal per workspace. Rows are
// never deleted, and the workspace, run, review and publication records are never changed.

type Database = DatabaseConnection['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type WorkspaceCleanupRecord = typeof workspaceCleanups.$inferSelect;
type WorkspaceRecord = typeof workspaces.$inferSelect;

const immediate = { behavior: 'immediate' } as const;
const maxErrorMessageLength = 1_000;

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';

const alreadyRequested = (): WorkspaceCleanupError =>
  new WorkspaceCleanupError(
    'cleanup_already_requested',
    'Removal of this worktree was already requested. Reload the page.',
  );

/** The newest cleanup of a workspace, optionally ignoring one row (the one being claimed). */
const latestCleanup = (
  db: Database | Transaction,
  workspaceId: string,
  excludeId?: string,
): WorkspaceCleanupRecord | undefined =>
  db
    .select()
    .from(workspaceCleanups)
    .where(eq(workspaceCleanups.workspaceId, workspaceId))
    .orderBy(desc(workspaceCleanups.createdAt), desc(workspaceCleanups.id))
    .all()
    .find((row) => row.id !== excludeId);

/** The cleanup-relevant database facts of a task and one of its workspaces. */
export const readWorkspaceCleanupFacts = (
  db: Database | Transaction,
  task: Pick<TaskRecord, 'id' | 'status'>,
  workspace: Pick<WorkspaceRecord, 'id' | 'baseSha'>,
  { excludeCleanupId }: { excludeCleanupId?: string } = {},
): WorkspaceCleanupFacts => {
  const latestRun = db
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.taskId, task.id))
    .orderBy(desc(taskRuns.attempt))
    .limit(1)
    .get();
  const latestPublication = db
    .select()
    .from(publications)
    .where(eq(publications.taskId, task.id))
    .orderBy(desc(publications.createdAt), desc(publications.id))
    .limit(1)
    .get();
  const cleanup = latestCleanup(db, workspace.id, excludeCleanupId);
  return {
    taskStatus: task.status,
    workspace: { id: workspace.id, baseSha: workspace.baseSha },
    workspaceCount: db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.taskId, task.id))
      .all().length,
    latestRun:
      latestRun === undefined
        ? null
        : { id: latestRun.id, status: latestRun.status, workspaceId: latestRun.workspaceId },
    activeRun:
      db
        .select({ id: taskRuns.id })
        .from(taskRuns)
        .where(
          and(eq(taskRuns.taskId, task.id), inArray(taskRuns.status, [...activeTaskRunStatuses])),
        )
        .get() !== undefined,
    pendingStart:
      db
        .select({ id: workerCommands.id })
        .from(workerCommands)
        .where(and(eq(workerCommands.taskId, task.id), eq(workerCommands.status, 'pending')))
        .get() !== undefined,
    pendingFollowUp:
      db
        .select({ id: reviews.id })
        .from(reviews)
        .where(
          and(
            eq(reviews.taskId, task.id),
            eq(reviews.status, 'changes_requested'),
            isNull(reviews.followUpRunId),
          ),
        )
        .get() !== undefined ||
      db
        .select({ id: taskRecoveries.id })
        .from(taskRecoveries)
        .where(and(eq(taskRecoveries.taskId, task.id), isNull(taskRecoveries.followUpRunId)))
        .get() !== undefined,
    blockingPublication: findBlockingPublication(db, task.id) !== undefined,
    latestPublication:
      latestPublication === undefined
        ? null
        : {
            runId: latestPublication.runId,
            workspaceId: latestPublication.workspaceId,
            status: latestPublication.status,
            commitSha: latestPublication.commitSha,
          },
    cleanup: cleanup === undefined ? null : { status: cleanup.status },
  };
};

/** Assesses a workspace of a task from its records. Read-only. */
export const assessTaskWorkspaceCleanup = (
  db: Database | Transaction,
  task: Pick<TaskRecord, 'id' | 'status'>,
  workspace: Pick<WorkspaceRecord, 'id' | 'baseSha'>,
): WorkspaceCleanupAssessment =>
  assessWorkspaceCleanup(readWorkspaceCleanupFacts(db, task, workspace));

const sameRequest = (
  existing: WorkspaceCleanupRecord,
  taskId: string,
  workspaceId: string,
): WorkspaceCleanupRecord => {
  if (existing.taskId !== taskId || existing.workspaceId !== workspaceId) {
    throw new WorkspaceCleanupError(
      'invalid_cleanup_input',
      'This request ID was already used for another worktree.',
    );
  }
  return existing;
};

/**
 * Records the operator's confirmed request to remove the task's worktree. Requires the workspace to
 * belong to the task, the task's records to allow removal (`assessWorkspaceCleanup`) and the
 * expected commit to be the one the operator saw. The caller checks Git state read-only first; the
 * worker checks it again before removing anything. A repeated `requestId` returns the existing
 * request (`created: false`). Nothing is changed in Git here.
 */
export const requestWorkspaceCleanup = (
  db: Database,
  {
    id,
    taskId,
    input,
    now,
  }: { id: string; taskId: string; input: RequestWorkspaceCleanupInput; now: number },
): { cleanup: WorkspaceCleanupRecord; created: boolean } => {
  const parsedTaskId = taskIdSchema.safeParse(taskId);
  if (!parsedTaskId.success) {
    throw new WorkspaceCleanupError('workspace_not_found', 'The task does not exist.');
  }
  const parsed = requestWorkspaceCleanupInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkspaceCleanupError(
      'invalid_cleanup_input',
      parsed.error.issues[0]?.message ?? 'The request is invalid.',
    );
  }
  const { requestId, workspaceId, expectedCommit } = parsed.data;
  try {
    return db.transaction((tx) => {
      const existing = tx
        .select()
        .from(workspaceCleanups)
        .where(eq(workspaceCleanups.requestId, requestId))
        .get();
      if (existing !== undefined) {
        return { cleanup: sameRequest(existing, parsedTaskId.data, workspaceId), created: false };
      }
      const task = tx.select().from(tasks).where(eq(tasks.id, parsedTaskId.data)).get();
      const workspace = tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
      if (task === undefined || workspace === undefined || workspace.taskId !== task.id) {
        throw new WorkspaceCleanupError(
          'workspace_not_found',
          'The worktree record does not exist for this task.',
        );
      }
      const assessment = assessTaskWorkspaceCleanup(tx, task, workspace);
      if (!assessment.ok) {
        if (assessment.code === 'cleanup_in_progress') throw alreadyRequested();
        throw new WorkspaceCleanupError('cleanup_not_available', assessment.message, {
          reason: assessment.code,
        });
      }
      if (assessment.expectedCommit !== expectedCommit) {
        throw new WorkspaceCleanupError(
          'cleanup_state_changed',
          'The task’s published or base commit is not the one you saw. Reload the page.',
        );
      }
      if (task.status !== 'done' && task.status !== 'discarded') {
        throw new WorkspaceCleanupError(
          'cleanup_not_available',
          'Only Done or Discarded tasks can remove their worktree.',
        );
      }
      const cleanup = tx
        .insert(workspaceCleanups)
        .values({
          id,
          requestId,
          taskId: task.id,
          workspaceId: workspace.id,
          status: 'requested',
          basis: assessment.basis,
          taskStatus: task.status,
          expectedCommit,
          branchCommit: null,
          errorCode: null,
          errorMessage: null,
          workerInstanceId: null,
          createdAt: now,
          updatedAt: now,
          removedAt: null,
        })
        .returning()
        .get();
      return { cleanup, created: true };
    }, immediate);
  } catch (error) {
    if (isUniqueConstraintError(error)) throw alreadyRequested();
    throw error;
  }
};

const updateStatus = (
  tx: Database | Transaction,
  id: string,
  from: WorkspaceCleanupStatus,
  values: Partial<typeof workspaceCleanups.$inferInsert> & {
    status: WorkspaceCleanupStatus;
    updatedAt: number;
  },
): WorkspaceCleanupRecord | undefined =>
  tx
    .update(workspaceCleanups)
    .set(values)
    .where(and(eq(workspaceCleanups.id, id), eq(workspaceCleanups.status, from)))
    .returning()
    .get();

export type WorkspaceCleanupClaim =
  | { claimed: true; cleanup: WorkspaceCleanupRecord; workspace: WorkspaceRecord; task: TaskRecord }
  | { claimed: false; cleanup: WorkspaceCleanupRecord | undefined };

/**
 * Claims a requested cleanup for the worker (`requested` → `removing`). The task's records are
 * assessed again in the same transaction; if they no longer allow removal, or the expected commit
 * differs, the request fails here and nothing is removed. Returns `claimed: false` when the request
 * is no longer `requested` (another claim won) or was refused.
 */
export const claimWorkspaceCleanup = (
  db: Database,
  { id, workerInstanceId, now }: { id: string; workerInstanceId: string; now: number },
): WorkspaceCleanupClaim =>
  db.transaction((tx) => {
    const current = tx.select().from(workspaceCleanups).where(eq(workspaceCleanups.id, id)).get();
    if (current === undefined || current.status !== 'requested') {
      return { claimed: false, cleanup: current };
    }
    const task = tx.select().from(tasks).where(eq(tasks.id, current.taskId)).get();
    const workspace = tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, current.workspaceId))
      .get();
    const refuse = (code: string, message: string): WorkspaceCleanupClaim => ({
      claimed: false,
      cleanup: updateStatus(tx, id, 'requested', {
        status: 'failed',
        errorCode: code,
        errorMessage: truncateText(message, maxErrorMessageLength),
        workerInstanceId,
        updatedAt: now,
      }),
    });
    if (task === undefined || workspace === undefined || workspace.taskId !== task.id) {
      return refuse('workspace_not_found', 'The task or worktree record is missing.');
    }
    const assessment = assessWorkspaceCleanup(
      readWorkspaceCleanupFacts(tx, task, workspace, { excludeCleanupId: id }),
    );
    if (!assessment.ok) {
      return refuse(assessment.code, `${assessment.message} Nothing was removed.`);
    }
    if (
      assessment.expectedCommit !== current.expectedCommit ||
      task.status !== current.taskStatus
    ) {
      return refuse(
        'cleanup_state_changed',
        'The task changed after the removal was requested. Nothing was removed.',
      );
    }
    const cleanup = updateStatus(tx, id, 'requested', {
      status: 'removing',
      workerInstanceId,
      updatedAt: now,
    });
    if (cleanup === undefined) return { claimed: false, cleanup: current };
    return { claimed: true, cleanup, workspace, task };
  }, immediate);

/** Records the removal. `note` explains an unexpected but safe outcome (for example a moved branch). */
export const completeWorkspaceCleanup = (
  db: Database,
  {
    id,
    branchCommit,
    note,
    now,
  }: {
    id: string;
    branchCommit: string | null;
    note?: { code: string; message: string };
    now: number;
  },
): WorkspaceCleanupRecord => {
  const record = db.transaction(
    (tx) =>
      updateStatus(tx, id, 'removing', {
        status: 'removed',
        branchCommit,
        errorCode: note?.code ?? null,
        errorMessage: note === undefined ? null : truncateText(note.message, maxErrorMessageLength),
        removedAt: now,
        updatedAt: now,
      }),
    immediate,
  );
  if (record === undefined) {
    throw new Error(`Workspace cleanup ${id} is not being removed; it was changed concurrently.`);
  }
  return record;
};

/** Records that nothing was removed (or what is known), from `requested` or `removing`. */
export const failWorkspaceCleanup = (
  db: Database,
  {
    id,
    from,
    code,
    message,
    now,
  }: {
    id: string;
    from: 'requested' | 'removing';
    code: string;
    message: string;
    now: number;
  },
): WorkspaceCleanupRecord | undefined =>
  db.transaction(
    (tx) =>
      updateStatus(tx, id, from, {
        status: 'failed',
        errorCode: code,
        errorMessage: truncateText(message, maxErrorMessageLength),
        updatedAt: now,
      }),
    immediate,
  );

/** Requested cleanups waiting for the worker, oldest first. */
export const listQueuedWorkspaceCleanups = (db: Database): WorkspaceCleanupRecord[] =>
  db
    .select()
    .from(workspaceCleanups)
    .where(eq(workspaceCleanups.status, 'requested'))
    .orderBy(asc(workspaceCleanups.createdAt), asc(workspaceCleanups.id))
    .all();

/** Cleanups a worker was executing (for restart reconciliation). */
export const listInFlightWorkspaceCleanups = (db: Database): WorkspaceCleanupRecord[] =>
  db.select().from(workspaceCleanups).where(eq(workspaceCleanups.status, 'removing')).all();

/**
 * Fails requests created before `olderThan` that no worker claimed. A removal that waited for a
 * stopped worker is never executed silently when the worker comes back.
 */
export const expireRequestedWorkspaceCleanups = (
  db: Database,
  { olderThan, now }: { olderThan: number; now: number },
): number =>
  db
    .update(workspaceCleanups)
    .set({
      status: 'failed',
      errorCode: 'request_expired',
      errorMessage:
        'The worker did not pick up the removal in time. Nothing was removed; request it again if you still want to.',
      updatedAt: now,
    })
    .where(
      and(eq(workspaceCleanups.status, 'requested'), lt(workspaceCleanups.createdAt, olderThan)),
    )
    .run().changes;

/** All cleanups of a task, newest first. */
export const listTaskWorkspaceCleanups = (db: Database, taskId: string): WorkspaceCleanupRecord[] =>
  db
    .select()
    .from(workspaceCleanups)
    .where(eq(workspaceCleanups.taskId, taskId))
    .orderBy(desc(workspaceCleanups.createdAt), desc(workspaceCleanups.id))
    .all();

export const findWorkspaceCleanup = (
  db: Database,
  id: string,
): WorkspaceCleanupRecord | undefined =>
  db.select().from(workspaceCleanups).where(eq(workspaceCleanups.id, id)).get();

/** The cleanup recorded for a client request ID (repeated submissions return it). */
export const findWorkspaceCleanupByRequest = (
  db: Database,
  requestId: string,
): WorkspaceCleanupRecord | undefined =>
  db.select().from(workspaceCleanups).where(eq(workspaceCleanups.requestId, requestId)).get();
