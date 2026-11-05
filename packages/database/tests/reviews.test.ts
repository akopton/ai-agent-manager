import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ReviewActionError,
  reviewFeedbackMaxLength,
  trustedLocalDisclosure,
  type ReviewActionErrorCode,
} from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  applyMigrations,
  claimStartCommand,
  createDatabase,
  createTask,
  findLatestTaskCommand,
  findPendingChangeRequest,
  findTaskById,
  findTaskRun,
  finishTaskRun,
  insertProject,
  listTaskReviews,
  listTaskRuns,
  listTaskWorkspaces,
  recordGitIntegrity,
  recordRunWorkspace,
  requestTaskChanges,
  requestTaskExecution,
  setProjectExecutionTrust,
  taskRuns,
  transitionTask,
  type DatabaseConnection,
} from '../src/index.js';

// Request Changes persistence (M6-02): feedback is stored per reviewed run, the task moves
// Review → Queued without any start request, and the next claim continues in the same workspace.

type Database = DatabaseConnection['db'];

const projectA = '00000000-0000-4000-8000-00000000000a';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const withDatabase = (run: (db: Database, sqlite: DatabaseConnection['sqlite']) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-reviews-'));
  const connection = createDatabase({ path: join(directory, 'database.sqlite') });
  try {
    applyMigrations(connection);
    insertProject(connection.db, {
      id: projectA,
      name: 'website',
      localPath: '/repos/website',
      gitCommonDir: '/repos/website/.git',
      remoteName: null,
      defaultBaseBranch: 'main',
      createdAt: 1,
      updatedAt: 1,
    });
    acceptTrustedLocal(connection.db, {
      input: {
        disclosureVersion: trustedLocalDisclosure.version,
        acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
      },
      now: 10,
    });
    setProjectExecutionTrust(connection.db, {
      projectId: projectA,
      trust: {
        trust: 'trusted_local',
        localPath: '/repos/website',
        gitCommonDir: '/repos/website/.git',
      },
      now: 11,
    });
    run(connection.db, connection.sqlite);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

const queuedTask = (db: Database, n: number, agentRuntime: 'codex' | 'claude' = 'codex') => {
  const id = uuid(n);
  createTask(db, {
    id,
    input: { projectId: projectA, title: `Task ${n}`, prompt: 'Do it.', agentRuntime },
    now: 20,
  });
  transitionTask(db, { id, action: 'queue', now: 21 });
  return id;
};

const claim = (db: Database, commandId: string, runId: string, now = 30) =>
  claimStartCommand(db, { commandId, runId, workerInstanceId: 'worker-1', timeoutMs: 60_000, now });

/** Runs attempt 1 of a queued task to `Review` with a recorded workspace and a clean check. */
const reviewedTask = (db: Database, n: number) => {
  const taskId = queuedTask(db, n);
  requestTaskExecution(db, { id: uuid(n * 10 + 1), taskId, now: 25 });
  const result = claim(db, uuid(n * 10 + 1), uuid(n * 10 + 2));
  assert.ok(result.claimed);
  const workspace = recordRunWorkspace(db, {
    runId: result.claim.run.id,
    workspace: {
      id: uuid(n * 10 + 3),
      taskId,
      generation: 1,
      repositoryRoot: '/repos/website',
      gitCommonDir: '/repos/website/.git',
      worktreeRoot: '/data/worktrees',
      path: `/data/worktrees/website-0123/${taskId}`,
      branch: `agent/${taskId}`,
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      createdAt: 31,
    },
  });
  recordGitIntegrity(db, result.claim.run.id, { status: 'clean', resultJson: null, checkedAt: 32 });
  finishTaskRun(db, result.claim.run.id, {
    status: 'completed',
    taskAction: 'complete_execution',
    summary: 'Created hello.txt.',
    endedAt: 33,
  });
  return { taskId, runId: result.claim.run.id, workspaceId: workspace.id };
};

const feedback = 'Rename hello.txt to greeting.txt.';

const throwsReviewError = (run: () => unknown, code: ReviewActionErrorCode): void => {
  assert.throws(
    run,
    (error: unknown) => error instanceof ReviewActionError && error.code === code,
    `expected ${code}`,
  );
};

test('Request Changes stores the feedback with the reviewed run and workspace and queues the task', () => {
  withDatabase((db) => {
    const { taskId, runId, workspaceId } = reviewedTask(db, 1);
    const command = findLatestTaskCommand(db, taskId);
    const { review, task } = requestTaskChanges(db, {
      id: uuid(900),
      taskId,
      input: { runId, revision: 'rev-1', feedback: `  ${feedback}\n` },
      now: 40,
    });
    assert.equal(task.status, 'queued');
    assert.equal(task.queuedAt, 40);
    assert.equal(review.status, 'changes_requested');
    assert.equal(review.feedback, feedback, 'feedback is trimmed');
    assert.equal(review.runId, runId);
    assert.equal(review.workspaceId, workspaceId);
    assert.equal(review.inventoryRevision, 'rev-1');
    assert.equal(review.followUpRunId, null);
    assert.deepEqual(listTaskReviews(db, taskId), [review]);
    assert.deepEqual(findPendingChangeRequest(db, taskId), review);
    // No start request was created: nothing runs until the operator starts it.
    assert.deepEqual(findLatestTaskCommand(db, taskId), command);
    // The reviewed run keeps its evidence.
    const run = findTaskRun(db, runId);
    assert.equal(run?.status, 'completed');
    assert.equal(run?.summary, 'Created hello.txt.');
    assert.equal(run?.gitIntegrityStatus, 'clean');
  });
});

test('feedback is validated: empty, whitespace-only, too short and too long are rejected', () => {
  withDatabase((db) => {
    const { taskId, runId } = reviewedTask(db, 1);
    for (const text of ['', '   \n\t', 'ok', 'x'.repeat(reviewFeedbackMaxLength + 1)]) {
      throwsReviewError(
        () =>
          requestTaskChanges(db, {
            id: uuid(900),
            taskId,
            input: { runId, revision: 'rev-1', feedback: text },
            now: 40,
          }),
        'invalid_review_input',
      );
    }
    throwsReviewError(
      () =>
        requestTaskChanges(db, {
          id: uuid(900),
          taskId,
          input: { runId: 'not-a-uuid', revision: 'rev-1', feedback },
          now: 40,
        }),
      'invalid_review_input',
    );
    assert.equal(findTaskById(db, taskId)?.status, 'review');
    assert.deepEqual(listTaskReviews(db, taskId), []);
  });
});

test('duplicate and conflicting submissions are rejected without a second record', () => {
  withDatabase((db) => {
    const { taskId, runId } = reviewedTask(db, 1);
    const submit = (id: number, runIdOverride = runId) =>
      requestTaskChanges(db, {
        id: uuid(id),
        taskId,
        input: { runId: runIdOverride, revision: 'rev-1', feedback },
        now: 40,
      });
    throwsReviewError(() => submit(899, uuid(12345)), 'review_run_changed');
    submit(900);
    throwsReviewError(() => submit(901), 'changes_already_requested');
    assert.equal(listTaskReviews(db, taskId).length, 1);
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
  });
});

test('only a task in Review whose latest run is review-eligible accepts Request Changes', () => {
  withDatabase((db) => {
    // Queued, never ran.
    const fresh = queuedTask(db, 1);
    throwsReviewError(
      () =>
        requestTaskChanges(db, {
          id: uuid(900),
          taskId: fresh,
          input: { runId: uuid(5), revision: 'rev', feedback },
          now: 40,
        }),
      'task_not_in_review',
    );

    // A completed run whose integrity check found a violation leaves the task Failed.
    const taskId = queuedTask(db, 2);
    requestTaskExecution(db, { id: uuid(21), taskId, now: 25 });
    const result = claim(db, uuid(21), uuid(22));
    assert.ok(result.claimed);
    recordGitIntegrity(db, uuid(22), { status: 'violation', resultJson: null, checkedAt: 32 });
    finishTaskRun(db, uuid(22), { status: 'completed', taskAction: 'fail', endedAt: 33 });
    throwsReviewError(
      () =>
        requestTaskChanges(db, {
          id: uuid(901),
          taskId,
          input: { runId: uuid(22), revision: 'rev', feedback },
          now: 40,
        }),
      'task_not_in_review',
    );
    assert.deepEqual(listTaskReviews(db, taskId), []);
  });
});

test('the next claim creates attempt 2 in the same workspace and binds the change request', () => {
  withDatabase((db) => {
    const { taskId, runId, workspaceId } = reviewedTask(db, 1);
    const { review } = requestTaskChanges(db, {
      id: uuid(900),
      taskId,
      input: { runId, revision: 'rev-1', feedback },
      now: 40,
    });
    requestTaskExecution(db, { id: uuid(950), taskId, now: 41 });
    const result = claim(db, uuid(950), uuid(951), 42);
    assert.ok(result.claimed);
    assert.equal(result.claim.run.attempt, 2);
    assert.equal(result.claim.run.workspaceId, workspaceId);
    assert.equal(result.claim.continuation?.reviewedAttempt, 1);
    assert.equal(result.claim.continuation?.review.id, review.id);
    assert.equal(result.claim.continuation?.review.followUpRunId, uuid(951));
    assert.equal(result.claim.continuation?.workspace.id, workspaceId);
    assert.equal(findTaskById(db, taskId)?.status, 'in_progress');
    assert.equal(findPendingChangeRequest(db, taskId), undefined);
    // History is preserved: two runs, one workspace, the first run unchanged.
    assert.deepEqual(
      listTaskRuns(db, taskId).map((run) => [run.attempt, run.status, run.workspaceId]),
      [
        [2, 'starting', workspaceId],
        [1, 'completed', workspaceId],
      ],
    );
    assert.equal(listTaskWorkspaces(db, taskId).length, 1);

    // Attempt 2 completes; a second round of feedback creates a second decision and attempt 3.
    recordGitIntegrity(db, uuid(951), { status: 'clean', resultJson: null, checkedAt: 43 });
    finishTaskRun(db, uuid(951), {
      status: 'completed',
      taskAction: 'complete_execution',
      endedAt: 44,
    });
    throwsReviewError(
      () =>
        requestTaskChanges(db, {
          id: uuid(901),
          taskId,
          input: { runId, revision: 'rev-1', feedback },
          now: 45,
        }),
      'changes_already_requested',
    );
    requestTaskChanges(db, {
      id: uuid(902),
      taskId,
      input: { runId: uuid(951), revision: 'rev-2', feedback: 'Also add a test.' },
      now: 46,
    });
    requestTaskExecution(db, { id: uuid(960), taskId, now: 47 });
    const third = claim(db, uuid(960), uuid(961), 48);
    assert.ok(third.claimed);
    assert.equal(third.claim.run.attempt, 3);
    assert.equal(third.claim.continuation?.reviewedAttempt, 2);
    assert.equal(third.claim.continuation?.review.feedback, 'Also add a test.');
    assert.deepEqual(
      listTaskReviews(db, taskId).map((entry) => [entry.runId, entry.followUpRunId]),
      [
        [uuid(951), uuid(961)],
        [runId, uuid(951)],
      ],
    );
  });
});

test('a refused follow-up claim keeps the change request pending for a later start', () => {
  withDatabase((db) => {
    const { taskId, runId } = reviewedTask(db, 1);
    requestTaskChanges(db, {
      id: uuid(900),
      taskId,
      input: { runId, revision: 'rev-1', feedback },
      now: 40,
    });
    // Another Codex run holds the runtime slot.
    const other = queuedTask(db, 5);
    requestTaskExecution(db, { id: uuid(51), taskId: other, now: 41 });
    assert.ok(claim(db, uuid(51), uuid(52), 42).claimed);
    requestTaskExecution(db, { id: uuid(950), taskId, now: 43 });
    const busy = claim(db, uuid(950), uuid(951), 44);
    assert.equal(busy.claimed, false);
    assert.equal(busy.claimed ? null : busy.code, 'runtime_busy');
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
    assert.notEqual(findPendingChangeRequest(db, taskId), undefined);
    assert.equal(listTaskRuns(db, taskId).length, 1);
  });
});

test('a task with a retained workspace but no change request is not started again', () => {
  withDatabase((db, sqlite) => {
    const { taskId, runId } = reviewedTask(db, 1);
    requestTaskChanges(db, {
      id: uuid(900),
      taskId,
      input: { runId, revision: 'rev-1', feedback },
      now: 40,
    });
    requestTaskExecution(db, { id: uuid(950), taskId, now: 41 });
    assert.ok(claim(db, uuid(950), uuid(951), 42).claimed);
    finishTaskRun(db, uuid(951), { status: 'failed', taskAction: 'fail', endedAt: 43 });
    // Simulates a future re-queue path (Retry/Resume are not implemented) without a change
    // request: a fresh worktree would collide with the retained one, so the claim refuses.
    sqlite.prepare("UPDATE tasks SET status = 'queued', queued_at = 44 WHERE id = ?").run(taskId);
    requestTaskExecution(db, { id: uuid(960), taskId, now: 45 });
    const result = claim(db, uuid(960), uuid(961), 46);
    assert.equal(result.claimed ? null : result.code, 'continuation_unavailable');
    assert.equal(findLatestTaskCommand(db, taskId)?.resultCode, 'continuation_unavailable');
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
    assert.equal(listTaskRuns(db, taskId).length, 2);
  });
});

test('claims refuse a pending change request that no longer matches the latest run', () => {
  withDatabase((db) => {
    const { taskId, runId } = reviewedTask(db, 1);
    requestTaskChanges(db, {
      id: uuid(900),
      taskId,
      input: { runId, revision: 'rev-1', feedback },
      now: 40,
    });
    // A newer attempt appears without consuming the change request (inconsistent state).
    db.insert(taskRuns)
      .values({
        id: uuid(940),
        taskId,
        attempt: 2,
        agentRuntime: 'codex',
        status: 'failed',
        securityMode: 'trusted_local',
        timeoutMs: 60_000,
        workerInstanceId: 'worker-0',
        createdAt: 40,
        updatedAt: 40,
      })
      .run();
    requestTaskExecution(db, { id: uuid(950), taskId, now: 41 });
    const result = claim(db, uuid(950), uuid(951), 42);
    assert.equal(result.claimed ? null : result.code, 'continuation_unavailable');
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
    assert.notEqual(findPendingChangeRequest(db, taskId), undefined);
    assert.equal(listTaskRuns(db, taskId).length, 2);
  });
});
