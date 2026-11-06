import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  buildPublicationCommitMessage,
  TaskError,
  TaskRecoveryError,
  type TaskRecoveryKind,
} from '@ai-agent-manager/core';
import {
  archiveTask,
  createPublication,
  discardTask,
  findLatestTaskCommand,
  findPublication,
  findTaskById,
  findWorkspaceCleanup,
  listGitOperations,
  listTaskPublications,
  listTaskRecoveries,
  listTaskReviews,
  listTaskRuns,
  listTaskWorkspaces,
  requestPublicationPushRetry,
  requestRunStop,
  requestTaskChanges,
  requestTaskExecution,
  requestTaskRecovery,
  requestWorkspaceCleanup,
  restoreTask,
  transitionTask,
  updateTask,
  type PublicationRecord,
} from '@ai-agent-manager/database';
import {
  captureReviewSnapshot,
  isProcessGroupAlive,
  readPublishRemote,
} from '@ai-agent-manager/git';
import {
  git,
  snapshotTree,
  waitFor,
  withExecutionFixture,
  type ExecutionFixture,
  type FakeStep,
} from './execution-fixtures.js';

// TM-03 — Manual Task Management v1 journeys, end to end through the worker: disposable source
// repository, local bare remote, temporary SQLite database and fake CLIs. Operator decisions are
// recorded with the same database commands the web routes call (the routes add their own read-only
// Git checks, covered in apps/web). Each journey checks that nothing runs without an explicit
// Start, that every attempt and decision stays in history, and that the operator's main checkout
// and branches are never touched. No real agent, no network.

let home = '';
const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

before(() => {
  home = mkdtempSync(join(tmpdir(), 'ai-agent-manager worker journeys home '));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
});

after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const terminal = ['review', 'failed', 'stopped', 'interrupted'] as const;

const completing = (file: string): FakeStep[] => [
  { stdout: { type: 'thread.started', thread_id: `thread-${file}` } },
  { writeFile: file, content: `${file}\n` },
  { stdout: { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'Done.' } } },
  { stdout: { type: 'turn.completed', usage: {} } },
];

const failing = (file: string): FakeStep[] => [
  { stdout: { type: 'thread.started', thread_id: `thread-${file}` } },
  { writeFile: file, content: `${file}\n` },
  { stderr: 'boom' },
  { exit: 3 },
];

const hanging = (file: string): FakeStep[] => [
  { writeFile: file, content: `${file}\n` },
  { hang: true },
];

const refs = (repository: string): string[] =>
  git(repository, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean);

const checkoutFiles = (directory: string) =>
  [...snapshotTree(directory)].filter(([path]) => !path.startsWith('.git/'));

const worktreeFiles = (path: string) =>
  [...snapshotTree(path).keys()].filter((name) => name !== '.git').sort();

