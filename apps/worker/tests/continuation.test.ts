import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExecutionError, isRunReviewEligible } from '@ai-agent-manager/core';
import {
  claimStartCommand,
  findLatestTaskCommand,
  findPendingChangeRequest,
  findTaskById,
  listRunEvents,
  listTaskReviews,
  listTaskRuns,
  listTaskWorkspaces,
  requestRunStop,
  requestTaskChanges,
  setProjectExecutionTrust,
  workerCommands,
  type WorkspaceRecord,
} from '@ai-agent-manager/database';
import {
  git,
  snapshotTree,
  waitFor,
  withExecutionFixture,
  type ExecutionFixture,
  type FakeStep,
} from './execution-fixtures.js';

// Request Changes continuation (M6-02): a follow-up attempt continues in the reviewed attempt's
// retained worktree, only after an explicit Start, through the same claim, consent, trust,
// capacity, gate and integrity path. Disposable repositories and fake CLIs only.

const originalPrompt = 'Create hello.txt. Original prompt marker.';
const feedback = 'Rename hello.txt to greeting.txt and keep the README edit.';

const firstAttemptSteps: FakeStep[] = [
  { stdout: { type: 'thread.started', thread_id: 'thread-1' } },
  // Untracked file, as in the accepted real Codex run.
  { writeFile: 'hello.txt', content: 'hello\n' },
  // Tracked, uncommitted modification.
  { writeFile: 'README.md', content: 'fixture\nedited by attempt 1\n' },
  { stdout: { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'Done.' } } },
  { stdout: { type: 'turn.completed', usage: {} } },
];

const followUpSteps: FakeStep[] = [
  { stdout: { type: 'thread.started', thread_id: 'thread-2' } },
  { writeFile: 'greeting.txt', content: 'hello\n' },
  { stdout: { type: 'item.completed', item: { id: 'j', type: 'agent_message', text: 'Fixed.' } } },
  { stdout: { type: 'turn.completed', usage: {} } },
];

const terminal = ['review', 'failed', 'stopped', 'interrupted'] as const;

/** Runs attempt 1 to Review and records Request Changes for it, as the review page would. */
const reviewedAndChangesRequested = async (
  fixture: ExecutionFixture,
): Promise<{ taskId: string; workspace: WorkspaceRecord }> => {
  fixture.grantConsent();
  fixture.clis.codex.setSteps(firstAttemptSteps);
  const taskId = fixture.queuedTask('codex', originalPrompt);
  fixture.requestStart(taskId);
  const service = fixture.service();
  await service.start();
  try {
    await service.tick();
    assert.equal(await fixture.waitForTaskStatus(taskId, [...terminal]), 'review');
  } finally {
    await service.stop();
  }
  const [run] = listTaskRuns(fixture.db, taskId);
  assert.ok(run);
  requestTaskChanges(fixture.db, {
    id: randomUUID(),
    taskId,
    input: { runId: run.id, revision: 'inventory-revision', feedback },
    now: Date.now(),
  });
  assert.equal(findTaskById(fixture.db, taskId)?.status, 'queued');
  const [workspace] = listTaskWorkspaces(fixture.db, taskId);
  assert.ok(workspace);
  return { taskId, workspace };
};

