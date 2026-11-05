import {
  isRunReviewEligible,
  requestChangesInputSchema,
  ReviewActionError,
  TaskError,
  taskIdSchema,
  taskStatusLabels,
  type RequestChangesInput,
} from '@ai-agent-manager/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DatabaseConnection } from './client.js';
import { reviews, taskRuns, tasks } from './schema.js';
import { transitionTask, type TaskRecord } from './tasks.js';

// Review decisions (M6-02, Request Changes). Recording feedback and the named `request_changes`
// transition happen in one IMMEDIATE transaction, so the run that was reviewed is the run the
// feedback is attached to. Nothing here starts an agent, creates a start request or touches the
// repository: the next attempt starts only through an explicit operator Start.

type Database = DatabaseConnection['db'];

export type ReviewRecord = typeof reviews.$inferSelect;

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';

const alreadyRequested = (): ReviewActionError =>
  new ReviewActionError(
    'changes_already_requested',
    'Changes were already requested for this attempt. Reload the page.',
  );

/**
 * Records `Request Changes` for the task's latest run and moves the task Review → Queued with the
 * named `request_changes` transition. Requires the task to be in `Review`, the latest run to be
 * `runId` and eligible for normal review (completed, clean Git integrity check, recorded
 * workspace), and no earlier decision for that run. `revision` is the change-inventory revision
 * the reviewer saw; the caller compares it with a fresh inspection before calling this.
 */
export const requestTaskChanges = (
  db: Database,
  {
    id,
    taskId,
    input,
    now,
  }: { id: string; taskId: string; input: RequestChangesInput; now: number },
): { review: ReviewRecord; task: TaskRecord } => {
  const parsedTask = taskIdSchema.safeParse(taskId);
  if (!parsedTask.success) {
    throw new TaskError('task_not_found', 'The task does not exist.');
  }
  const parsed = requestChangesInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReviewActionError(
      'invalid_review_input',
      parsed.error.issues[0]?.message ?? 'The change request is invalid.',
      {
        issues: parsed.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
      },
    );
  }
  const { runId, revision, feedback } = parsed.data;

  try {
    return db.transaction(
      (tx) => {
        const task = tx.select().from(tasks).where(eq(tasks.id, parsedTask.data)).get();
        if (task === undefined) {
          throw new TaskError('task_not_found', 'The task does not exist.');
        }
        const latest = tx
          .select()
          .from(taskRuns)
          .where(eq(taskRuns.taskId, task.id))
          .orderBy(desc(taskRuns.attempt))
          .limit(1)
          .get();
        const existing = tx.select().from(reviews).where(eq(reviews.runId, runId)).get();
        if (existing !== undefined && existing.taskId === task.id) {
          throw alreadyRequested();
        }
        if (task.status !== 'review') {
          throw new ReviewActionError(
            'task_not_in_review',
            `Changes can be requested only while the task is in Review (it is ${taskStatusLabels[task.status]}).`,
            { status: task.status },
          );
        }
        if (latest === undefined || latest.id !== runId) {
          throw new ReviewActionError(
            'review_run_changed',
            'A newer attempt exists than the one you reviewed. Reload the page.',
          );
        }
        if (!isRunReviewEligible(latest) || latest.workspaceId === null) {
          throw new ReviewActionError(
            'run_not_review_eligible',
            'The latest attempt is not eligible for the normal review path.',
          );
        }
        const review = tx
          .insert(reviews)
          .values({
            id,
            taskId: task.id,
            runId: latest.id,
            workspaceId: latest.workspaceId,
            status: 'changes_requested',
            feedback,
            inventoryRevision: revision,
            followUpRunId: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        const queued = transitionTask(tx, { id: task.id, action: 'request_changes', now });
        return { review, task: queued };
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

/** All review decisions of a task, newest first. */
export const listTaskReviews = (db: Database, taskId: string): ReviewRecord[] =>
  db
    .select()
    .from(reviews)
    .where(eq(reviews.taskId, taskId))
    .orderBy(desc(reviews.createdAt), desc(reviews.id))
    .all();

/** The change request that waits for its follow-up attempt, if any (at most one per task). */
export const findPendingChangeRequest = (db: Database, taskId: string): ReviewRecord | undefined =>
  db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.taskId, taskId),
        eq(reviews.status, 'changes_requested'),
        isNull(reviews.followUpRunId),
      ),
    )
    .get();
