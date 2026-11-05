import {
  activePublicationStatuses,
  isRunReviewEligible,
  PublicationError,
  taskIdSchema,
  taskStatusLabels,
  truncateText,
  type PublicationFailureStage,
  type PublicationStatus,
} from '@ai-agent-manager/core';
import { and, asc, desc, eq, inArray, isNotNull, max } from 'drizzle-orm';
import type { DatabaseConnection } from './client.js';
import { gitOperations, publications, reviews, taskRuns, tasks } from './schema.js';
import { transitionTask, type TaskRecord } from './tasks.js';

// Approve & Push (M6-03). The web process records an approval (status `approved`) after checking
// it against a fresh inspection; the worker claims it and advances it through commit and push.
// Every state change is a compare-and-swap inside one IMMEDIATE transaction, so a double click, two
// browser tabs or two processes can never publish the same task twice: at most one active
// publication per task is also enforced by a partial unique index. The task leaves `Review` only
// in the transaction that records a successful push (`mark_done`).

type Database = DatabaseConnection['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type PublicationRecord = typeof publications.$inferSelect;
export type GitOperationRecord = typeof gitOperations.$inferSelect;

const immediate = { behavior: 'immediate' } as const;
const maxErrorMessageLength = 1_000;

const activeStatuses: PublicationStatus[] = [...activePublicationStatuses];

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';

/**
 * A publication that holds the task: one that is active, or one that failed at the push stage, whose
 * commit is on the task branch but not (confirmed) on the remote. Only its push may be retried; a
 * new approval would publish a second commit. A commit object recorded before a failed branch
 * update (stage `commit`) is not on the branch and does not hold the task.
 */
export const findBlockingPublication = (
  db: Database | Transaction,
  taskId: string,
): PublicationRecord | undefined =>
  db
    .select()
    .from(publications)
    .where(and(eq(publications.taskId, taskId), inArray(publications.status, activeStatuses)))
    .get() ??
  db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.taskId, taskId),
        eq(publications.status, 'failed'),
        eq(publications.failureStage, 'push'),
        isNotNull(publications.commitSha),
      ),
    )
    .orderBy(desc(publications.createdAt))
    .get();

export type NewPublication = {
  id: string;
  requestId: string;
  taskId: string;
  runId: string;
  workspaceId: string;
  inventoryRevision: string;
  snapshotHash: string;
  snapshotJson: string;
  fileCount: number;
  baseCommit: string;
  branch: string;
  remoteName: string;
  remoteUrl: string;
  remoteUrlDigest: string;
  commitMessage: string;
};

const findByRequest = (db: Database | Transaction, requestId: string) =>
  db.select().from(publications).where(eq(publications.requestId, requestId)).get();

const sameRequest = (existing: PublicationRecord, input: NewPublication): PublicationRecord => {
  if (existing.taskId !== input.taskId || existing.runId !== input.runId) {
    throw new PublicationError(
      'invalid_publication_input',
      'This request ID was already used for another approval.',
    );
  }
  return existing;
};

/**
 * Records an operator approval for the task's latest run. Requires the task in `Review`, `runId`
 * as its latest run, eligible for normal review (completed, clean Git integrity) in the recorded
 * workspace, no review decision for that run, and no publication that holds the task. A repeated
 * `requestId` for the same task and run returns the existing approval (`created: false`).
 */