const startFollowUp = async (
  fixture: ExecutionFixture,
  taskId: string,
  steps: FakeStep[] = followUpSteps,
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

const worktreeFiles = (path: string) =>
  [...snapshotTree(path).keys()].filter((name) => name !== '.git').sort();

test('Request Changes never launches an agent; Start continues attempt 2 in the same worktree', async () => {
  await withExecutionFixture(async (fixture) => {
    const { db, repository } = fixture;
    const mainBefore = git(repository.root, 'rev-parse', 'main').trim();
    const { taskId, workspace } = await reviewedAndChangesRequested(fixture);
    const [attemptOne] = listTaskRuns(db, taskId);
    assert.ok(attemptOne);
    const attemptOneEvents = listRunEvents(db, attemptOne.id);

    // No automatic launch: a running worker does nothing with the re-queued task.
    const idle = fixture.service();
    await idle.start();
    try {
      for (let index = 0; index < 5; index += 1) await idle.tick();
    } finally {
      await idle.stop();
    }
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
    assert.equal(listTaskRuns(db, taskId).length, 1);
    assert.equal(fixture.clis.codex.invocations().length, 1);
    assert.equal(findLatestTaskCommand(db, taskId)?.runId, attemptOne.id);

    assert.equal(await startFollowUp(fixture, taskId), 'review');

    const runs = listTaskRuns(db, taskId);
    assert.deepEqual(
      runs.map((run) => [run.attempt, run.status, run.gitIntegrityStatus, run.workspaceId]),
      [
        [2, 'completed', 'clean', workspace.id],
        [1, 'completed', 'clean', workspace.id],
      ],
    );
    const [attemptTwo] = runs;
    assert.ok(attemptTwo && isRunReviewEligible(attemptTwo));
    // Attempt 1's evidence is unchanged.
    assert.deepEqual(runs[1], attemptOne);
    assert.deepEqual(listRunEvents(db, attemptOne.id), attemptOneEvents);
    // One workspace record, no new worktree or branch.
    assert.deepEqual(listTaskWorkspaces(db, taskId), [workspace]);
    assert.deepEqual(
      git(repository.root, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length,
      2,
    );
    const [review] = listTaskReviews(db, taskId);
    assert.equal(review?.followUpRunId, attemptTwo.id);
    assert.equal(findPendingChangeRequest(db, taskId), undefined);

    // The CLI ran in the same worktree with the original prompt and the feedback.
    const invocations = fixture.clis.codex.invocations();
    assert.equal(invocations.length, 2);
    assert.equal(invocations[1]?.cwd, workspace.path);
    const stdin = invocations[1]?.stdin ?? '';
    assert.match(stdin, /Project instructions:\nKeep changes small\./);
    assert.ok(stdin.includes(originalPrompt));
    assert.ok(stdin.includes(`Review feedback on attempt 1:\n${feedback}`));
    assert.match(stdin, /follow-up attempt/);
    assert.ok(!(invocations[0]?.stdin ?? '').includes(feedback));

    // Tracked and untracked changes of attempt 1 survived; attempt 2 added its own.
    assert.equal(readFileSync(join(workspace.path, 'hello.txt'), 'utf8'), 'hello\n');
    assert.equal(
      readFileSync(join(workspace.path, 'README.md'), 'utf8'),
      'fixture\nedited by attempt 1\n',
    );
    assert.equal(readFileSync(join(workspace.path, 'greeting.txt'), 'utf8'), 'hello\n');
    const status = git(workspace.path, 'status', '--porcelain');
    assert.match(status, /^ M README\.md$/m);
    assert.match(status, /^\?\? hello\.txt$/m);
    assert.match(status, /^\?\? greeting\.txt$/m);

    // Nothing was committed, pushed, reset or cleaned.
    assert.equal(git(repository.root, 'rev-parse', workspace.branch).trim(), workspace.baseSha);
    assert.equal(git(workspace.path, 'rev-parse', 'HEAD').trim(), workspace.baseSha);
    assert.equal(git(repository.root, 'rev-parse', 'main').trim(), mainBefore);
    assert.equal(git(repository.root, 'status', '--porcelain'), '');

    // Attempt 2 reused the worktree; events never contain the prompt or the feedback.
    const events = listRunEvents(db, attemptTwo.id);
    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.includes('worktree_reused'));
    assert.ok(!kinds.includes('worktree_created'));
    assert.ok(!JSON.stringify(events).includes(feedback));
    assert.ok(!JSON.stringify(events).includes('Original prompt marker'));
  });
});

const tamperingCases: ReadonlyArray<{
  name: string;
  tamper: (fixture: ExecutionFixture, workspace: WorkspaceRecord) => void;
  check: (fixture: ExecutionFixture, workspace: WorkspaceRecord) => void;
}> = [
  {
    name: 'a commit on the task branch',
    tamper: (_fixture, workspace) => {
      git(workspace.path, 'add', '-A');
      git(workspace.path, 'commit', '--quiet', '-m', 'Manual commit');
    },
    check: (fixture, workspace) => {
      // The commit is kept, not reset.
      assert.notEqual(
        git(fixture.repository.root, 'rev-parse', workspace.branch).trim(),
        workspace.baseSha,
      );
    },
  },
  {
    name: 'an unlocked worktree',
    tamper: (fixture, workspace) => {
      git(fixture.repository.root, 'worktree', 'unlock', workspace.path);
    },
    check: (fixture, workspace) => {
      assert.ok(
        !git(fixture.repository.root, 'worktree', 'list', '--porcelain').includes(
          `worktree ${workspace.path}\nHEAD ${workspace.baseSha}\nbranch refs/heads/${workspace.branch}\nlocked`,
        ),
      );
    },
  },
  {
    name: 'a switched branch',
    tamper: (_fixture, workspace) => {
      git(workspace.path, 'switch', '--quiet', '-c', 'tampered');
    },
    check: (_fixture, workspace) => {
      assert.equal(git(workspace.path, 'branch', '--show-current').trim(), 'tampered');
    },
  },
];

for (const { name, tamper, check } of tamperingCases) {
  test(`${name} in the retained worktree refuses the follow-up attempt and changes nothing`, async () => {
    await withExecutionFixture(async (fixture) => {
      const { taskId, workspace } = await reviewedAndChangesRequested(fixture);
      tamper(fixture, workspace);
      const filesBefore = worktreeFiles(workspace.path);
      assert.equal(await startFollowUp(fixture, taskId), 'failed');
      const [attemptTwo] = listTaskRuns(fixture.db, taskId);
      assert.equal(attemptTwo?.attempt, 2);
      assert.equal(attemptTwo?.errorCode, 'continuation_unavailable');
      assert.match(attemptTwo?.errorMessage ?? '', /Nothing was started, reset or cleaned/);
      assert.equal(attemptTwo?.authorizationId, null);
      // The CLI never ran again, no new worktree was created, and files are untouched.
      assert.equal(fixture.clis.codex.invocations().length, 1);
      assert.equal(listTaskWorkspaces(fixture.db, taskId).length, 1);
      assert.deepEqual(worktreeFiles(workspace.path), filesBefore);
      assert.ok(existsSync(join(workspace.path, 'hello.txt')));
      check(fixture, workspace);
      // The feedback stays attached to the refused attempt for inspection.
      assert.equal(listTaskReviews(fixture.db, taskId)[0]?.followUpRunId, attemptTwo?.id);
    });
  });
}

test('consent and project trust are re-checked for the follow-up attempt', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId } = await reviewedAndChangesRequested(fixture);
    setProjectExecutionTrust(fixture.db, {
      projectId: fixture.projectId,
      trust: { trust: 'none' },
      now: Date.now(),
    });
    assert.throws(
      () => fixture.requestStart(taskId),
      (error: unknown) => error instanceof ExecutionError && error.code === 'project_not_trusted',
    );
    // A command written directly is refused by the claim as well.
    fixture.db
      .insert(workerCommands)
      .values({
        id: randomUUID(),
        kind: 'start_task',
        taskId,
        status: 'pending',
        createdAt: Date.now(),
      })
      .run();
    const service = fixture.service();
    await service.start();
    try {
      await service.tick();
    } finally {
      await service.stop();
    }
    assert.equal(findLatestTaskCommand(fixture.db, taskId)?.resultCode, 'project_not_trusted');
    assert.equal(listTaskRuns(fixture.db, taskId).length, 1);
    assert.equal(fixture.clis.codex.invocations().length, 1);
    assert.notEqual(findPendingChangeRequest(fixture.db, taskId), undefined);
    assert.equal(findTaskById(fixture.db, taskId)?.status, 'queued');
  });
});

