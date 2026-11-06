import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  TaskError,
  trustedLocalDisclosure,
  WorkspaceCleanupError,
  type TaskErrorCode,
  type WorkspaceCleanupErrorCode,
} from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  applyMigrations,
  archiveTask,
  claimPublication,
  claimStartCommand,
  claimWorkspaceCleanup,
  completePublicationCommit,
  completePublicationPush,
  completeWorkspaceCleanup,
  countArchivedTasksByProject,
  countTasksByProjectAndStatus,
  createDatabase,
  createPublication,
  createTask,
  discardTask,
  expireRequestedWorkspaceCleanups,
  failWorkspaceCleanup,
  findTaskById,
  finishTaskRun,
  insertProject,
  listGitOperations,
  listQueuedWorkspaceCleanups,
  listTaskPublications,
  listTaskRuns,
  listTaskWorkspaceCleanups,
  listTaskWorkspaces,
  recordGitIntegrity,
  recordPublicationCommitObject,
  recordRunWorkspace,
  requestTaskExecution,
  requestTaskRecovery,
  requestWorkspaceCleanup,
  restoreTask,
  setProjectExecutionTrust,
  startPublicationPush,
  transitionTask,
  updateTask,
  type DatabaseConnection,
  type RunFinish,
} from '../src/index.js';

// TM-02 persistence: Archive/Restore change only `archived_at`; an archived task refuses lifecycle
// actions and edits until restored. Remove local worktree requests are recorded only for Done
// (pushed) or Discarded tasks, deduplicated, re-assessed at the worker's claim, and never delete
// a record.

type Database = DatabaseConnection['db'];

const projectA = '00000000-0000-4000-8000-00000000000a';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const baseSha = 'a'.repeat(40);
const commitSha = 'c'.repeat(40);

const withDatabase = (run: (db: Database, sqlite: DatabaseConnection['sqlite']) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-archive-'));
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

const newTask = (db: Database, n: number, agentRuntime: 'codex' | 'claude' = 'codex') => {
  const id = uuid(n);
  createTask(db, {
    id,
    input: { projectId: projectA, title: `Task ${n}`, prompt: 'Do it.', agentRuntime },
    now: 20,
  });
  return id;
};

type Ending = Pick<RunFinish, 'status' | 'taskAction'> & Partial<RunFinish>;

const completed: Ending = { status: 'completed', taskAction: 'complete_execution' };

/** Starts attempt 1 of a new task, records its workspace, and optionally ends it. */
const startedTask = (db: Database, n: number, ending: Ending | null = completed) => {
  // A run left active uses Claude, so it never blocks the per-runtime limit for later Codex runs.
  const taskId = newTask(db, n, ending === null ? 'claude' : 'codex');
  transitionTask(db, { id: taskId, action: 'queue', now: 21 });
  requestTaskExecution(db, { id: uuid(n * 10 + 1), taskId, now: 25 });
  const result = claimStartCommand(db, {
    commandId: uuid(n * 10 + 1),
    runId: uuid(n * 10 + 2),
    workerInstanceId: 'worker-1',
    timeoutMs: 60_000,
    now: 30,
  });
  assert.ok(result.claimed);
  const runId = result.claim.run.id;
  const workspace = recordRunWorkspace(db, {
    runId,
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
      baseSha,
      createdAt: 31,
    },
  });
  if (ending !== null) {
    recordGitIntegrity(db, runId, { status: 'clean', resultJson: null, checkedAt: 32 });
    finishTaskRun(db, runId, { ...ending, endedAt: 33 });
  }
  return { taskId, runId, workspaceId: workspace.id };
};

/** A task published through Approve & Push: Review → commit → push → Done. */
const doneTask = (db: Database, n: number) => {
  const reviewed = startedTask(db, n);
  const { publication } = createPublication(db, {
    input: {
      id: uuid(n * 10 + 4),
      requestId: uuid(n * 10 + 5),
      ...reviewed,
      inventoryRevision: 'revision-1',
      snapshotHash: 'd'.repeat(64),
      snapshotJson: '{}',
      fileCount: 1,
      baseCommit: baseSha,
      branch: `agent/${reviewed.taskId}`,
      remoteName: 'origin',
      remoteUrl: '/remotes/website.git',
      remoteUrlDigest: 'e'.repeat(64),
      commitMessage: 'Task',
    },
    now: 40,
  });
  const id = publication.id;
  assert.ok(
    claimPublication(db, { id, operationId: uuid(n * 10 + 6), workerInstanceId: 'w', now: 50 }),
  );
  recordPublicationCommitObject(db, { id, commitSha, treeSha: 'f'.repeat(40), now: 51 });
  completePublicationCommit(db, { id, now: 52 });
  startPublicationPush(db, { id, operationId: uuid(n * 10 + 7), now: 53 });
  completePublicationPush(db, { id, outcome: 'created', now: 54 });
  assert.equal(findTaskById(db, reviewed.taskId)?.status, 'done');
  return { ...reviewed, publicationId: id };
};

