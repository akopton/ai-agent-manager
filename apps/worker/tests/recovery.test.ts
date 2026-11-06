import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExecutionError, type TaskRecoveryKind } from '@ai-agent-manager/core';
import {
  claimStartCommand,
  findLatestTaskCommand,
  findPendingRecovery,
  findTaskById,
  listRunEvents,
  listTaskRecoveries,
  listTaskReviews,
  listTaskRuns,
  listTaskWorkspaces,
  requestRunStop,
  requestTaskChanges,
  requestTaskRecovery,
  setProjectExecutionTrust,
  transitionTask,
  updateTask,
} from '@ai-agent-manager/database';
import { isProcessGroupAlive } from '@ai-agent-manager/git';
import {
  git,
  snapshotTree,
  waitFor,
  withExecutionFixture,
  type ExecutionFixture,
  type FakeStep,
} from './execution-fixtures.js';

// TM-01 Retry and Resume through the real worker path: a recovered attempt runs only after an
// explicit Start, continues in the retained worktree with its tracked and untracked changes, and
// goes through the same claim, consent, trust, capacity, gate and integrity checks. Disposable
// repositories and fake CLIs only.

const terminal = ['review', 'failed', 'stopped', 'interrupted'] as const;

/** Attempt 1 writes an untracked and a tracked change, then exits non-zero. */
const failingSteps: FakeStep[] = [
  { stdout: { type: 'thread.started', thread_id: 'thread-1' } },
  { writeFile: 'partial.txt', content: 'partial\n' },
  { writeFile: 'README.md', content: 'fixture\nedited by attempt 1\n' },
  { stderr: 'boom' },
  { exit: 3 },
];

const finishingSteps: FakeStep[] = [
  { stdout: { type: 'thread.started', thread_id: 'thread-2' } },
  { writeFile: 'finished.txt', content: 'finished\n' },
  { stdout: { type: 'item.completed', item: { id: 'j', type: 'agent_message', text: 'Done.' } } },
  { stdout: { type: 'turn.completed', usage: {} } },
];

const runToEnd = async (
  fixture: ExecutionFixture,
  taskId: string,
  steps: FakeStep[],
  overrides: Parameters<ExecutionFixture['service']>[0] = {},
) => {
  fixture.clis.codex.setSteps(steps);
  fixture.requestStart(taskId);
  const service = fixture.service(overrides);
  await service.start();
  try {
    await service.tick();
    return await fixture.waitForTaskStatus(taskId, [...terminal]);
  } finally {
    await service.stop();
  }
};

/** Records Retry/Resume as the web route would after its own worktree check. */
const recover = (
  fixture: ExecutionFixture,
  taskId: string,
  kind: TaskRecoveryKind,
  processStopConfirmed = false,
) => {
  const [latest] = listTaskRuns(fixture.db, taskId);
  assert.ok(latest);
  return requestTaskRecovery(fixture.db, {
    id: randomUUID(),
    taskId,
    kind,
    input: { runId: latest.id, processStopConfirmed },
    expectedWorkspaceId: listTaskWorkspaces(fixture.db, taskId)[0]?.id ?? null,
    probeProcessGroup: isProcessGroupAlive,
    now: Date.now(),
  });
};

const failedTask = async (fixture: ExecutionFixture, prompt = 'Original prompt marker.') => {
  fixture.grantConsent();
  const taskId = fixture.queuedTask('codex', prompt);
  assert.equal(await runToEnd(fixture, taskId, failingSteps), 'failed');
  const [workspace] = listTaskWorkspaces(fixture.db, taskId);
  assert.ok(workspace);
  return { taskId, workspace };
};

const idleTicks = async (fixture: ExecutionFixture): Promise<void> => {
  const idle = fixture.service();
  await idle.start();
  try {
    for (let index = 0; index < 5; index += 1) await idle.tick();
  } finally {
    await idle.stop();
  }
};

const worktreeFiles = (path: string) =>
  [...snapshotTree(path).keys()].filter((name) => name !== '.git').sort();

