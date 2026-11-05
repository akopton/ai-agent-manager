import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ExecutionError,
  trustedLocalDisclosure,
  type CreateTaskInput,
  type ExecutionErrorCode,
} from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  acquireWorkerLease,
  appendRunEvent,
  applyMigrations,
  claimStartCommand,
  createDatabase,
  createTask,
  disableTrustedLocal,
  expirePendingCommands,
  findLatestTaskCommand,
  findTaskById,
  findTaskRun,
  finishTaskRun,
  getTrustedLocalConsent,
  insertProject,
  listRunEvents,
  listTaskRuns,
  releaseWorkerLease,
  renewWorkerLease,
  requestRunStop,
  requestTaskExecution,
  runEventLimits,
  setProjectExecutionTrust,
  transitionTask,
  type DatabaseConnection,
} from '../src/index.js';

const projectA = '00000000-0000-4000-8000-00000000000a';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const withDatabase = (run: (connection: DatabaseConnection, path: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-execution-'));
  const path = join(directory, 'database.sqlite');
  const connection = createDatabase({ path });
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
    run(connection, path);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

const accept = (db: DatabaseConnection['db'], now = 10) =>
  acceptTrustedLocal(db, {
    input: {
      disclosureVersion: trustedLocalDisclosure.version,
      acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
    },
    now,
  });

const trust = (db: DatabaseConnection['db'], now = 11) =>
  setProjectExecutionTrust(db, {
    projectId: projectA,
    trust: {
      trust: 'trusted_local',
      localPath: '/repos/website',
      gitCommonDir: '/repos/website/.git',
    },
    now,
  });

const queuedTask = (
  db: DatabaseConnection['db'],
  n: number,
  overrides: Partial<CreateTaskInput> = {},
): string => {
  const id = uuid(n);
  createTask(db, {
    id,
    input: {
      projectId: projectA,
      title: `Task ${n}`,
      prompt: 'Do it.',
      agentRuntime: 'codex',
      ...overrides,
    },
    now: 20,
  });
  transitionTask(db, { id, action: 'queue', now: 21 });
  return id;
};

const throwsExecutionError = (run: () => unknown, code: ExecutionErrorCode): void => {
  assert.throws(run, (error: unknown) => error instanceof ExecutionError && error.code === code);
};

const claim = (db: DatabaseConnection['db'], commandId: string, runId: string, now = 30) =>
  claimStartCommand(db, { commandId, runId, workerInstanceId: 'worker-1', timeoutMs: 60_000, now });

test('Trusted Local consent is off by default and needs the full current disclosure', () => {
  withDatabase(({ db }) => {
    assert.deepEqual(getTrustedLocalConsent(db), {
      enabled: false,
      disclosureVersion: null,
      acceptedAt: null,
      acceptedRisks: [],
    });
    throwsExecutionError(
      () =>
        acceptTrustedLocal(db, {
          input: {
            disclosureVersion: 'old-1',
            acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
          },
          now: 1,
        }),
      'trusted_local_acceptance_stale',
    );
    throwsExecutionError(
      () =>
        acceptTrustedLocal(db, {
          input: {
            disclosureVersion: trustedLocalDisclosure.version,
            acceptedRisks: ['network_denied'],
          },
          now: 1,
        }),
      'invalid_execution_input',
    );
    assert.equal(getTrustedLocalConsent(db).enabled, false);
    assert.equal(accept(db).enabled, true);
    assert.equal(disableTrustedLocal(db, { now: 12 }).enabled, false);
    assert.equal(getTrustedLocalConsent(db).acceptedAt, null, 'disabling clears the acceptance');
  });
});

test('start requests need persisted consent and project trust; a smoke test or a task never grants it', () => {
  withDatabase(({ db }) => {
    const task = queuedTask(db, 1);
    throwsExecutionError(
      () => requestTaskExecution(db, { id: uuid(100), taskId: task, now: 25 }),
      'trusted_local_not_enabled',
    );
    accept(db);
    throwsExecutionError(
      () => requestTaskExecution(db, { id: uuid(100), taskId: task, now: 25 }),
      'project_not_trusted',
    );
    throwsExecutionError(
      () =>
        setProjectExecutionTrust(db, {
          projectId: projectA,
          trust: {
            trust: 'trusted_local',
            localPath: '/repos/website',
            gitCommonDir: '/other/.git',
          },
          now: 11,
        }),
      'repository_changed',
    );
    trust(db);
    const command = requestTaskExecution(db, { id: uuid(100), taskId: task, now: 25 });
    assert.equal(command.status, 'pending');
    throwsExecutionError(
      () => requestTaskExecution(db, { id: uuid(101), taskId: task, now: 26 }),
      'execution_already_requested',
    );
    const backlog = uuid(2);
    createTask(db, {
      id: backlog,
      input: { projectId: projectA, title: 'B', prompt: 'P', agentRuntime: 'codex' },
      now: 1,
    });
    throwsExecutionError(
      () => requestTaskExecution(db, { id: uuid(102), taskId: backlog, now: 26 }),
      'task_not_queued',
    );
  });
});

test('a claim creates attempt 1, starts the task and accepts the command atomically, once', () => {
  withDatabase(({ db }) => {
    accept(db);
    trust(db);
    const task = queuedTask(db, 1);
    requestTaskExecution(db, { id: uuid(100), taskId: task, now: 25 });
    const result = claim(db, uuid(100), uuid(200));
    assert.equal(result.claimed, true);
    assert.ok(result.claimed);
    assert.equal(result.claim.run.attempt, 1);
    assert.equal(result.claim.run.status, 'starting');
    assert.equal(result.claim.run.securityMode, 'trusted_local');
    assert.equal(result.claim.run.disclosureVersion, trustedLocalDisclosure.version);
    assert.equal(findTaskById(db, task)?.status, 'in_progress');
    assert.equal(findLatestTaskCommand(db, task)?.status, 'accepted');
    assert.equal(findLatestTaskCommand(db, task)?.runId, uuid(200));
    // A second claim of the same command does nothing.
    const again = claim(db, uuid(100), uuid(201));
    assert.equal(again.claimed, false);
    assert.equal(listTaskRuns(db, task).length, 1);
  });
});

test('consent revoked after the request rejects the claim and leaves the task Queued', () => {
  withDatabase(({ db }) => {
    accept(db);
    trust(db);
    const task = queuedTask(db, 1);
    requestTaskExecution(db, { id: uuid(100), taskId: task, now: 25 });
    disableTrustedLocal(db, { now: 26 });
    const result = claim(db, uuid(100), uuid(200));
    assert.deepEqual(result.claimed ? 'claimed' : result.code, 'trusted_local_not_enabled');
    assert.equal(findTaskById(db, task)?.status, 'queued');
    assert.equal(findLatestTaskCommand(db, task)?.status, 'rejected');
    assert.equal(listTaskRuns(db, task).length, 0);
  });
});

test('one active run per runtime: a second Codex claim is refused while Claude may run', () => {
  withDatabase(({ db, sqlite }) => {
    accept(db);
    trust(db);
    const first = queuedTask(db, 1);
    const second = queuedTask(db, 2);
    const claude = queuedTask(db, 3, { agentRuntime: 'claude' });
    for (const [n, task] of [first, second, claude].entries()) {
      requestTaskExecution(db, { id: uuid(100 + n), taskId: task, now: 25 });
    }
    assert.equal(claim(db, uuid(100), uuid(200)).claimed, true);
    const busy = claim(db, uuid(101), uuid(201));
    assert.equal(busy.claimed ? 'claimed' : busy.code, 'runtime_busy');
    assert.equal(findTaskById(db, second)?.status, 'queued');
    assert.equal(claim(db, uuid(102), uuid(202)).claimed, true);

    // The partial unique index enforces the slot even for a write that skips the claim checks.
    assert.throws(() =>
      sqlite
        .prepare(
          "INSERT INTO task_runs (id, task_id, attempt, agent_runtime, status, security_mode, timeout_ms, worker_instance_id, created_at, updated_at) VALUES (?, ?, 1, 'codex', 'running', 'trusted_local', 1, 'w', 1, 1)",
        )
        .run(uuid(299), second),
    );

    // After the first run ends, the slot is free again.
    finishTaskRun(db, uuid(200), { status: 'failed', taskAction: 'fail', endedAt: 40 });
    requestTaskExecution(db, { id: uuid(110), taskId: second, now: 41 });
    assert.equal(claim(db, uuid(110), uuid(210), 42).claimed, true);
  });
});

test('a failed claim transaction rolls back the run, the task and the command', () => {
  withDatabase(({ db }) => {
    accept(db);
    trust(db);
    const task = queuedTask(db, 1);
    requestTaskExecution(db, { id: uuid(100), taskId: task, now: 25 });
    // A run ID that already exists makes the insert fail inside the claim transaction.
    const other = queuedTask(db, 2, { agentRuntime: 'claude' });
    requestTaskExecution(db, { id: uuid(101), taskId: other, now: 25 });
    assert.equal(claim(db, uuid(101), uuid(200)).claimed, true);
    assert.throws(() => claim(db, uuid(100), uuid(200)));
    assert.equal(findTaskById(db, task)?.status, 'queued');
    assert.equal(findLatestTaskCommand(db, task)?.status, 'pending');
    assert.equal(listTaskRuns(db, task).length, 0);
  });
});

test('finishing a run applies the named task transition once; stop intent is durable', () => {
  withDatabase(({ db }, path) => {
    accept(db);
    trust(db);
    const task = queuedTask(db, 1);
    requestTaskExecution(db, { id: uuid(100), taskId: task, now: 25 });
    claim(db, uuid(100), uuid(200));
    assert.equal(requestRunStop(db, { taskId: task, now: 31 }).stopRequestedAt, 31);
    assert.equal(requestRunStop(db, { taskId: task, now: 32 }).stopRequestedAt, 31);

    const reopened = createDatabase({ path });
    try {
      assert.equal(findTaskRun(reopened.db, uuid(200))?.stopRequestedAt, 31);
    } finally {
      reopened.close();
    }

    const finished = finishTaskRun(db, uuid(200), {
      status: 'stopped',
      taskAction: 'stop',
      endedAt: 33,
    });
    assert.equal(finished?.task.status, 'stopped');
    assert.equal(
      finishTaskRun(db, uuid(200), {
        status: 'completed',
        taskAction: 'complete_execution',
        endedAt: 34,
      }),
      undefined,
    );
    assert.equal(findTaskRun(db, uuid(200))?.status, 'stopped');
    throwsExecutionError(() => requestRunStop(db, { taskId: task, now: 35 }), 'run_not_active');
  });
});

test('run events are bounded per run and per payload', () => {
  withDatabase(({ db }) => {
    accept(db);
    trust(db);
    const task = queuedTask(db, 1);
    requestTaskExecution(db, { id: uuid(100), taskId: task, now: 25 });
    claim(db, uuid(100), uuid(200));
    assert.equal(
      appendRunEvent(db, {
        runId: uuid(200),
        sequence: 1,
        kind: 'message',
        payload: { text: 'x'.repeat(runEventLimits.maxPayloadBytes + 1) },
        createdAt: 1,
      }),
      true,
    );
    assert.equal(listRunEvents(db, uuid(200))[0]?.payloadJson, '{"omitted":"payload_too_large"}');
    assert.equal(
      appendRunEvent(db, {
        runId: uuid(200),
        sequence: runEventLimits.maxEvents + 1,
        kind: 'message',
        payload: {},
        createdAt: 1,
      }),
      false,
    );
    assert.equal(findTaskRun(db, uuid(200))?.eventsDropped, 1);
  });
});

test('pending start requests expire instead of running after a long worker outage', () => {
  withDatabase(({ db }) => {
    accept(db);
    trust(db);
    const task = queuedTask(db, 1);
    requestTaskExecution(db, { id: uuid(100), taskId: task, now: 25 });
    assert.equal(expirePendingCommands(db, { olderThan: 26, now: 1_000 }), 1);
    assert.equal(findLatestTaskCommand(db, task)?.resultCode, 'command_expired');
    assert.equal(findTaskById(db, task)?.status, 'queued');
  });
});

test('the worker lease admits one live owner and can be taken over only after expiry', () => {
  withDatabase(({ db }) => {
    assert.equal(
      acquireWorkerLease(db, { ownerId: 'a', pid: 1, now: 0, ttlMs: 100 }).acquired,
      true,
    );
    assert.equal(
      acquireWorkerLease(db, { ownerId: 'b', pid: 2, now: 50, ttlMs: 100 }).acquired,
      false,
    );
    assert.equal(renewWorkerLease(db, { ownerId: 'a', now: 90, ttlMs: 100 }), true);
    assert.equal(
      acquireWorkerLease(db, { ownerId: 'b', pid: 2, now: 150, ttlMs: 100 }).acquired,
      false,
    );
    assert.equal(
      acquireWorkerLease(db, { ownerId: 'b', pid: 2, now: 191, ttlMs: 100 }).acquired,
      true,
    );
    assert.equal(renewWorkerLease(db, { ownerId: 'a', now: 192, ttlMs: 100 }), false);
    releaseWorkerLease(db, 'a');
    assert.equal(
      acquireWorkerLease(db, { ownerId: 'c', pid: 3, now: 193, ttlMs: 100 }).acquired,
      false,
    );
    releaseWorkerLease(db, 'b');
    assert.equal(
      acquireWorkerLease(db, { ownerId: 'c', pid: 3, now: 194, ttlMs: 100 }).acquired,
      true,
    );
  });
});