export const createPublication = (
  db: Database,
  { input, now }: { input: NewPublication; now: number },
): { publication: PublicationRecord; created: boolean } => {
  if (!taskIdSchema.safeParse(input.taskId).success) {
    throw new PublicationError('publication_not_found', 'The task does not exist.');
  }
  try {
    return db.transaction((tx) => {
      const existing = findByRequest(tx, input.requestId);
      if (existing !== undefined) {
        return { publication: sameRequest(existing, input), created: false };
      }
      const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
      if (task === undefined) {
        throw new PublicationError('publication_not_found', 'The task does not exist.');
      }
      if (task.status !== 'review') {
        throw new PublicationError(
          'task_not_in_review',
          `Only a task in Review can be approved (it is ${taskStatusLabels[task.status]}).`,
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
      if (latest === undefined || latest.id !== input.runId) {
        throw new PublicationError(
          'review_run_changed',
          'A newer attempt exists than the one you reviewed. Reload the page.',
        );
      }
      if (!isRunReviewEligible(latest) || latest.workspaceId !== input.workspaceId) {
        throw new PublicationError(
          'run_not_review_eligible',
          'The latest attempt is not eligible for the normal review path.',
        );
      }
      if (tx.select().from(reviews).where(eq(reviews.runId, latest.id)).get() !== undefined) {
        throw new PublicationError(
          'review_decision_exists',
          'Changes were already requested for this attempt. Reload the page.',
        );
      }
      const blocking = findBlockingPublication(tx, task.id);
      if (blocking !== undefined) {
        throw blocking.status === 'failed'
          ? new PublicationError(
              'publication_push_pending',
              'A commit of this task exists but was not pushed. Retry the push instead of approving again.',
              { publicationId: blocking.id },
            )
          : new PublicationError(
              'publication_in_progress',
              'This task is already being published. Reload the page.',
              { publicationId: blocking.id },
            );
      }
      const publication = tx
        .insert(publications)
        .values({
          ...input,
          status: 'approved',
          failureStage: null,
          errorCode: null,
          errorMessage: null,
          commitSha: null,
          treeSha: null,
          workerInstanceId: null,
          createdAt: now,
          updatedAt: now,
          committedAt: null,
          pushedAt: null,
        })
        .returning()
        .get();
      return { publication, created: true };
    }, immediate);
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const existing = findByRequest(db, input.requestId);
    if (existing !== undefined)
      return { publication: sameRequest(existing, input), created: false };
    throw new PublicationError(
      'publication_in_progress',
      'This task is already being published. Reload the page.',
    );
  }
};

export const findPublication = (db: Database, id: string): PublicationRecord | undefined =>
  db.select().from(publications).where(eq(publications.id, id)).get();

/** The publication recorded for a client request ID (repeated submissions return it). */
export const findPublicationByRequest = (
  db: Database,
  requestId: string,
): PublicationRecord | undefined => findByRequest(db, requestId);

/** All publications of a task, newest first. */
export const listTaskPublications = (db: Database, taskId: string): PublicationRecord[] =>
  db
    .select()
    .from(publications)
    .where(eq(publications.taskId, taskId))
    .orderBy(desc(publications.createdAt), desc(publications.id))
    .all();

/** Git operations of the given publications, oldest first. */
export const listGitOperations = (
  db: Database,
  publicationIds: readonly string[],
): GitOperationRecord[] =>
  publicationIds.length === 0
    ? []
    : db
        .select()
        .from(gitOperations)
        .where(inArray(gitOperations.publicationId, [...publicationIds]))
        .orderBy(asc(gitOperations.startedAt), asc(gitOperations.attempt))
        .all();

/** Publications waiting for the worker (approved, or a push retry), oldest first. */
export const listQueuedPublications = (db: Database): PublicationRecord[] =>
  db
    .select()
    .from(publications)
    .where(inArray(publications.status, ['approved', 'push_requested']))
    .orderBy(asc(publications.updatedAt), asc(publications.id))
    .all();

/** Publications a worker was executing (for restart reconciliation). */
export const listInFlightPublications = (db: Database): PublicationRecord[] =>
  db
    .select()
    .from(publications)
    .where(inArray(publications.status, ['committing', 'committed', 'pushing']))
    .all();

const nextAttempt = (tx: Transaction, publicationId: string, kind: 'commit' | 'push'): number =>
  (tx
    .select({ value: max(gitOperations.attempt) })
    .from(gitOperations)
    .where(and(eq(gitOperations.publicationId, publicationId), eq(gitOperations.kind, kind)))
    .get()?.value ?? 0) + 1;

const insertOperation = (
  tx: Transaction,
  publication: PublicationRecord,
  { id, kind, now }: { id: string; kind: 'commit' | 'push'; now: number },
): GitOperationRecord =>
  tx
    .insert(gitOperations)
    .values({
      id,
      publicationId: publication.id,
      taskId: publication.taskId,
      kind,
      attempt: nextAttempt(tx, publication.id, kind),
      status: 'running',
      commitSha: publication.commitSha,
      remoteName: kind === 'push' ? publication.remoteName : null,
      ref: `refs/heads/${publication.branch}`,
      outcome: null,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      finishedAt: null,
    })
    .returning()
    .get();

const updateStatus = (
  tx: Transaction,
  id: string,
  from: PublicationStatus,
  values: Partial<typeof publications.$inferInsert> & {
    status: PublicationStatus;
    updatedAt: number;
  },
): PublicationRecord | undefined =>
  tx
    .update(publications)
    .set(values)
    .where(and(eq(publications.id, id), eq(publications.status, from)))
    .returning()
    .get();

export type PublicationClaim = {
  publication: PublicationRecord;
  operation: GitOperationRecord;
};

/**
 * Claims a queued publication for the worker: `approved` → `committing` with a running commit
 * operation, or `push_requested` → `pushing` with a new push attempt. Returns `null` when the
 * publication is no longer in that state (another claim won).
 */
export const claimPublication = (
  db: Database,
  {
    id,
    operationId,
    workerInstanceId,
    now,
  }: { id: string; operationId: string; workerInstanceId: string; now: number },
): PublicationClaim | null =>
  db.transaction((tx) => {
    const current = tx.select().from(publications).where(eq(publications.id, id)).get();
    if (current === undefined) return null;
    if (current.status === 'approved') {
      const publication = updateStatus(tx, id, 'approved', {
        status: 'committing',
        workerInstanceId,
        updatedAt: now,
      });
      if (publication === undefined) return null;
      return {
        publication,
        operation: insertOperation(tx, publication, { id: operationId, kind: 'commit', now }),
      };
    }
    if (current.status === 'push_requested') {
      const publication = updateStatus(tx, id, 'push_requested', {
        status: 'pushing',
        workerInstanceId,
        updatedAt: now,
      });
      if (publication === undefined) return null;
      return {
        publication,
        operation: insertOperation(tx, publication, { id: operationId, kind: 'push', now }),
      };
    }
    return null;
  }, immediate);

const finishRunningOperation = (
  tx: Transaction,
  publicationId: string,
  values: Partial<typeof gitOperations.$inferInsert> & { status: 'succeeded' | 'failed' },
): void => {
  tx.update(gitOperations)
    .set(values)
    .where(and(eq(gitOperations.publicationId, publicationId), eq(gitOperations.status, 'running')))
    .run();
};

const stateChanged = (id: string): Error =>
  new Error(`Publication ${id} is not in the expected state; it was changed concurrently.`);

/**
 * Persists the commit object before the task branch moves, so a crash between the two can be
 * reconciled: if the branch points at this SHA afterwards, the commit happened.
 */
export const recordPublicationCommitObject = (
  db: Database,
  { id, commitSha, treeSha, now }: { id: string; commitSha: string; treeSha: string; now: number },
): PublicationRecord =>
  db.transaction((tx) => {
    const publication = updateStatus(tx, id, 'committing', {
      status: 'committing',
      commitSha,
      treeSha,
      updatedAt: now,
    });
    if (publication === undefined) throw stateChanged(id);
    tx.update(gitOperations)
      .set({ commitSha })
      .where(and(eq(gitOperations.publicationId, id), eq(gitOperations.status, 'running')))
      .run();
    return publication;
  }, immediate);

/** `committing` → `committed`: the task branch points at the recorded commit. */
export const completePublicationCommit = (
  db: Database,
  { id, now }: { id: string; now: number },
): PublicationRecord =>
  db.transaction((tx) => {
    const current = tx.select().from(publications).where(eq(publications.id, id)).get();
    if (current?.commitSha == null) throw stateChanged(id);
    const publication = updateStatus(tx, id, 'committing', {
      status: 'committed',
      committedAt: now,
      updatedAt: now,
    });
    if (publication === undefined) throw stateChanged(id);
    finishRunningOperation(tx, id, {
      status: 'succeeded',
      commitSha: current.commitSha,
      finishedAt: now,
    });
    return publication;
  }, immediate);

/** `committed` → `pushing` with a new push attempt. */
export const startPublicationPush = (
  db: Database,
  { id, operationId, now }: { id: string; operationId: string; now: number },
): PublicationClaim =>
  db.transaction((tx) => {
    const publication = updateStatus(tx, id, 'committed', { status: 'pushing', updatedAt: now });
    if (publication === undefined) throw stateChanged(id);
    return {
      publication,
      operation: insertOperation(tx, publication, { id: operationId, kind: 'push', now }),
    };
  }, immediate);

/**
 * `pushing` → `pushed` and the task Review → Done (`mark_done`), in one transaction. This is the
 * only path to `Done`: it requires the recorded commit and a push confirmed by Git.
 */
export const completePublicationPush = (
  db: Database,
  { id, outcome, now }: { id: string; outcome: string; now: number },
): { publication: PublicationRecord; task: TaskRecord } =>
  db.transaction((tx) => {
    const publication = updateStatus(tx, id, 'pushing', {
      status: 'pushed',
      pushedAt: now,
      updatedAt: now,
    });
    if (publication === undefined) throw stateChanged(id);
    finishRunningOperation(tx, id, { status: 'succeeded', outcome, finishedAt: now });
    const task = transitionTask(tx, { id: publication.taskId, action: 'mark_done', now });
    return { publication, task };
  }, immediate);

/**
 * Marks an active publication `failed` at `stage` and fails its running operation. Nothing is
 * repaired or undone: a commit that exists stays recorded so only the push can be retried.
 */
export const failPublication = (
  db: Database,
  {
    id,
    stage,
    errorCode,
    errorMessage,
    now,
  }: {
    id: string;
    stage: PublicationFailureStage;
    errorCode: string;
    errorMessage: string;
    now: number;
  },
): PublicationRecord | undefined =>
  db.transaction((tx) => {
    const current = tx.select().from(publications).where(eq(publications.id, id)).get();
    if (current === undefined || !activeStatuses.includes(current.status)) return undefined;
    const message = truncateText(errorMessage, maxErrorMessageLength);
    const publication = updateStatus(tx, id, current.status, {
      status: 'failed',
      failureStage: stage,
      errorCode,
      errorMessage: message,
      updatedAt: now,
    });
    finishRunningOperation(tx, id, {
      status: 'failed',
      errorCode,
      errorMessage: message,
      finishedAt: now,
    });
    return publication;
  }, immediate);

/**
 * Operator `Retry push`: a publication that failed at the push stage, with its commit recorded and
 * the task still in `Review`, goes back to the worker as `push_requested`. The commit is reused.
 */
export const requestPublicationPushRetry = (
  db: Database,
  { taskId, publicationId, now }: { taskId: string; publicationId: string; now: number },
): PublicationRecord =>
  db.transaction((tx) => {
    const current = tx
      .select()
      .from(publications)
      .where(and(eq(publications.id, publicationId), eq(publications.taskId, taskId)))
      .get();
    if (current === undefined) {
      throw new PublicationError('publication_not_found', 'The publication does not exist.');
    }
    if (current.status === 'push_requested' || current.status === 'pushing') {
      return current;
    }
    if (
      current.status !== 'failed' ||
      current.failureStage !== 'push' ||
      current.commitSha === null
    ) {
      throw new PublicationError(
        'push_retry_not_allowed',
        'Only a publication whose commit exists and whose push failed can retry the push.',
        { status: current.status, failureStage: current.failureStage },
      );
    }
    const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (task?.status !== 'review') {
      throw new PublicationError('task_not_in_review', 'The task is no longer in Review.');
    }
    const publication = updateStatus(tx, publicationId, 'failed', {
      status: 'push_requested',
      failureStage: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: now,
    });
    if (publication === undefined) throw stateChanged(publicationId);
    return publication;
  }, immediate);