test('Retry starts nothing; Start continues attempt 1 as attempt 2 in the same worktree', async () => {
  await withExecutionFixture(async (fixture) => {
    const { db, repository } = fixture;
    const mainBefore = git(repository.root, 'rev-parse', 'main').trim();
    const { taskId, workspace } = await failedTask(fixture);
    const [attemptOne] = listTaskRuns(db, taskId);
    assert.ok(attemptOne);
    assert.equal(attemptOne.errorCode, 'non_zero_exit');
    const attemptOneEvents = listRunEvents(db, attemptOne.id);
    const commandBefore = findLatestTaskCommand(db, taskId);

    const { recovery } = recover(fixture, taskId, 'retry');
    assert.equal(recovery.processCheck, 'process_group_gone');
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
    // No process starts on Retry, even with a running worker.
    await idleTicks(fixture);
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
    assert.equal(listTaskRuns(db, taskId).length, 1);
    assert.equal(fixture.clis.codex.invocations().length, 1);
    assert.deepEqual(findLatestTaskCommand(db, taskId), commandBefore);

    assert.equal(await runToEnd(fixture, taskId, finishingSteps), 'review');

    const runs = listTaskRuns(db, taskId);
    assert.deepEqual(
      runs.map((run) => [run.attempt, run.status, run.workspaceId]),
      [
        [2, 'completed', workspace.id],
        [1, 'failed', workspace.id],
      ],
    );
    assert.deepEqual(runs[1], attemptOne);
    assert.deepEqual(listRunEvents(db, attemptOne.id), attemptOneEvents);
    assert.deepEqual(listTaskWorkspaces(db, taskId), [workspace]);
    assert.equal(listTaskRecoveries(db, taskId)[0]?.followUpRunId, runs[0]?.id);
    assert.equal(findPendingRecovery(db, taskId), undefined);

    // Same worktree, original prompt plus the recovery note; no feedback without a review.
    const invocations = fixture.clis.codex.invocations();
    assert.equal(invocations.length, 2);
    assert.equal(invocations[1]?.cwd, workspace.path);
    const stdin = invocations[1]?.stdin ?? '';
    assert.ok(stdin.includes('Original prompt marker.'));
    assert.match(stdin, /new attempt after attempt 1 failed/);
    assert.match(stdin, /new agent session/);
    assert.match(stdin, /still contains the changes from earlier attempts/);
    assert.ok(!stdin.includes('Review feedback'));

    // Tracked and untracked changes from attempt 1 survived; attempt 2 added its own.
    assert.equal(readFileSync(join(workspace.path, 'partial.txt'), 'utf8'), 'partial\n');
    assert.equal(
      readFileSync(join(workspace.path, 'README.md'), 'utf8'),
      'fixture\nedited by attempt 1\n',
    );
    assert.ok(existsSync(join(workspace.path, 'finished.txt')));
    const status = git(workspace.path, 'status', '--porcelain');
    assert.match(status, /^ M README\.md$/m);
    assert.match(status, /^\?\? partial\.txt$/m);

    // Nothing was committed, pushed, reset, cleaned or recreated.
    assert.equal(git(repository.root, 'rev-parse', workspace.branch).trim(), workspace.baseSha);
    assert.equal(git(repository.root, 'rev-parse', 'main').trim(), mainBefore);
    assert.equal(git(repository.root, 'status', '--porcelain'), '');
    const kinds = listRunEvents(db, runs[0]?.id ?? '').map((event) => event.kind);
    assert.ok(kinds.includes('worktree_reused'));
    assert.ok(!kinds.includes('worktree_created'));
  });
});

test('Resume after Stop continues the worktree with a new session', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex');
    fixture.clis.codex.setSteps([
      { writeFile: 'partial.txt', content: 'partial\n' },
      { hang: true },
    ]);
    fixture.requestStart(taskId);
    const service = fixture.service();
    await service.start();
    try {
      await service.tick();
      await waitFor(() => listTaskRuns(fixture.db, taskId)[0]?.status === 'running');
      await waitFor(() =>
        existsSync(join(listTaskWorkspaces(fixture.db, taskId)[0]?.path ?? '', 'partial.txt')),
      );
      requestRunStop(fixture.db, { taskId, now: Date.now() });
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(taskId, [...terminal]), 'stopped');
    } finally {
      await service.stop();
    }
    const [stopped] = listTaskRuns(fixture.db, taskId);
    assert.ok(stopped?.pid !== null);
    // The stopped process group is gone, so Resume is allowed without a confirmation.
    assert.equal(recover(fixture, taskId, 'resume').recovery.processCheck, 'process_group_gone');
    assert.equal(await runToEnd(fixture, taskId, finishingSteps), 'review');
    const [workspace] = listTaskWorkspaces(fixture.db, taskId);
    assert.ok(workspace);
    assert.ok(existsSync(join(workspace.path, 'partial.txt')));
    assert.ok(existsSync(join(workspace.path, 'finished.txt')));
    const stdin = fixture.clis.codex.invocations()[1]?.stdin ?? '';
    assert.match(stdin, /after attempt 1 was stopped or interrupted before it finished/);
    assert.deepEqual(
      listTaskRuns(fixture.db, taskId).map((run) => run.attempt),
      [2, 1],
    );
  });
});

