import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  TaskError,
  TaskRecoveryError,
  trustedLocalDisclosure,
  type TaskRecoveryErrorCode,
} from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  applyMigrations,
  claimStartCommand,
  createDatabase,
  createPublication,
  createTask,
  discardTask,
  findLatestTaskCommand,
  findPendingRecovery,
  findTaskById,
  finishTaskRun,
  insertProject,
  listRunEvents,
  listTaskRecoveries,
  listTaskReviews,
  listTaskRuns,
  listTaskWorkspaces,
  recordGitIntegrity,
  recordRunWorkspace,
  requestTaskChanges,
  requestTaskExecution,
  requestTaskRecovery,
  setProjectExecutionTrust,
  transitionTask,
  updateTaskRunProgress,
  type DatabaseConnection,
  type RunFinish,
} from '../src/index.js';

// TM-01 persistence: Retry/Resume record a decision for the latest attempt and queue the task
// without a start request; the next claim binds the decision and continues in the same workspace.
// Discard is a logical transition that deletes nothing.

type Database = DatabaseConnection['db'];

const projectA = '00000000-0000-4000-8000-00000000000a';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const gone = (): boolean => false;
const alive = (): boolean => true;

const withDatabase = (run: (db: Database, sqlite: DatabaseConnection['sqlite']) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-recoveries-'));
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

const claim = (
  db: Database,
  commandId: string,
  runId: string,
  now: number,
  /** `null` claims without a probe. */
  probeProcessGroup: ((pid: number) => boolean) | null = gone,
) =>
  claimStartCommand(db, {
    commandId,
    runId,
    workerInstanceId: 'worker-1',
    timeoutMs: 60_000,
    now,
    ...(probeProcessGroup === null ? {} : { probeProcessGroup }),
  });

const workspaceFor = (taskId: string, n: number) => ({
  id: uuid(n),
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
});

type Ending = Pick<RunFinish, 'status' | 'taskAction'> & Partial<RunFinish>;

const failed: Ending = { status: 'failed', taskAction: 'fail', errorCode: 'nonzero_exit' };
const stopped: Ending = { status: 'stopped', taskAction: 'stop' };
const interrupted: Ending = {
  status: 'interrupted',
  taskAction: 'interrupt',
  errorCode: 'worker_restarted',
};

/**
 * Runs attempt 1 of a new task to the given ending. `workspace: false` simulates a failure before
 * the worktree was created; `pid` records a launched process.
 */
const endedTask = (
  db: Database,
  n: number,
  ending: Ending,
  { workspace = true, pid = null }: { workspace?: boolean; pid?: number | null } = {},
) => {
  const taskId = uuid(n);
  createTask(db, {
    id: taskId,
    input: { projectId: projectA, title: `Task ${n}`, prompt: 'Do it.', agentRuntime: 'codex' },
    now: 20,
  });
  transitionTask(db, { id: taskId, action: 'queue', now: 21 });
  requestTaskExecution(db, { id: uuid(n * 10 + 1), taskId, now: 25 });
  const result = claim(db, uuid(n * 10 + 1), uuid(n * 10 + 2), 30);
  assert.ok(result.claimed);
  const runId = result.claim.run.id;
  let workspaceId: string | null = null;
  if (workspace) {
    workspaceId = recordRunWorkspace(db, {
      runId,
      workspace: workspaceFor(taskId, n * 10 + 3),
    }).id;
  }
  if (pid !== null) {
    updateTaskRunProgress(db, runId, { pid, authorizationId: 'auth-1', status: 'running' }, 32);
  }
  finishTaskRun(db, runId, { ...ending, endedAt: 33 });
  return { taskId, runId, workspaceId };
};

const throwsRecovery = (run: () => unknown, code: TaskRecoveryErrorCode): void => {
  assert.throws(
    run,
    (error: unknown) => error instanceof TaskRecoveryError && error.code === code,
    `expected ${code}`,
  );
};

const recover = (
  db: Database,
  {
    n,
    taskId,
    kind,
    runId,
    workspaceId,
    probe = gone,
    confirmed,
    now = 40,
  }: {
    n: number;
    taskId: string;
    kind: 'retry' | 'resume';
    runId: string;
    workspaceId: string | null;
    probe?: (pid: number) => boolean;
    confirmed?: boolean;
    now?: number;
  },
) =>
  requestTaskRecovery(db, {
    id: uuid(n),
    taskId,
    kind,
    input: { runId, ...(confirmed === undefined ? {} : { processStopConfirmed: confirmed }) },
    expectedWorkspaceId: workspaceId,
    probeProcessGroup: probe,
    now,
  });

test('Retry from Failed records the decision, queues the task and starts nothing', () => {
  withDatabase((db) => {
    const { taskId, runId, workspaceId } = endedTask(db, 1, failed);
    const command = findLatestTaskCommand(db, taskId);
    const runsBefore = listTaskRuns(db, taskId);
    const eventsBefore = listRunEvents(db, runId);
    const { recovery, task } = recover(db, { n: 900, taskId, kind: 'retry', runId, workspaceId });
    assert.equal(task.status, 'queued');
    assert.equal(task.queuedAt, 40);
    assert.equal(recovery.kind, 'retry');
    assert.equal(recovery.sourceRunId, runId);
    assert.equal(recovery.sourceStatus, 'failed');
    assert.equal(recovery.workspaceId, workspaceId);
    assert.equal(recovery.reviewId, null);
    assert.equal(recovery.processCheck, 'not_launched');
    assert.equal(recovery.followUpRunId, null);
    assert.deepEqual(findPendingRecovery(db, taskId), recovery);
    // No start request, no new run, earlier evidence untouched.
    assert.deepEqual(findLatestTaskCommand(db, taskId), command);
    assert.deepEqual(listTaskRuns(db, taskId), runsBefore);
    assert.deepEqual(listRunEvents(db, runId), eventsBefore);
  });
});

test('eligibility: Retry only from Failed, Resume only from Stopped and Interrupted', () => {
  withDatabase((db) => {
    const f = endedTask(db, 1, failed);
    const s = endedTask(db, 2, stopped);
    const i = endedTask(db, 3, interrupted);
    throwsRecovery(() => recover(db, { n: 900, ...f, kind: 'resume' }), 'recovery_not_available');
    throwsRecovery(() => recover(db, { n: 901, ...s, kind: 'retry' }), 'recovery_not_available');
    throwsRecovery(() => recover(db, { n: 902, ...i, kind: 'retry' }), 'recovery_not_available');
    assert.equal(recover(db, { n: 903, ...s, kind: 'resume' }).task.status, 'queued');
    assert.equal(recover(db, { n: 904, ...i, kind: 'resume' }).task.status, 'queued');
    assert.equal(recover(db, { n: 905, ...f, kind: 'retry' }).task.status, 'queued');
    // Not from Queued (already recovered), Review, Backlog or a missing task.
    throwsRecovery(() => recover(db, { n: 906, ...f, kind: 'retry' }), 'recovery_not_available');
    const backlog = uuid(50);
    createTask(db, {
      id: backlog,
      input: { projectId: projectA, title: 'B', prompt: 'Do it.', agentRuntime: 'claude' },
      now: 20,
    });
    throwsRecovery(
      () =>
        recover(db, { n: 907, taskId: backlog, kind: 'retry', runId: uuid(1), workspaceId: null }),
      'recovery_not_available',
    );
    assert.throws(
      () =>
        recover(db, { n: 908, taskId: uuid(51), kind: 'retry', runId: uuid(1), workspaceId: null }),
      (error: unknown) => error instanceof TaskError && error.code === 'task_not_found',
    );
    throwsRecovery(
      () =>
        requestTaskRecovery(db, {
          id: uuid(909),
          taskId: f.taskId,
          kind: 'retry',
          input: { runId: 'not-a-uuid' },
          expectedWorkspaceId: null,
          probeProcessGroup: gone,
          now: 40,
        }),
      'invalid_recovery_input',
    );
  });
});

test('stale and competing requests are refused without a second record', () => {
  withDatabase((db) => {
    const { taskId, runId, workspaceId } = endedTask(db, 1, failed);
    throwsRecovery(
      () => recover(db, { n: 900, taskId, kind: 'retry', runId: uuid(999), workspaceId }),
      'task_run_changed',
    );
    throwsRecovery(
      () => recover(db, { n: 901, taskId, kind: 'retry', runId, workspaceId: uuid(998) }),
      'workspace_unavailable',
    );
    assert.equal(findTaskById(db, taskId)?.status, 'failed');
    assert.deepEqual(listTaskRecoveries(db, taskId), []);
    // Two tabs submit the same Retry: the second one finds the task already Queued.
    recover(db, { n: 902, taskId, kind: 'retry', runId, workspaceId });
    throwsRecovery(
      () => recover(db, { n: 903, taskId, kind: 'retry', runId, workspaceId }),
      'recovery_not_available',
    );
    // A competing Discard of the same attempt is refused too.
    throwsRecovery(
      () => discardTask(db, { taskId, input: { runId, confirmed: true }, now: 41 }),
      'discard_not_available',
    );
    assert.equal(listTaskRecoveries(db, taskId).length, 1);
  });
});

test('a still-existing process group refuses Resume; an unknown process needs a confirmation', () => {
  withDatabase((db, sqlite) => {
    const launched = endedTask(db, 1, interrupted, { pid: 4242 });
    throwsRecovery(
      () => recover(db, { n: 900, ...launched, kind: 'resume', probe: alive }),
      'process_may_be_running',
    );
    // No probe means nothing can be ruled out.
    throwsRecovery(
      () =>
        requestTaskRecovery(db, {
          id: uuid(901),
          taskId: launched.taskId,
          kind: 'resume',
          input: { runId: launched.runId },
          expectedWorkspaceId: launched.workspaceId,
          probeProcessGroup: undefined,
          now: 40,
        }),
      'process_may_be_running',
    );
    assert.equal(findTaskById(db, launched.taskId)?.status, 'interrupted');
    const resumed = recover(db, { n: 902, ...launched, kind: 'resume', probe: gone });
    assert.equal(resumed.recovery.processCheck, 'process_group_gone');

    // Authorized, then the worker restarted before the PID was recorded.
    const unknown = endedTask(db, 2, interrupted);
    sqlite
      .prepare("UPDATE task_runs SET authorization_id = 'auth-2' WHERE id = ?")
      .run(unknown.runId);
    throwsRecovery(
      () => recover(db, { n: 903, ...unknown, kind: 'resume' }),
      'process_stop_unconfirmed',
    );
    const confirmed = recover(db, { n: 904, ...unknown, kind: 'resume', confirmed: true });
    assert.equal(confirmed.recovery.processCheck, 'operator_confirmed');
  });
});

test('Retry and Resume are refused while an Approve & Push publication holds the task', () => {
  withDatabase((db, sqlite) => {
    const { taskId, runId, workspaceId } = endedTask(db, 1, {
      status: 'completed',
      taskAction: 'complete_execution',
    });
    recordGitIntegrity(db, runId, { status: 'clean', resultJson: null, checkedAt: 34 });
    assert.ok(workspaceId);
    createPublication(db, {
      input: {
        id: uuid(800),
        requestId: uuid(801),
        taskId,
        runId,
        workspaceId,
        inventoryRevision: 'rev-1',
        snapshotHash: 'b'.repeat(64),
        snapshotJson: '{}',
        fileCount: 1,
        baseCommit: 'a'.repeat(40),
        branch: `agent/${taskId}`,
        remoteName: 'origin',
        remoteUrl: 'file:///remote.git',
        remoteUrlDigest: 'c'.repeat(64),
        commitMessage: 'Task',
      },
      now: 35,
    });
    // Discard from Review is refused while the publication is active.
    throwsRecovery(
      () => discardTask(db, { taskId, input: { runId, confirmed: true }, now: 36 }),
      'publication_in_progress',
    );
    // A state the lifecycle never produces, to prove the guard does not rely on it.
    sqlite.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(taskId);
    throwsRecovery(
      () => recover(db, { n: 900, taskId, kind: 'retry', runId, workspaceId }),
      'publication_in_progress',
    );
    assert.deepEqual(listTaskRecoveries(db, taskId), []);
  });
});

test('the claim binds the recovery, numbers the attempt and reuses the workspace', () => {
  withDatabase((db) => {
    const { taskId, runId, workspaceId } = endedTask(db, 1, stopped);
    const { recovery } = recover(db, { n: 900, taskId, kind: 'resume', runId, workspaceId });
    requestTaskExecution(db, { id: uuid(950), taskId, now: 41 });
    const result = claim(db, uuid(950), uuid(951), 42);
    assert.ok(result.claimed);
    assert.equal(result.claim.run.attempt, 2);
    assert.equal(result.claim.run.workspaceId, workspaceId);
    assert.equal(result.claim.continuation, null);
    assert.equal(result.claim.recovery?.sourceAttempt, 1);
    assert.equal(result.claim.recovery?.workspace?.id, workspaceId);
    assert.equal(result.claim.recovery?.recovery.followUpRunId, uuid(951));
    assert.equal(result.claim.recovery?.feedback, null);
    assert.equal(findTaskById(db, taskId)?.status, 'in_progress');
    assert.equal(findPendingRecovery(db, taskId), undefined);
    assert.equal(listTaskRecoveries(db, taskId)[0]?.id, recovery.id);
    // One workspace, both runs kept.
    assert.equal(listTaskWorkspaces(db, taskId).length, 1);
    assert.deepEqual(
      listTaskRuns(db, taskId).map((run) => [run.attempt, run.status]),
      [
        [2, 'starting'],
        [1, 'stopped'],
      ],
    );
  });
});

test('Retry after a failure before the worktree existed claims a first-attempt-like run', () => {
  withDatabase((db) => {
    const { taskId, runId } = endedTask(db, 1, failed, { workspace: false });
    const { recovery } = recover(db, { n: 900, taskId, kind: 'retry', runId, workspaceId: null });
    assert.equal(recovery.workspaceId, null);
    requestTaskExecution(db, { id: uuid(950), taskId, now: 41 });
    const result = claim(db, uuid(950), uuid(951), 42);
    assert.ok(result.claimed);
    assert.equal(result.claim.run.attempt, 2);
    assert.equal(result.claim.run.workspaceId, null);
    assert.equal(result.claim.recovery?.workspace, null);
  });
});

test('the claim re-checks the previous process and the workspace; a refusal keeps the task Queued', () => {
  withDatabase((db, sqlite) => {
    const { taskId, runId, workspaceId } = endedTask(db, 1, interrupted, { pid: 4242 });
    recover(db, { n: 900, taskId, kind: 'resume', runId, workspaceId });
    // The process group reappeared (or the ID was reused) between Resume and Start.
    requestTaskExecution(db, { id: uuid(950), taskId, now: 41 });
    const busy = claim(db, uuid(950), uuid(951), 42, alive);
    assert.equal(busy.claimed ? null : busy.code, 'continuation_unavailable');
    assert.match(busy.claimed ? '' : busy.message, /pid 4242/);
    // Without a probe the claim is refused as well (fail-closed).
    requestTaskExecution(db, { id: uuid(952), taskId, now: 43 });
    assert.equal(claim(db, uuid(952), uuid(953), 44, null).claimed, false);
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
    assert.equal(listTaskRuns(db, taskId).length, 1);
    assert.notEqual(findPendingRecovery(db, taskId), undefined);

    // A second workspace record appeared: the claim refuses instead of guessing.
    sqlite.pragma('foreign_keys = OFF');
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, task_id, generation, repository_root, git_common_dir, worktree_root, path, branch, base_branch, base_sha, status, created_at, updated_at) VALUES (?, ?, 2, '/repos/website', '/repos/website/.git', '/data/worktrees', '/data/other', 'agent/x', 'main', ?, 'retained', 1, 1)",
      )
      .run(uuid(960), taskId, 'a'.repeat(40));
    requestTaskExecution(db, { id: uuid(954), taskId, now: 45 });
    const doubled = claim(db, uuid(954), uuid(955), 46);
    assert.equal(doubled.claimed ? null : doubled.code, 'continuation_unavailable');
    assert.equal(findTaskById(db, taskId)?.status, 'queued');
  });
});