test('the per-runtime limit applies to follow-up attempts; a refused start keeps the feedback', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId } = await reviewedAndChangesRequested(fixture);
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
      assert.notEqual(findPendingChangeRequest(fixture.db, taskId), undefined);
      requestRunStop(fixture.db, { taskId: other, now: Date.now() });
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(other, ['stopped']), 'stopped');
    } finally {
      await service.stop();
    }
    assert.equal(await startFollowUp(fixture, taskId), 'review');
    assert.equal(listTaskRuns(fixture.db, taskId)[0]?.attempt, 2);
  });
});

test('Stop on a follow-up attempt keeps the files of both attempts', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId, workspace } = await reviewedAndChangesRequested(fixture);
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
      await waitFor(() => fixture.clis.codex.invocations().length === 2);
      requestRunStop(fixture.db, { taskId, now: Date.now() });
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(taskId, [...terminal]), 'stopped');
    } finally {
      await service.stop();
    }
    const [attemptTwo] = listTaskRuns(fixture.db, taskId);
    assert.equal(attemptTwo?.status, 'stopped');
    assert.equal(attemptTwo?.gitIntegrityStatus, 'clean');
    for (const file of ['hello.txt', 'partial.txt']) {
      assert.ok(existsSync(join(workspace.path, file)), `${file} is kept`);
    }
    assert.equal(
      readFileSync(join(workspace.path, 'README.md'), 'utf8'),
      'fixture\nedited by attempt 1\n',
    );
  });
});