test('Resume after an interruption by a crashed worker, with no process launched', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const command = findLatestTaskCommand(fixture.db, taskId);
    assert.ok(command);
    // A worker claimed attempt 1 and disappeared before it created a worktree or launched.
    assert.ok(
      claimStartCommand(fixture.db, {
        commandId: command.id,
        runId: randomUUID(),
        workerInstanceId: 'crashed-worker',
        timeoutMs: 60_000,
        now: Date.now(),
      }).claimed,
    );
    await idleTicks(fixture);
    assert.equal(findTaskById(fixture.db, taskId)?.status, 'interrupted');
    assert.equal(listTaskWorkspaces(fixture.db, taskId).length, 0);
    const { recovery } = recover(fixture, taskId, 'resume');
    assert.equal(recovery.processCheck, 'not_launched');
    assert.equal(recovery.workspaceId, null);
    assert.equal(await runToEnd(fixture, taskId, finishingSteps), 'review');
    const runs = listTaskRuns(fixture.db, taskId);
    assert.deepEqual(
      runs.map((run) => [run.attempt, run.status]),
      [
        [2, 'completed'],
        [1, 'interrupted'],
      ],
    );
    // The worktree is created for attempt 2, from the base branch.
    const kinds = listRunEvents(fixture.db, runs[0]?.id ?? '').map((event) => event.kind);
    assert.ok(kinds.includes('worktree_created'));
    assert.match(
      fixture.clis.codex.invocations()[0]?.stdin ?? '',
      /before a working directory was prepared/,
    );
  });
});

test('Retry after a failure before the worktree existed creates the worktree on the next Start', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex');
    // The task's base branch does not exist, so attempt 1 fails before a worktree is created.
    transitionTask(fixture.db, { id: taskId, action: 'return_to_backlog', now: Date.now() });
    updateTask(fixture.db, { id: taskId, input: { baseBranch: 'missing' }, now: Date.now() });
    transitionTask(fixture.db, { id: taskId, action: 'queue', now: Date.now() });
    assert.equal(await runToEnd(fixture, taskId, finishingSteps), 'failed');
    assert.equal(listTaskRuns(fixture.db, taskId)[0]?.errorCode, 'worktree_failed');
    assert.equal(listTaskWorkspaces(fixture.db, taskId).length, 0);
    assert.equal(fixture.clis.codex.invocations().length, 0);

    // Retry, then fix the base branch in Backlog: the pending Retry is kept.
    recover(fixture, taskId, 'retry');
    transitionTask(fixture.db, { id: taskId, action: 'return_to_backlog', now: Date.now() });
    updateTask(fixture.db, { id: taskId, input: { baseBranch: 'main' }, now: Date.now() });
    transitionTask(fixture.db, { id: taskId, action: 'queue', now: Date.now() });
    assert.equal(await runToEnd(fixture, taskId, finishingSteps), 'review');
    const [attemptTwo] = listTaskRuns(fixture.db, taskId);
    assert.equal(attemptTwo?.attempt, 2);
    const [workspace] = listTaskWorkspaces(fixture.db, taskId);
    assert.equal(workspace?.generation, 2);
    assert.equal(attemptTwo?.workspaceId, workspace?.id);
  });
});

test('a tampered worktree refuses the recovered attempt at launch and changes nothing', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId, workspace } = await failedTask(fixture);
    recover(fixture, taskId, 'retry');
    // Tampering after Retry was recorded (the web check passed): a commit on the task branch.
    git(workspace.path, 'add', '-A');
    git(workspace.path, 'commit', '--quiet', '-m', 'Manual commit');
    const filesBefore = worktreeFiles(workspace.path);
    const head = git(workspace.path, 'rev-parse', 'HEAD').trim();
    assert.equal(await runToEnd(fixture, taskId, finishingSteps), 'failed');
    const [attemptTwo] = listTaskRuns(fixture.db, taskId);
    assert.equal(attemptTwo?.attempt, 2);
    assert.equal(attemptTwo?.errorCode, 'continuation_unavailable');
    assert.match(attemptTwo?.errorMessage ?? '', /Nothing was started, reset or cleaned/);
    assert.equal(attemptTwo?.authorizationId, null);
    assert.equal(fixture.clis.codex.invocations().length, 1);
    assert.deepEqual(worktreeFiles(workspace.path), filesBefore);
    assert.equal(git(workspace.path, 'rev-parse', 'HEAD').trim(), head);
    assert.equal(listTaskWorkspaces(fixture.db, taskId).length, 1);
    // The refused attempt is itself Failed and can be inspected; Retry is refused by the web
    // check while the worktree stays tampered (covered by the web tests).
  });
});