test('a failed follow-up attempt keeps its review feedback for the recovered attempt', () => {
  withDatabase((db) => {
    // Attempt 1 reaches Review; changes are requested; attempt 2 (the follow-up) fails.
    const { taskId, runId, workspaceId } = endedTask(db, 1, {
      status: 'completed',
      taskAction: 'complete_execution',
    });
    recordGitIntegrity(db, runId, { status: 'clean', resultJson: null, checkedAt: 34 });
    const { review } = requestTaskChanges(db, {
      id: uuid(700),
      taskId,
      input: { runId, revision: 'rev-1', feedback: 'Rename the file please.' },
      now: 35,
    });
    requestTaskExecution(db, { id: uuid(710), taskId, now: 36 });
    const followUp = claim(db, uuid(710), uuid(711), 37);
    assert.ok(followUp.claimed && followUp.claim.continuation !== null);
    finishTaskRun(db, uuid(711), { ...failed, endedAt: 38 });
    assert.equal(listTaskReviews(db, taskId)[0]?.followUpRunId, uuid(711));

    // Retry the failed follow-up: the feedback is carried, the review record is unchanged.
    const { recovery } = recover(db, {
      n: 900,
      taskId,
      kind: 'retry',
      runId: uuid(711),
      workspaceId,
    });
    assert.equal(recovery.reviewId, review.id);
    requestTaskExecution(db, { id: uuid(950), taskId, now: 41 });
    const result = claim(db, uuid(950), uuid(951), 42);
    assert.ok(result.claimed);
    assert.equal(result.claim.run.attempt, 3);
    assert.equal(result.claim.recovery?.sourceAttempt, 2);
    assert.equal(result.claim.recovery?.feedback?.review.feedback, 'Rename the file please.');
    assert.equal(result.claim.recovery?.feedback?.reviewedAttempt, 1);
    assert.deepEqual(listTaskReviews(db, taskId), [
      { ...review, followUpRunId: uuid(711), updatedAt: 37 },
    ]);
  });
});

