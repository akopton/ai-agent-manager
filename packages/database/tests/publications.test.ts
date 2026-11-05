import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PublicationError,
  ReviewActionError,
  trustedLocalDisclosure,
  type PublicationErrorCode,
} from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  applyMigrations,
  claimPublication,
  claimStartCommand,
  completePublicationCommit,
  completePublicationPush,
  createDatabase,
  createPublication,
  createTask,
  failPublication,
  findTaskById,
  finishTaskRun,
  insertProject,
  listGitOperations,
  listQueuedPublications,
  recordGitIntegrity,
  recordPublicationCommitObject,
  recordRunWorkspace,
  requestPublicationPushRetry,
  requestTaskChanges,
  requestTaskExecution,
  setProjectExecutionTrust,
  startPublicationPush,
  transitionTask,
  type DatabaseConnection,
  type NewPublication,
} from '../src/index.js';

// Approve & Push persistence (M6-03): approvals are bound to the reviewed run and workspace,
// duplicates and concurrent approvals are refused or deduplicated, the publish state advances only
// by compare-and-swap, and the task reaches Done only together with a recorded push.

type Database = DatabaseConnection['db'];

const projectA = '00000000-0000-4000-8000-00000000000a';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const withDatabase = (run: (db: Database, sqlite: DatabaseConnection['sqlite']) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-publications-'));
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

const commitSha = 'c'.repeat(40);

const approval = (
  reviewed: { taskId: string; runId: string; workspaceId: string },
  n: number,
  overrides: Partial<NewPublication> = {},
): NewPublication => ({
  id: uuid(5000 + n),
  requestId: uuid(6000 + n),
  ...reviewed,
  inventoryRevision: 'revision-1',
  snapshotHash: 'd'.repeat(64),
  snapshotJson: '{}',
  fileCount: 1,
  baseCommit: 'a'.repeat(40),
  branch: `agent/${reviewed.taskId}`,
  remoteName: 'origin',
  remoteUrl: '/remotes/website.git',
  remoteUrlDigest: 'e'.repeat(64),
  commitMessage: 'Task 1',
  ...overrides,
});

const throwsPublicationError = (run: () => unknown, code: PublicationErrorCode): void => {
  assert.throws(
    run,
    (error: unknown) => error instanceof PublicationError && error.code === code,
    `expected ${code}`,
  );
};

/** Runs a publication through commit and push. */
const publish = (db: Database, id: string) => {
  assert.ok(claimPublication(db, { id, operationId: uuid(7001), workerInstanceId: 'w', now: 50 }));
  recordPublicationCommitObject(db, { id, commitSha, treeSha: 'f'.repeat(40), now: 51 });
  completePublicationCommit(db, { id, now: 52 });
  startPublicationPush(db, { id, operationId: uuid(7002), now: 53 });
  return completePublicationPush(db, { id, outcome: 'created', now: 54 });
};

test('an approval is bound to the reviewed run and workspace and is idempotent per request', () => {
  withDatabase((db) => {
    const reviewed = reviewedTask(db, 1);
    const input = approval(reviewed, 1);
    const first = createPublication(db, { input, now: 40 });
    assert.equal(first.created, true);
    assert.equal(first.publication.status, 'approved');
    assert.equal(findTaskById(db, reviewed.taskId)?.status, 'review', 'approval alone is not Done');

    // Double click / retried request: same request ID returns the same approval.
    const again = createPublication(db, { input: { ...input, id: uuid(5999) }, now: 41 });
    assert.equal(again.created, false);
    assert.equal(again.publication.id, first.publication.id);

    // A second, different approval while the first is active is refused.
    throwsPublicationError(
      () => createPublication(db, { input: approval(reviewed, 2), now: 42 }),
      'publication_in_progress',
    );
    // Request Changes is refused while the task is being published.
    assert.throws(
      () =>
        requestTaskChanges(db, {
          id: uuid(900),
          taskId: reviewed.taskId,
          input: { runId: reviewed.runId, revision: 'revision-1', feedback: 'Change more.' },
          now: 43,
        }),
      (error: unknown) =>
        error instanceof ReviewActionError && error.code === 'publication_in_progress',
    );
    assert.equal(listQueuedPublications(db).length, 1);
  });
});

test('approvals are refused for stale or ineligible reviews', () => {
  withDatabase((db) => {
    const reviewed = reviewedTask(db, 1);
    throwsPublicationError(
      () => createPublication(db, { input: approval(reviewed, 1, { runId: uuid(999) }), now: 40 }),
      'review_run_changed',
    );
    throwsPublicationError(
      () =>
        createPublication(db, {
          input: approval(reviewed, 2, { workspaceId: uuid(998) }),
          now: 40,
        }),
      'run_not_review_eligible',
    );
    requestTaskChanges(db, {
      id: uuid(900),
      taskId: reviewed.taskId,
      input: { runId: reviewed.runId, revision: 'revision-1', feedback: 'Change more.' },
      now: 41,
    });
    throwsPublicationError(
      () => createPublication(db, { input: approval(reviewed, 3), now: 42 }),
      'task_not_in_review',
    );
  });
  withDatabase((db) => {
    const reviewed = reviewedTask(db, 1);
    recordGitIntegrity(db, reviewed.runId, {
      status: 'violation',
      resultJson: null,
      checkedAt: 39,
    });
    throwsPublicationError(
      () => createPublication(db, { input: approval(reviewed, 1), now: 40 }),
      'run_not_review_eligible',
    );
  });
});

test('only one concurrent claim wins, and Done requires the recorded push', () => {
  withDatabase((db) => {
    const reviewed = reviewedTask(db, 1);
    const { publication } = createPublication(db, { input: approval(reviewed, 1), now: 40 });
    const claimed = claimPublication(db, {
      id: publication.id,
      operationId: uuid(7001),
      workerInstanceId: 'w1',
      now: 50,
    });
    assert.equal(claimed?.publication.status, 'committing');
    assert.equal(claimed?.operation.kind, 'commit');
    assert.equal(
      claimPublication(db, {
        id: publication.id,
        operationId: uuid(7009),
        workerInstanceId: 'w2',
        now: 50,
      }),
      null,
    );
    // Without a commit SHA, the publication cannot claim to be committed.
    assert.throws(() => completePublicationCommit(db, { id: publication.id, now: 51 }));
    recordPublicationCommitObject(db, {
      id: publication.id,
      commitSha,
      treeSha: 'f'.repeat(40),
      now: 51,
    });
    completePublicationCommit(db, { id: publication.id, now: 52 });
    assert.equal(findTaskById(db, reviewed.taskId)?.status, 'review', 'a commit alone is not Done');
    startPublicationPush(db, { id: publication.id, operationId: uuid(7002), now: 53 });
    const done = completePublicationPush(db, { id: publication.id, outcome: 'created', now: 54 });
    assert.equal(done.task.status, 'done');
    assert.equal(done.publication.status, 'pushed');
    const operations = listGitOperations(db, [publication.id]);
    assert.deepEqual(
      operations.map(({ kind, status, commitSha: sha }) => [kind, status, sha]),
      [
        ['commit', 'succeeded', commitSha],
        ['push', 'succeeded', commitSha],
      ],
    );
  });
});

test('a failed push keeps the commit; only the push is retried, never a new approval', () => {
  withDatabase((db) => {
    const reviewed = reviewedTask(db, 1);
    const { publication } = createPublication(db, { input: approval(reviewed, 1), now: 40 });
    claimPublication(db, {
      id: publication.id,
      operationId: uuid(7001),
      workerInstanceId: 'w',
      now: 50,
    });
    recordPublicationCommitObject(db, {
      id: publication.id,
      commitSha,
      treeSha: 'f'.repeat(40),
      now: 51,
    });
    completePublicationCommit(db, { id: publication.id, now: 52 });
    startPublicationPush(db, { id: publication.id, operationId: uuid(7002), now: 53 });
    const failed = failPublication(db, {
      id: publication.id,
      stage: 'push',
      errorCode: 'push_remote_unavailable',
      errorMessage: 'The remote could not be reached.',
      now: 54,
    });
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.commitSha, commitSha);
    assert.equal(findTaskById(db, reviewed.taskId)?.status, 'review', 'a failed push is not Done');

    throwsPublicationError(
      () => createPublication(db, { input: approval(reviewed, 2), now: 55 }),
      'publication_push_pending',
    );
    const retry = requestPublicationPushRetry(db, {
      taskId: reviewed.taskId,
      publicationId: publication.id,
      now: 56,
    });
    assert.equal(retry.status, 'push_requested');
    // Retrying again while queued is idempotent.
    assert.equal(
      requestPublicationPushRetry(db, {
        taskId: reviewed.taskId,
        publicationId: publication.id,
        now: 57,
      }).id,
      publication.id,
    );
    const claim = claimPublication(db, {
      id: publication.id,
      operationId: uuid(7003),
      workerInstanceId: 'w',
      now: 58,
    });
    assert.equal(claim?.operation.kind, 'push');
    assert.equal(claim?.operation.attempt, 2);
    completePublicationPush(db, { id: publication.id, outcome: 'up_to_date', now: 59 });
    const operations = listGitOperations(db, [publication.id]);
    assert.equal(operations.filter(({ kind }) => kind === 'commit').length, 1, 'one commit only');
    assert.deepEqual(
      operations.filter(({ kind }) => kind === 'push').map(({ status }) => status),
      ['failed', 'succeeded'],
    );
    assert.equal(findTaskById(db, reviewed.taskId)?.status, 'done');
  });
});