test('a live process group of the previous attempt refuses Start; the task stays Queued', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId } = await failedTask(fixture);
    recover(fixture, taskId, 'retry');
    fixture.clis.codex.setSteps(finishingSteps);
    fixture.requestStart(taskId);
    const service = fixture.service({ probeProcessGroup: () => true });
    await service.start();
    try {
      await service.tick();
    } finally {
      await service.stop();
    }
    const command = findLatestTaskCommand(fixture.db, taskId);
    assert.equal(command?.status, 'rejected');
    assert.equal(command?.resultCode, 'continuation_unavailable');
    assert.match(command?.resultMessage ?? '', /still exists/);
    assert.equal(findTaskById(fixture.db, taskId)?.status, 'queued');
    assert.equal(listTaskRuns(fixture.db, taskId).length, 1);
    assert.equal(fixture.clis.codex.invocations().length, 1);
    assert.notEqual(findPendingRecovery(fixture.db, taskId), undefined);
  });
});

test('Start of a recovered attempt re-checks consent, trust and the per-runtime limit', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId } = await failedTask(fixture);
    recover(fixture, taskId, 'retry');
    setProjectExecutionTrust(fixture.db, {
      projectId: fixture.projectId,
      trust: { trust: 'none' },
      now: Date.now(),
    });
    assert.throws(
      () => fixture.requestStart(taskId),
      (error: unknown) => error instanceof ExecutionError && error.code === 'project_not_trusted',
    );
    fixture.grantConsent();
    // Another Codex run holds the only Codex slot.
    fixture.clis.codex.setSteps([{ hang: true }]);
    const other = fixture.queuedTask('codex');
    const service = fixture.service();
    await service.start();
    try {
      fixture.requestStart(other);
      await service.tick();
      await waitFor(() => listTaskRuns(fixture.db, other)[0]?.status === 'running');
      fixture.requestStart(taskId);
      await service.tick();
      assert.equal(findLatestTaskCommand(fixture.db, taskId)?.resultCode, 'runtime_busy');
      assert.equal(findTaskById(fixture.db, taskId)?.status, 'queued');
      assert.notEqual(findPendingRecovery(fixture.db, taskId), undefined);
      requestRunStop(fixture.db, { taskId: other, now: Date.now() });
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(other, ['stopped']), 'stopped');
    } finally {
      await service.stop();
    }
    assert.equal(await runToEnd(fixture, taskId, finishingSteps), 'review');
    assert.equal(listTaskRuns(fixture.db, taskId)[0]?.attempt, 2);
  });
});

test('Retry of a failed follow-up attempt sends the pending review feedback again', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex', 'Original prompt marker.');
    assert.equal(await runToEnd(fixture, taskId, finishingSteps), 'review');
    const [reviewed] = listTaskRuns(fixture.db, taskId);
    assert.ok(reviewed);
    const feedback = 'Rename finished.txt to done.txt.';
    requestTaskChanges(fixture.db, {
      id: randomUUID(),
      taskId,
      input: { runId: reviewed.id, revision: 'rev', feedback },
      now: Date.now(),
    });
    // The follow-up attempt (2) fails.
    assert.equal(await runToEnd(fixture, taskId, failingSteps), 'failed');
    const [review] = listTaskReviews(fixture.db, taskId);
    assert.equal(review?.followUpRunId, listTaskRuns(fixture.db, taskId)[0]?.id);

    recover(fixture, taskId, 'retry');
    assert.equal(await runToEnd(fixture, taskId, finishingSteps), 'review');
    const stdin = fixture.clis.codex.invocations()[2]?.stdin ?? '';
    assert.ok(stdin.includes(`Review feedback on attempt 1:\n${feedback}`));
    assert.match(stdin, /new attempt after attempt 2 failed/);
    assert.match(stdin, /to address the review feedback/);
    assert.deepEqual(
      listTaskRuns(fixture.db, taskId).map((run) => [run.attempt, run.status]),
      [
        [3, 'completed'],
        [2, 'failed'],
        [1, 'completed'],
      ],
    );
    // The review record still points at the attempt that first continued from it.
    assert.deepEqual(listTaskReviews(fixture.db, taskId), [review]);
  });
});