test('Discard is a confirmed, logical transition that deletes nothing', () => {
  withDatabase((db) => {
    const { taskId, runId, workspaceId } = endedTask(db, 1, failed);
    const runsBefore = listTaskRuns(db, taskId);
    const workspacesBefore = listTaskWorkspaces(db, taskId);
    throwsRecovery(
      () =>
        discardTask(db, {
          taskId,
          // @ts-expect-error -- the confirmation must be literally true.
          input: { runId, confirmed: false },
          now: 40,
        }),
      'invalid_recovery_input',
    );
    throwsRecovery(
      () => discardTask(db, { taskId, input: { runId: uuid(999), confirmed: true }, now: 40 }),
      'task_run_changed',
    );
    assert.equal(findTaskById(db, taskId)?.status, 'failed');
    const task = discardTask(db, { taskId, input: { runId, confirmed: true }, now: 41 });
    assert.equal(task.status, 'discarded');
    assert.deepEqual(listTaskRuns(db, taskId), runsBefore);
    assert.deepEqual(listTaskWorkspaces(db, taskId), workspacesBefore);
    assert.equal(workspacesBefore[0]?.id, workspaceId);
    // Final: no Retry, Resume or second Discard.
    throwsRecovery(
      () => recover(db, { n: 900, taskId, kind: 'retry', runId, workspaceId }),
      'recovery_not_available',
    );
    throwsRecovery(
      () => discardTask(db, { taskId, input: { runId, confirmed: true }, now: 42 }),
      'discard_not_available',
    );
  });
});

test('Discard is available from Review, Stopped and Interrupted and never during a run', () => {
  withDatabase((db) => {
    for (const [n, ending] of [
      [1, stopped],
      [2, interrupted],
      [3, { status: 'completed', taskAction: 'complete_execution' }],
    ] as const) {
      const { taskId, runId } = endedTask(db, n, ending);
      assert.equal(
        discardTask(db, { taskId, input: { runId, confirmed: true }, now: 40 }).status,
        'discarded',
      );
    }
    const taskId = uuid(9);
    createTask(db, {
      id: taskId,
      input: { projectId: projectA, title: 'Running', prompt: 'Do it.', agentRuntime: 'claude' },
      now: 20,
    });
    transitionTask(db, { id: taskId, action: 'queue', now: 21 });
    requestTaskExecution(db, { id: uuid(91), taskId, now: 22 });
    assert.ok(claim(db, uuid(91), uuid(92), 23).claimed);
    throwsRecovery(
      () => discardTask(db, { taskId, input: { runId: uuid(92), confirmed: true }, now: 24 }),
      'discard_not_available',
    );
    assert.equal(findTaskById(db, taskId)?.status, 'in_progress');
  });
});