test('the mandatory timeout applies to follow-up attempts', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId, workspace } = await reviewedAndChangesRequested(fixture);
    assert.equal(
      await startFollowUp(fixture, taskId, [{ hang: true }], { runTimeoutMs: 500 }),
      'failed',
    );
    const [attemptTwo] = listTaskRuns(fixture.db, taskId);
    assert.equal(attemptTwo?.errorCode, 'timeout');
    assert.equal(attemptTwo?.timeoutMs, 500);
    assert.ok(existsSync(join(workspace.path, 'hello.txt')));
  });
});

test('an agent commit in a follow-up attempt is a Git integrity violation and is kept', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId, workspace } = await reviewedAndChangesRequested(fixture);
    assert.equal(
      await startFollowUp(fixture, taskId, [
        { writeFile: 'greeting.txt', content: 'hello\n' },
        { gitCommit: 'Agent commit' },
        { stdout: { type: 'turn.completed', usage: {} } },
      ]),
      'failed',
    );
    const [attemptTwo] = listTaskRuns(fixture.db, taskId);
    assert.ok(attemptTwo);
    assert.equal(attemptTwo.status, 'completed');
    assert.equal(attemptTwo.gitIntegrityStatus, 'violation');
    assert.equal(attemptTwo.errorCode, 'git_integrity_violation');
    assert.equal(isRunReviewEligible(attemptTwo), false);
    assert.notEqual(
      git(fixture.repository.root, 'rev-parse', workspace.branch).trim(),
      workspace.baseSha,
    );
  });
});

test('a follow-up attempt left active by a crashed worker is marked Interrupted, never relaunched', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId, workspace } = await reviewedAndChangesRequested(fixture);
    fixture.requestStart(taskId);
    const command = findLatestTaskCommand(fixture.db, taskId);
    assert.ok(command);
    // A worker instance that claimed the attempt and then disappeared.
    const claimed = claimStartCommand(fixture.db, {
      commandId: command.id,
      runId: randomUUID(),
      workerInstanceId: 'crashed-worker',
      timeoutMs: 60_000,
      now: Date.now(),
    });
    assert.ok(claimed.claimed && claimed.claim.continuation !== null);
    const service = fixture.service();
    await service.start();
    try {
      await service.tick();
    } finally {
      await service.stop();
    }
    const [attemptTwo] = listTaskRuns(fixture.db, taskId);
    assert.equal(attemptTwo?.attempt, 2);
    assert.equal(attemptTwo?.status, 'interrupted');
    assert.equal(attemptTwo?.errorCode, 'worker_restarted');
    assert.equal(attemptTwo?.workspaceId, workspace.id);
    assert.equal(findTaskById(fixture.db, taskId)?.status, 'interrupted');
    assert.equal(fixture.clis.codex.invocations().length, 1);
    assert.ok(existsSync(join(workspace.path, 'hello.txt')));
  });
});

test('a graceful shutdown during a follow-up attempt records it as Interrupted', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId, workspace } = await reviewedAndChangesRequested(fixture);
    fixture.clis.codex.setSteps([{ hang: true }]);
    fixture.requestStart(taskId);
    const service = fixture.service();
    await service.start();
    await service.tick();
    await waitFor(() => listTaskRuns(fixture.db, taskId)[0]?.status === 'running');
    await service.stop();
    const [attemptTwo] = listTaskRuns(fixture.db, taskId);
    assert.equal(attemptTwo?.status, 'interrupted');
    assert.equal(attemptTwo?.errorCode, 'worker_shutdown');
    assert.equal(attemptTwo?.gitIntegrityStatus, 'clean');
    assert.ok(existsSync(join(workspace.path, 'hello.txt')));
  });
});

test('a changed managed worktree root refuses the follow-up attempt instead of creating a new worktree', async () => {
  await withExecutionFixture(async (fixture) => {
    const { taskId, workspace } = await reviewedAndChangesRequested(fixture);
    const otherRoot = join(fixture.directory, 'other-worktrees');
    assert.equal(
      await startFollowUp(fixture, taskId, followUpSteps, { worktreeRoot: otherRoot }),
      'failed',
    );
    const [attemptTwo] = listTaskRuns(fixture.db, taskId);
    assert.equal(attemptTwo?.errorCode, 'continuation_unavailable');
    assert.match(attemptTwo?.errorMessage ?? '', /managed worktree root changed/);
    assert.equal(existsSync(otherRoot), false);
    assert.equal(fixture.clis.codex.invocations().length, 1);
    assert.deepEqual(listTaskWorkspaces(fixture.db, taskId), [workspace]);
  });
});
