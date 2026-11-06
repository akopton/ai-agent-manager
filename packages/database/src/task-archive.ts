import {
  activeTaskRunStatuses,
  activeWorkspaceCleanupStatuses,
  assessTaskArchive,
  TaskError,
  taskIdSchema,
  type TaskArchiveFacts,
} from '@ai-agent-manager/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseConnection } from './client.js';
import { findBlockingPublication } from './publications.js';
import { taskRuns, tasks, workerCommands, workspaceCleanups } from './schema.js';
import type { TaskRecord } from './tasks.js';

// TM-02 — Archive and Restore. Both change only `tasks.archived_at`, in one IMMEDIATE transaction
// that also checks the facts: the status, runs, reviews, recoveries, publications, workspaces and
// timestamps (including `updated_at`) are left exactly as they are. Neither command starts an
// agent, touches Git or removes a worktree.

type Database = DatabaseConnection['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const immediate = { behavior: 'immediate' } as const;

const parseTaskId = (taskId: string): string => {
  const parsed = taskIdSchema.safeParse(taskId);
  if (!parsed.success) throw new TaskError('task_not_found', 'The task does not exist.');
  return parsed.data;
};

/** The archive-relevant database facts of a task. */
export const readTaskArchiveFacts = (
  db: Database | Transaction,
  task: Pick<TaskRecord, 'id' | 'status' | 'archivedAt'>,
): TaskArchiveFacts => ({
  status: task.status,
  archived: task.archivedAt !== null,
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
  blockingPublication: findBlockingPublication(db, task.id) !== undefined,
  pendingCleanup:
    db
      .select({ id: workspaceCleanups.id })
      .from(workspaceCleanups)
      .where(
        and(
          eq(workspaceCleanups.taskId, task.id),
          inArray(workspaceCleanups.status, [...activeWorkspaceCleanupStatuses]),
        ),
      )
      .get() !== undefined,
});

/**
 * Archives the task: hides it from the default board. Refused while it is queued, running or in
 * review, while a start request or an Approve & Push publication is pending, or while its worktree
 * is being removed. Archiving an archived task returns it unchanged (a repeated click is harmless).
 */
export const archiveTask = (
  db: Database,
  { taskId, now }: { taskId: string; now: number },
): TaskRecord => {
  const id = parseTaskId(taskId);
  return db.transaction((tx) => {
    const task = tx.select().from(tasks).where(eq(tasks.id, id)).get();
    if (task === undefined) throw new TaskError('task_not_found', 'The task does not exist.');
    if (task.archivedAt !== null) return task;
    const assessment = assessTaskArchive(readTaskArchiveFacts(tx, task));
    if (!assessment.ok) {
      throw new TaskError('task_not_archivable', assessment.reason, { status: task.status });
    }
    const archived = tx
      .update(tasks)
      .set({ archivedAt: now })
      .where(and(eq(tasks.id, id), eq(tasks.status, task.status)))
      .returning()
      .get();
    if (archived === undefined) {
      throw new TaskError('task_not_archivable', 'The task changed. Reload it and try again.');
    }
    return archived;
  }, immediate);
};

/**
 * Restores an archived task to the board with the status it had. Nothing else changes; restoring
 * an active task returns it unchanged.
 */
export const restoreTask = (db: Database, { taskId }: { taskId: string }): TaskRecord => {
  const id = parseTaskId(taskId);
  return db.transaction((tx) => {
    const task = tx.select().from(tasks).where(eq(tasks.id, id)).get();
    if (task === undefined) throw new TaskError('task_not_found', 'The task does not exist.');
    if (task.archivedAt === null) return task;
    return tx.update(tasks).set({ archivedAt: null }).where(eq(tasks.id, id)).returning().get();
  }, immediate);
};