/** Adds a local bare `origin` with `main` and configures the publishing identity. */
const addRemote = (fixture: ExecutionFixture): string => {
  const { root } = fixture.repository;
  git(root, 'config', 'user.name', 'Publisher');
  git(root, 'config', 'user.email', 'publisher@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  const remote = join(fixture.directory, 'remote.git');
  git(fixture.directory, 'init', '--quiet', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '--quiet', 'origin', 'main');
  fixture.connection.sqlite
    .prepare('UPDATE projects SET remote_name = ? WHERE id = ?')
    .run('origin', fixture.projectId);
  return remote;
};

/** One worker lifetime: explicit Start, then wait until the attempt ends. */
const startAndWait = async (fixture: ExecutionFixture, taskId: string, steps: FakeStep[]) => {
  fixture.clis.codex.setSteps(steps);
  fixture.requestStart(taskId);
  const service = fixture.service();
  await service.start();
  try {
    await service.tick();
    return await fixture.waitForTaskStatus(taskId, [...terminal]);
  } finally {
    await service.stop();
  }
};

/** Explicit Start of a hanging attempt, then Stop once its file exists. */
const startAndStop = async (fixture: ExecutionFixture, taskId: string, file: string) => {
  fixture.clis.codex.setSteps(hanging(file));
  fixture.requestStart(taskId);
  const service = fixture.service();
  await service.start();
  try {
    await service.tick();
    await waitFor(() => listTaskRuns(fixture.db, taskId)[0]?.status === 'running');
    await waitFor(() =>
      existsSync(join(listTaskWorkspaces(fixture.db, taskId)[0]?.path ?? '', file)),
    );
    requestRunStop(fixture.db, { taskId, now: Date.now() });
    // A repeated Stop is idempotent: the intent is recorded once.
    const first = listTaskRuns(fixture.db, taskId)[0]?.stopRequestedAt;
    requestRunStop(fixture.db, { taskId, now: Date.now() + 1 });
    assert.equal(listTaskRuns(fixture.db, taskId)[0]?.stopRequestedAt, first);
    await service.tick();
    return await fixture.waitForTaskStatus(taskId, [...terminal]);
  } finally {
    await service.stop();
  }
};

/** A running worker that receives no command never starts anything on its own. */
const assertNothingStarts = async (fixture: ExecutionFixture, taskId: string) => {
  const runs = listTaskRuns(fixture.db, taskId).length;
  const invocations = fixture.clis.codex.invocations().length;
  const idle = fixture.service();
  await idle.start();
  try {
    for (let index = 0; index < 5; index += 1) await idle.tick();
  } finally {
    await idle.stop();
  }
  assert.equal(listTaskRuns(fixture.db, taskId).length, runs, 'no new attempt');
  assert.equal(fixture.clis.codex.invocations().length, invocations, 'no CLI launch');
};

/** Retry/Resume as the web route records it after its own read-only worktree check. */
const recover = (fixture: ExecutionFixture, taskId: string, kind: TaskRecoveryKind) => {
  const [latest] = listTaskRuns(fixture.db, taskId);
  assert.ok(latest);
  return requestTaskRecovery(fixture.db, {
    id: randomUUID(),
    taskId,
    kind,
    input: { runId: latest.id },
    expectedWorkspaceId: listTaskWorkspaces(fixture.db, taskId)[0]?.id ?? null,
    probeProcessGroup: isProcessGroupAlive,
    now: Date.now(),
  });
};

/** Approve & Push as the web route records it: fresh snapshot, server-side destination. */
const approve = async (
  fixture: ExecutionFixture,
  taskId: string,
  requestId = randomUUID(),
): Promise<{ publication: PublicationRecord; created: boolean }> => {
  const [run] = listTaskRuns(fixture.db, taskId);
  const [workspace] = listTaskWorkspaces(fixture.db, taskId);
  const task = findTaskById(fixture.db, taskId);
  assert.ok(run && workspace && task);
  const capture = await captureReviewSnapshot({
    repositoryPath: fixture.repository.root,
    worktreePath: workspace.path,
    branchName: workspace.branch,
    baseCommit: workspace.baseSha,
  });
  assert.ok(capture.status === 'ready');
  const remote = await readPublishRemote(fixture.repository.root, 'origin');
  assert.ok(remote);
  return createPublication(fixture.db, {
    input: {
      id: randomUUID(),
      requestId,
      taskId,
      runId: run.id,
      workspaceId: workspace.id,
      inventoryRevision: capture.revision,
      snapshotHash: capture.snapshotHash,
      snapshotJson: JSON.stringify(capture.snapshot),
      fileCount: capture.snapshot.files.length,
      baseCommit: workspace.baseSha,
      branch: workspace.branch,
      remoteName: remote.name,
      remoteUrl: remote.displayUrl,
      remoteUrlDigest: remote.urlDigest,
      commitMessage: buildPublicationCommitMessage({
        taskId,
        title: task.title,
        attempt: run.attempt,
        runId: run.id,
      }),
    },
    now: Date.now(),
  });
};

/** One worker lifetime that settles queued publications and cleanups. */
const settle = async (fixture: ExecutionFixture) => {
  const service = fixture.service();
  await service.start();
  try {
    await service.tick();
    await service.publicationsIdle();
    await service.cleanupsIdle();
  } finally {
    await service.stop();
  }
};

const commandCounts = (fixture: ExecutionFixture, taskId: string) =>
  fixture.connection.sqlite
    .prepare(
      'SELECT status, COUNT(*) AS count FROM worker_commands WHERE task_id = ? GROUP BY status ORDER BY status',
    )
    .all(taskId);

const throwsCode = (run: () => unknown, code: string): void => {
  assert.throws(
    run,
    (error: unknown) =>
      (error instanceof TaskError ||
        error instanceof TaskRecoveryError ||
        error instanceof Error) &&
      'code' in error &&
      error.code === code,
    `expected ${code}`,
  );
};

test('journey: review iteration, failure, stop and resume each wait for Start; publish with a push retry; archive, cleanup and restore', async () => {
  await withExecutionFixture(async (fixture) => {
    const { db, repository } = fixture;
    const remote = addRemote(fixture);
    const mainBefore = git(repository.root, 'rev-parse', 'main').trim();
    const checkoutBefore = checkoutFiles(repository.root);
    const remoteMainBefore = git(remote, 'rev-parse', 'main').trim();
    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex', 'Original prompt marker.');

    // Queued alone runs nothing; a second Start while one is pending is refused.
    await assertNothingStarts(fixture, taskId);
    fixture.requestStart(taskId);
    throwsCode(() => fixture.requestStart(taskId), 'execution_already_requested');
    fixture.connection.sqlite
      .prepare("UPDATE worker_commands SET status = 'rejected' WHERE task_id = ?")
      .run(taskId);

    // Attempt 1 → Review.
    assert.equal(await startAndWait(fixture, taskId, completing('a1.txt')), 'review');
    const [attempt1] = listTaskRuns(db, taskId);
    assert.ok(attempt1);

    // Request Changes → Queued; nothing runs until Start. Attempt 2 fails.
    requestTaskChanges(db, {
      id: randomUUID(),
      taskId,
      input: { runId: attempt1.id, revision: 'inventory-revision', feedback: 'Also add a2.' },
      now: Date.now(),
    });
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
    await assertNothingStarts(fixture, taskId);
    assert.equal(await startAndWait(fixture, taskId, failing('a2.txt')), 'failed');

    // Retry → Queued; a second Retry is refused; nothing runs until Start. Attempt 3 is stopped.
    assert.equal(recover(fixture, taskId, 'retry').task.status, 'queued');
    throwsCode(() => recover(fixture, taskId, 'retry'), 'recovery_not_available');
    await assertNothingStarts(fixture, taskId);
    assert.equal(await startAndStop(fixture, taskId, 'a3.txt'), 'stopped');

    // Resume → Queued; nothing runs until Start. Attempt 4 reaches Review.
    assert.equal(recover(fixture, taskId, 'resume').task.status, 'queued');
    await assertNothingStarts(fixture, taskId);
    assert.equal(await startAndWait(fixture, taskId, completing('a4.txt')), 'review');

    // All four attempts continued in one worktree, which kept every attempt's files.
    const [workspace] = listTaskWorkspaces(db, taskId);
    assert.ok(workspace);
    assert.equal(listTaskWorkspaces(db, taskId).length, 1);
    assert.deepEqual(worktreeFiles(workspace.path), [
      'README.md',
      'a1.txt',
      'a2.txt',
      'a3.txt',
      'a4.txt',
    ]);

    // A stale change request for attempt 1 is refused now that attempt 4 is under review.
    throwsCode(
      () =>
        requestTaskChanges(db, {
          id: randomUUID(),
          taskId,
          input: { runId: attempt1.id, revision: 'inventory-revision', feedback: 'Stale.' },
          now: Date.now(),
        }),
      'changes_already_requested',
    );

    // Approve & Push: a repeated submission returns the same approval. The push fails first.
    const requestId = randomUUID();
    const { publication } = await approve(fixture, taskId, requestId);
    const repeated = await approve(fixture, taskId, requestId);
    assert.equal(repeated.created, false);
    assert.equal(repeated.publication.id, publication.id);
    const parked = `${remote}-offline`;
    renameSync(remote, parked);
    await settle(fixture);
    const failedPush = findPublication(db, publication.id);
    assert.equal(failedPush?.status, 'failed');
    assert.equal(failedPush?.failureStage, 'push');
    assert.ok(failedPush?.commitSha);
    assert.equal(findTaskById(db, taskId)?.status, 'review', 'a failed push is not Done');
    // While the push is pending, the task can be neither re-reviewed, discarded nor archived.
    throwsCode(
      () =>
        discardTask(db, { taskId, input: { runId: publication.runId, confirmed: true }, now: 1 }),
      'publication_in_progress',
    );
    throwsCode(() => archiveTask(db, { taskId, now: Date.now() }), 'task_not_archivable');

    renameSync(parked, remote);
    requestPublicationPushRetry(db, { taskId, publicationId: publication.id, now: Date.now() });
    await settle(fixture);
    const pushed = findPublication(db, publication.id);
    assert.equal(pushed?.status, 'pushed', pushed?.errorMessage ?? '');
    assert.equal(pushed?.commitSha, failedPush.commitSha, 'the same commit was pushed');
    assert.equal(findTaskById(db, taskId)?.status, 'done');
    const commit = failedPush.commitSha;
    assert.equal(git(remote, 'rev-parse', `refs/heads/${workspace.branch}`).trim(), commit);
    assert.equal(
      git(repository.root, 'rev-list', '--count', `${workspace.baseSha}..${commit}`).trim(),
      '1',
    );
    assert.deepEqual(
      listGitOperations(db, [publication.id]).map(({ kind, status }) => `${kind}:${status}`),
      ['commit:succeeded', 'push:failed', 'push:succeeded'],
    );

    // History: attempts, decisions and their links are consistent.
    const runs = listTaskRuns(db, taskId);
    assert.deepEqual(
      runs.map((run) => [run.attempt, run.status, run.workspaceId]),
      [
        [4, 'completed', workspace.id],
        [3, 'stopped', workspace.id],
        [2, 'failed', workspace.id],
        [1, 'completed', workspace.id],
      ],
    );
    const byAttempt = new Map(runs.map((run) => [run.attempt, run.id]));
    assert.deepEqual(
      listTaskReviews(db, taskId).map((review) => [review.runId, review.followUpRunId]),
      [[byAttempt.get(1), byAttempt.get(2)]],
    );
    assert.deepEqual(
      listTaskRecoveries(db, taskId).map((recovery) => [
        recovery.kind,
        recovery.sourceRunId,
        recovery.followUpRunId,
      ]),
      [
        ['resume', byAttempt.get(3), byAttempt.get(4)],
        ['retry', byAttempt.get(2), byAttempt.get(3)],
      ],
    );
    assert.equal(listTaskPublications(db, taskId).length, 1);
    assert.deepEqual(commandCounts(fixture, taskId), [
      { status: 'accepted', count: 4 },
      { status: 'rejected', count: 1 },
    ]);
    assert.equal(fixture.clis.codex.invocations().length, 4, 'one CLI launch per Start');
    // No attempt after the change request reached review, so its feedback is still unaddressed:
    // it reaches attempt 2 and is sent again with the retried (3) and resumed (4) attempts.
    const [review] = listTaskReviews(db, taskId);
    assert.deepEqual(
      listTaskRecoveries(db, taskId).map((recovery) => recovery.reviewId),
      [review?.id, review?.id],
    );
    const stdins = fixture.clis.codex.invocations().map((invocation) => invocation.stdin);
    assert.deepEqual(
      stdins.map((stdin) => stdin.includes('Also add a2.')),
      [false, true, true, true],
    );

    // Archive: visibility only. The archived task refuses edits and lifecycle actions.
    const doneTask = findTaskById(db, taskId);
    assert.ok(doneTask);
    const archived = archiveTask(db, { taskId, now: Date.now() });
    assert.equal(archived.status, 'done');
    assert.equal(archived.updatedAt, doneTask.updatedAt);
    assert.deepEqual(archiveTask(db, { taskId, now: Date.now() + 5 }), archived, 'idempotent');
    throwsCode(
      () => updateTask(db, { id: taskId, input: { title: 'X' }, now: 1 }),
      'task_archived',
    );
    throwsCode(() => transitionTask(db, { id: taskId, action: 'queue', now: 1 }), 'task_archived');

    // Remove local worktree stays available while archived; branches and checkout are kept.
    const remoteRefsBefore = refs(remote);
    const { cleanup } = requestWorkspaceCleanup(db, {
      id: randomUUID(),
      taskId,
      input: {
        requestId: randomUUID(),
        workspaceId: workspace.id,
        expectedCommit: commit,
        confirmed: true,
      },
      now: Date.now(),
    });
    assert.ok(existsSync(workspace.path), 'recording the request removes nothing');
    await settle(fixture);
    assert.equal(findWorkspaceCleanup(db, cleanup.id)?.status, 'removed');
    assert.equal(existsSync(workspace.path), false);
    assert.equal(git(repository.root, 'rev-parse', workspace.branch).trim(), commit);
    assert.deepEqual(refs(remote), remoteRefsBefore);

    // Restore: the original status and every record come back unchanged.
    const restored = restoreTask(db, { taskId });
    assert.equal(restored.status, 'done');
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.updatedAt, doneTask.updatedAt);
    assert.deepEqual(listTaskRuns(db, taskId), runs);
    assert.equal(listTaskWorkspaces(db, taskId).length, 1);

    // The operator's checkout, main branch and remote main were never touched.
    assert.equal(git(repository.root, 'rev-parse', 'main').trim(), mainBefore);
    assert.equal(git(repository.root, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
    assert.deepEqual(checkoutFiles(repository.root), checkoutBefore);
    assert.equal(git(remote, 'rev-parse', 'main').trim(), remoteMainBefore);
  });
});

test('journey: Discard keeps history and Git untouched; archive and restore keep Discarded; a changed worktree is never removed', async () => {
  await withExecutionFixture(async (fixture) => {
    const { db, repository } = fixture;
    const mainBefore = git(repository.root, 'rev-parse', 'main').trim();
    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex');
    assert.equal(await startAndStop(fixture, taskId, 'partial.txt'), 'stopped');
    const [run] = listTaskRuns(db, taskId);
    const [workspace] = listTaskWorkspaces(db, taskId);
    assert.ok(run && workspace);
    const filesBefore = snapshotTree(workspace.path);

    // Discard needs the attempt the operator saw and is a logical transition only.
    throwsCode(
      () => discardTask(db, { taskId, input: { runId: randomUUID(), confirmed: true }, now: 1 }),
      'task_run_changed',
    );
    const discarded = discardTask(db, {
      taskId,
      input: { runId: run.id, confirmed: true },
      now: Date.now(),
    });
    assert.equal(discarded.status, 'discarded');
    throwsCode(() => recover(fixture, taskId, 'resume'), 'recovery_not_available');
    throwsCode(
      () => transitionTask(db, { id: taskId, action: 'queue', now: 1 }),
      'illegal_transition',
    );
    await assertNothingStarts(fixture, taskId);
    assert.deepEqual(snapshotTree(workspace.path), filesBefore, 'worktree untouched');
    assert.equal(readFileSync(join(workspace.path, 'partial.txt'), 'utf8'), 'partial.txt\n');
    assert.match(git(repository.root, 'branch', '--list', workspace.branch), /agent\//);
    assert.deepEqual(listTaskRuns(db, taskId), [run]);

    // Archive and Restore keep Discarded and the update time.
    archiveTask(db, { taskId, now: Date.now() });
    const restored = restoreTask(db, { taskId });
    assert.equal(restored.status, 'discarded');
    assert.equal(restored.updatedAt, discarded.updatedAt);

    // A discarded worktree with partial work is never removed: even a request recorded directly
    // in the database fails closed when the worker re-checks Git.
    const { cleanup } = requestWorkspaceCleanup(db, {
      id: randomUUID(),
      taskId,
      input: {
        requestId: randomUUID(),
        workspaceId: workspace.id,
        expectedCommit: workspace.baseSha,
        confirmed: true,
      },
      now: Date.now(),
    });
    await settle(fixture);
    assert.equal(findWorkspaceCleanup(db, cleanup.id)?.status, 'failed');
    assert.deepEqual(snapshotTree(workspace.path), filesBefore, 'nothing was removed');
    assert.equal(git(repository.root, 'rev-parse', 'main').trim(), mainBefore);
  });
});

test('journey: Start, Return to Backlog and Queue again never runs the withdrawn start request', async () => {
  await withExecutionFixture(async (fixture) => {
    const { db } = fixture;
    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex');
    // Start is requested while no worker is polling, then the operator withdraws the task.
    requestTaskExecution(db, { id: randomUUID(), taskId, now: Date.now() });
    transitionTask(db, { id: taskId, action: 'return_to_backlog', now: Date.now() });
    assert.equal(findLatestTaskCommand(db, taskId)?.status, 'rejected');
    transitionTask(db, { id: taskId, action: 'queue', now: Date.now() });

    // A worker that comes back finds nothing to start: queueing again is not a Start.
    await assertNothingStarts(fixture, taskId);
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
    assert.equal(listTaskRuns(db, taskId).length, 0);

    // A new explicit Start runs the task normally.
    assert.equal(await startAndWait(fixture, taskId, completing('feature.txt')), 'review');
    assert.equal(listTaskRuns(db, taskId).length, 1);
  });
});