const throwsTask = (run: () => unknown, code: TaskErrorCode): void => {
  assert.throws(run, (error: unknown) => error instanceof TaskError && error.code === code, code);
};

const throwsCleanup = (run: () => unknown, code: WorkspaceCleanupErrorCode): void => {
  assert.throws(
    run,
    (error: unknown) => error instanceof WorkspaceCleanupError && error.code === code,
    code,
  );
};

const cleanupInput = (
  workspaceId: string,
  n: number,
  expectedCommit = commitSha,
): Parameters<typeof requestWorkspaceCleanup>[1]['input'] => ({
  requestId: uuid(9000 + n),
  workspaceId,
  expectedCommit,
  confirmed: true,
});

test('archive and restore change only archived_at and keep status and history', () => {
  withDatabase((db) => {
    const done = doneTask(db, 1);
    const before = findTaskById(db, done.taskId);
    assert.ok(before);
    const runs = listTaskRuns(db, done.taskId);
    const publications = listTaskPublications(db, done.taskId);
    const operations = listGitOperations(db, [done.publicationId]);
    const workspaces = listTaskWorkspaces(db, done.taskId);

    const archived = archiveTask(db, { taskId: done.taskId, now: 100 });
    assert.deepEqual(archived, { ...before, archivedAt: 100 });
    // A repeated click is harmless and keeps the first time.
    assert.equal(archiveTask(db, { taskId: done.taskId, now: 200 }).archivedAt, 100);
    assert.deepEqual(listTaskRuns(db, done.taskId), runs);
    assert.deepEqual(listTaskPublications(db, done.taskId), publications);
    assert.deepEqual(listGitOperations(db, [done.publicationId]), operations);
    assert.deepEqual(listTaskWorkspaces(db, done.taskId), workspaces);
    assert.deepEqual(listTaskWorkspaceCleanups(db, done.taskId), []);

    const restored = restoreTask(db, { taskId: done.taskId });
    assert.deepEqual(restored, before);
    assert.deepEqual(restoreTask(db, { taskId: done.taskId }), before);
  });
});

test('only inactive tasks can be archived', () => {
  withDatabase((db) => {
    const backlog = newTask(db, 1);
    assert.equal(archiveTask(db, { taskId: backlog, now: 100 }).archivedAt, 100);

    const queued = newTask(db, 2);
    transitionTask(db, { id: queued, action: 'queue', now: 21 });
    throwsTask(() => archiveTask(db, { taskId: queued, now: 100 }), 'task_not_archivable');

    const running = startedTask(db, 3, null);
    assert.equal(findTaskById(db, running.taskId)?.status, 'in_progress');
    throwsTask(() => archiveTask(db, { taskId: running.taskId, now: 100 }), 'task_not_archivable');

    const review = startedTask(db, 4);
    assert.equal(findTaskById(db, review.taskId)?.status, 'review');
    throwsTask(() => archiveTask(db, { taskId: review.taskId, now: 100 }), 'task_not_archivable');

    for (const [n, ending] of [
      [5, { status: 'failed', taskAction: 'fail' }],
      [6, { status: 'stopped', taskAction: 'stop' }],
      [7, { status: 'interrupted', taskAction: 'interrupt' }],
    ] as const) {
      const ended = startedTask(db, n, ending);
      assert.notEqual(archiveTask(db, { taskId: ended.taskId, now: 100 }).archivedAt, null);
    }

    const discarded = startedTask(db, 8);
    discardTask(db, {
      taskId: discarded.taskId,
      input: { runId: discarded.runId, confirmed: true },
      now: 50,
    });
    assert.equal(archiveTask(db, { taskId: discarded.taskId, now: 100 }).status, 'discarded');

    throwsTask(() => archiveTask(db, { taskId: 'not-a-task', now: 100 }), 'task_not_found');
  });
});