test('push retry is refused for validation or commit failures and for other tasks', () => {
  withDatabase((db) => {
    const reviewed = reviewedTask(db, 1);
    const { publication } = createPublication(db, { input: approval(reviewed, 1), now: 40 });
    claimPublication(db, {
      id: publication.id,
      operationId: uuid(7001),
      workerInstanceId: 'w',
      now: 50,
    });
    failPublication(db, {
      id: publication.id,
      stage: 'validation',
      errorCode: 'snapshot_changed',
      errorMessage: 'Changed.',
      now: 51,
    });
    throwsPublicationError(
      () =>
        requestPublicationPushRetry(db, {
          taskId: reviewed.taskId,
          publicationId: publication.id,
          now: 52,
        }),
      'push_retry_not_allowed',
    );
    const other = reviewedTask(db, 2);
    throwsPublicationError(
      () =>
        requestPublicationPushRetry(db, {
          taskId: other.taskId,
          publicationId: publication.id,
          now: 52,
        }),
      'publication_not_found',
    );
    // After a validation failure nothing was committed: a fresh approval is allowed.
    assert.equal(createPublication(db, { input: approval(reviewed, 2), now: 53 }).created, true);
  });
});

test('the database refuses a second active publication even without the service checks', () => {
  withDatabase((db, sqlite) => {
    const reviewed = reviewedTask(db, 1);
    publish(db, createPublication(db, { input: approval(reviewed, 1), now: 40 }).publication.id);
    const insert = sqlite.prepare(
      `INSERT INTO publications (id, request_id, task_id, run_id, workspace_id, status, inventory_revision, snapshot_hash, snapshot_json, file_count, base_commit, branch, remote_name, remote_url, remote_url_digest, commit_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'r', 'h', '{}', 1, 'b', 'x', 'origin', 'u', 'd', 'm', 1, 1)`,
    );
    insert.run(
      uuid(8001),
      uuid(8101),
      reviewed.taskId,
      reviewed.runId,
      reviewed.workspaceId,
      'approved',
    );
    assert.throws(
      () =>
        insert.run(
          uuid(8002),
          uuid(8102),
          reviewed.taskId,
          reviewed.runId,
          reviewed.workspaceId,
          'committing',
        ),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        insert.run(
          uuid(8003),
          uuid(8103),
          reviewed.taskId,
          reviewed.runId,
          reviewed.workspaceId,
          'pushed',
        ),
      /CHECK/,
      'pushed requires a commit SHA',
    );
  });
});