test('an archived task refuses lifecycle actions and edits until it is restored', () => {
  withDatabase((db) => {
    const backlog = newTask(db, 1);
    archiveTask(db, { taskId: backlog, now: 100 });
    throwsTask(
      () => transitionTask(db, { id: backlog, action: 'queue', now: 101 }),
      'task_archived',
    );
    throwsTask(
      () => updateTask(db, { id: backlog, input: { title: 'Renamed' }, now: 101 }),
      'task_archived',
    );
    assert.equal(findTaskById(db, backlog)?.status, 'backlog');
    restoreTask(db, { taskId: backlog });
    assert.equal(transitionTask(db, { id: backlog, action: 'queue', now: 102 }).status, 'queued');

    const failed = startedTask(db, 2, { status: 'failed', taskAction: 'fail' });
    archiveTask(db, { taskId: failed.taskId, now: 100 });
    assert.throws(
      () =>
        requestTaskRecovery(db, {
          id: uuid(500),
          taskId: failed.taskId,
          kind: 'retry',
          input: { runId: failed.runId },
          expectedWorkspaceId: failed.workspaceId,
          probeProcessGroup: () => false,
          now: 101,
        }),
      (error: unknown) => error instanceof TaskError && error.code === 'task_archived',
    );
    assert.throws(
      () =>
        discardTask(db, {
          taskId: failed.taskId,
          input: { runId: failed.runId, confirmed: true },
          now: 101,
        }),
      (error: unknown) => error instanceof TaskError && error.code === 'task_archived',
    );
    // Nothing was recorded or changed.
    assert.equal(findTaskById(db, failed.taskId)?.status, 'failed');
    assert.equal(listTaskRuns(db, failed.taskId).length, 1);
  });
});

test('board counts exclude archived tasks and count them separately', () => {
  withDatabase((db) => {
    newTask(db, 1);
    const archived = newTask(db, 2);
    archiveTask(db, { taskId: archived, now: 100 });
    assert.deepEqual(countTasksByProjectAndStatus(db), [
      { projectId: projectA, status: 'backlog', count: 1 },
    ]);
    assert.deepEqual(countArchivedTasksByProject(db), [{ projectId: projectA, count: 1 }]);
  });
});

test('a published task records one cleanup request, deduplicated by request ID', () => {
  withDatabase((db) => {
    const done = doneTask(db, 1);
    const first = requestWorkspaceCleanup(db, {
      id: uuid(800),
      taskId: done.taskId,
      input: cleanupInput(done.workspaceId, 1),
      now: 60,
    });
    assert.equal(first.created, true);
    assert.equal(first.cleanup.status, 'requested');
    assert.equal(first.cleanup.basis, 'published');
    assert.equal(first.cleanup.expectedCommit, commitSha);
    assert.equal(first.cleanup.taskStatus, 'done');

    const again = requestWorkspaceCleanup(db, {
      id: uuid(801),
      taskId: done.taskId,
      input: cleanupInput(done.workspaceId, 1),
      now: 61,
    });
    assert.equal(again.created, false);
    assert.equal(again.cleanup.id, first.cleanup.id);

    throwsCleanup(
      () =>
        requestWorkspaceCleanup(db, {
          id: uuid(802),
          taskId: done.taskId,
          input: cleanupInput(done.workspaceId, 2),
          now: 62,
        }),
      'cleanup_already_requested',
    );
    // A pending cleanup holds the task: it cannot be archived meanwhile.
    throwsTask(() => archiveTask(db, { taskId: done.taskId, now: 63 }), 'task_not_archivable');
    assert.equal(listQueuedWorkspaceCleanups(db).length, 1);
  });
});

test('cleanup requests are refused while the task may still need its worktree', () => {
  withDatabase((db) => {
    const review = startedTask(db, 1);
    throwsCleanup(
      () =>
        requestWorkspaceCleanup(db, {
          id: uuid(800),
          taskId: review.taskId,
          input: cleanupInput(review.workspaceId, 1, baseSha),
          now: 60,
        }),
      'cleanup_not_available',
    );
    for (const [n, ending] of [
      [2, { status: 'failed', taskAction: 'fail' }],
      [3, { status: 'stopped', taskAction: 'stop' }],
      [4, { status: 'interrupted', taskAction: 'interrupt' }],
    ] as const) {
      const ended = startedTask(db, n, ending);
      throwsCleanup(
        () =>
          requestWorkspaceCleanup(db, {
            id: uuid(800 + n),
            taskId: ended.taskId,
            input: cleanupInput(ended.workspaceId, n, baseSha),
            now: 60,
          }),
        'cleanup_not_available',
      );
    }
    const running = startedTask(db, 5, null);
    throwsCleanup(
      () =>
        requestWorkspaceCleanup(db, {
          id: uuid(805),
          taskId: running.taskId,
          input: cleanupInput(running.workspaceId, 5, baseSha),
          now: 60,
        }),
      'cleanup_not_available',
    );
    // The workspace of another task is never accepted.
    const done = doneTask(db, 6);
    throwsCleanup(
      () =>
        requestWorkspaceCleanup(db, {
          id: uuid(806),
          taskId: done.taskId,
          input: cleanupInput(review.workspaceId, 6),
          now: 60,
        }),
      'workspace_not_found',
    );
    // A stale page (another commit) is refused.
    throwsCleanup(
      () =>
        requestWorkspaceCleanup(db, {
          id: uuid(807),
          taskId: done.taskId,
          input: cleanupInput(done.workspaceId, 7, baseSha),
          now: 60,
        }),
      'cleanup_state_changed',
    );
    assert.equal(listQueuedWorkspaceCleanups(db).length, 0);
  });
});

test('a discarded task may remove a worktree only at its base commit', () => {
  withDatabase((db) => {
    const discarded = startedTask(db, 1);
    discardTask(db, {
      taskId: discarded.taskId,
      input: { runId: discarded.runId, confirmed: true },
      now: 50,
    });
    const { cleanup } = requestWorkspaceCleanup(db, {
      id: uuid(800),
      taskId: discarded.taskId,
      input: cleanupInput(discarded.workspaceId, 1, baseSha),
      now: 60,
    });
    assert.equal(cleanup.basis, 'discarded_unchanged');
    assert.equal(cleanup.expectedCommit, baseSha);
  });
});

test('the claim re-assesses the records and completion keeps every record', () => {
  withDatabase((db, sqlite) => {
    const done = doneTask(db, 1);
    const { cleanup } = requestWorkspaceCleanup(db, {
      id: uuid(800),
      taskId: done.taskId,
      input: cleanupInput(done.workspaceId, 1),
      now: 60,
    });
    const claim = claimWorkspaceCleanup(db, { id: cleanup.id, workerInstanceId: 'w', now: 61 });
    assert.ok(claim.claimed);
    assert.equal(claim.cleanup.status, 'removing');
    // A second claim (another worker or tick) does nothing.
    assert.equal(
      claimWorkspaceCleanup(db, { id: cleanup.id, workerInstanceId: 'w2', now: 62 }).claimed,
      false,
    );

    const removed = completeWorkspaceCleanup(db, {
      id: cleanup.id,
      branchCommit: commitSha,
      now: 63,
    });
    assert.equal(removed.status, 'removed');
    assert.equal(removed.removedAt, 63);
    assert.equal(findTaskById(db, done.taskId)?.status, 'done');
    assert.equal(listTaskWorkspaces(db, done.taskId).length, 1);
    assert.equal(listTaskPublications(db, done.taskId)[0]?.status, 'pushed');
    throwsCleanup(
      () =>
        requestWorkspaceCleanup(db, {
          id: uuid(801),
          taskId: done.taskId,
          input: cleanupInput(done.workspaceId, 2),
          now: 64,
        }),
      'cleanup_not_available',
    );
    // At most one completed removal per workspace, even for a direct insert.
    assert.throws(() =>
      sqlite
        .prepare(
          "INSERT INTO workspace_cleanups (id, request_id, task_id, workspace_id, status, basis, task_status, expected_commit, created_at, updated_at) VALUES (?, ?, ?, ?, 'requested', 'published', 'done', ?, 1, 1)",
        )
        .run(uuid(900), uuid(901), done.taskId, done.workspaceId, commitSha),
    );

    // A request whose records changed before the claim fails and removes nothing.
    const other = doneTask(db, 2);
    const pending = requestWorkspaceCleanup(db, {
      id: uuid(802),
      taskId: other.taskId,
      input: cleanupInput(other.workspaceId, 3),
      now: 65,
    }).cleanup;
    sqlite
      .prepare("UPDATE publications SET status = 'failed', failure_stage = 'push' WHERE id = ?")
      .run(other.publicationId);
    const refused = claimWorkspaceCleanup(db, { id: pending.id, workerInstanceId: 'w', now: 66 });
    assert.equal(refused.claimed, false);
    assert.equal(refused.cleanup?.status, 'failed');
  });
});

test('failed and expired requests allow a new request later', () => {
  withDatabase((db) => {
    const done = doneTask(db, 1);
    const first = requestWorkspaceCleanup(db, {
      id: uuid(800),
      taskId: done.taskId,
      input: cleanupInput(done.workspaceId, 1),
      now: 60,
    }).cleanup;
    assert.ok(claimWorkspaceCleanup(db, { id: first.id, workerInstanceId: 'w', now: 61 }).claimed);
    failWorkspaceCleanup(db, {
      id: first.id,
      from: 'removing',
      code: 'worktree_dirty',
      message: 'Dirty.',
      now: 62,
    });

    const second = requestWorkspaceCleanup(db, {
      id: uuid(801),
      taskId: done.taskId,
      input: cleanupInput(done.workspaceId, 2),
      now: 1_000,
    }).cleanup;
    assert.equal(expireRequestedWorkspaceCleanups(db, { olderThan: 500, now: 1_001 }), 0);
    assert.equal(expireRequestedWorkspaceCleanups(db, { olderThan: 2_000, now: 2_001 }), 1);
    assert.deepEqual(
      listTaskWorkspaceCleanups(db, done.taskId).map((row) => [row.id, row.status, row.errorCode]),
      [
        [second.id, 'failed', 'request_expired'],
        [first.id, 'failed', 'worktree_dirty'],
      ],
    );
  });
});
