import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { trustedLocalDisclosure } from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  applyMigrations,
  claimStartCommand,
  createDatabase,
  findLatestTaskCommand,
  findPendingRecovery,
  findProjectById,
  findTaskById,
  finishTaskRun,
  listTaskRecoveries,
  listTaskRuns,
  listTaskWorkspaces,
  recordRunWorkspace,
  requestTaskExecution,
  setProjectExecutionTrust,
  type RunFinish,
} from '@ai-agent-manager/database';
import { createTaskWorktree } from '@ai-agent-manager/git';
import { POST as discardRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/discard/route';
import { GET as executionRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/execution/route';
import { POST as queueRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/queue/route';
import { POST as resumeRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/resume/route';
import { POST as retryRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/retry/route';
import { POST as createTaskRoute } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as registerRoute } from '@/app/api/projects/route';
import { taskExecutionResponseSchema } from '@/lib/execution/contracts';
import { apiErrorResponseSchema, projectResponseSchema } from '@/lib/projects/contracts';
import { closeDatabase, getDatabase } from '@/lib/server/database';
import { getTaskRecoveryOptions } from '@/lib/server/recovery';
import { taskResponseSchema } from '@/lib/tasks/contracts';
import {
  createFixtureDirectory,
  createRepository,
  git,
  removeFixtureDirectory,
  snapshot,
  writeFile,
} from './fixtures';

// TM-01 Retry, Resume and Discard routes against disposable repositories and real task worktrees
// created by the production worktree manager. No agent runs and nothing is started: the "agent"
// changes are made by the test.

const origin = 'http://127.0.0.1:3000';
const databaseVariable = 'AI_AGENT_MANAGER_DATABASE_PATH';

let directory = '';
let worktreeRoot = '';
let previousDatabasePath: string | undefined;

before(() => {
  directory = createFixtureDirectory();
  worktreeRoot = join(directory, 'worktrees');
  previousDatabasePath = process.env[databaseVariable];
  process.env[databaseVariable] = join(directory, 'data', 'database.sqlite');
  const connection = createDatabase({ path: process.env[databaseVariable] });
  try {
    applyMigrations(connection);
  } finally {
    connection.close();
  }
  acceptTrustedLocal(getDatabase(), {
    input: {
      disclosureVersion: trustedLocalDisclosure.version,
      acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
    },
    now: 1,
  });
});

after(() => {
  closeDatabase();
  if (previousDatabasePath === undefined) {
    delete process.env[databaseVariable];
  } else {
    process.env[databaseVariable] = previousDatabasePath;
  }
  removeFixtureDirectory(directory);
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const taskParams = (projectId: string, taskId: string) => ({
  params: Promise.resolve({ projectId, taskId }),
});

/** Writes a run field the lifecycle never sets this way, through a separate connection. */
const updateRun = (statement: string, ...values: (string | number)[]): void => {
  const connection = createDatabase({ path: process.env[databaseVariable] ?? '' });
  try {
    connection.sqlite.prepare(statement).run(...values);
  } finally {
    connection.close();
  }
};

const errorCode = async (response: Response): Promise<string> =>
  apiErrorResponseSchema.parse(await response.json()).error.code;

type Ended = { projectId: string; taskId: string; runId: string; root: string; worktree: string };

let counter = 0;

/**
 * A task whose first attempt ended as `ending`, with a real task worktree holding a tracked and an
 * untracked change (unless `withWorktree` is false: the attempt ended before a worktree existed).
 */
const endedTask = async (
  ending: Pick<RunFinish, 'status' | 'taskAction' | 'errorCode'>,
  { withWorktree = true }: { withWorktree?: boolean } = {},
): Promise<Ended> => {
  counter += 1;
  const name = `recovery repo ${counter}`;
  const root = createRepository(join(directory, name));
  const registered = await registerRoute(
    post('/api/projects', { path: root, name, defaultBaseBranch: 'main', remoteName: null }),
  );
  const { project } = projectResponseSchema.parse(await registered.json());
  const created = await createTaskRoute(
    post(`/api/projects/${project.id}/tasks`, {
      title: `Recover me ${counter}`,
      prompt: 'Change things.',
      agentRuntime: 'codex',
    }),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  const { task } = taskResponseSchema.parse(await created.json());
  await queueRoute(
    post(`/api/projects/${project.id}/tasks/${task.id}/queue`),
    taskParams(project.id, task.id),
  );
  const db = getDatabase();
  const record = findProjectById(db, project.id);
  assert.ok(record);
  setProjectExecutionTrust(db, {
    projectId: project.id,
    trust: {
      trust: 'trusted_local',
      localPath: record.localPath,
      gitCommonDir: record.gitCommonDir,
    },
    now: 2,
  });
  const commandId = randomUUID();
  const runId = randomUUID();
  requestTaskExecution(db, { id: commandId, taskId: task.id, now: 3 });
  assert.ok(
    claimStartCommand(db, {
      commandId,
      runId,
      workerInstanceId: 'recovery-test',
      timeoutMs: 60_000,
      now: 4,
      probeProcessGroup: () => false,
    }).claimed,
  );
  let worktree = '';
  if (withWorktree) {
    const created = await createTaskWorktree({
      repositoryPath: root,
      baseBranch: 'main',
      taskId: task.id,
      worktreeRoot,
    });
    worktree = created.path;
    recordRunWorkspace(db, {
      runId,
      workspace: {
        id: randomUUID(),
        taskId: task.id,
        generation: 1,
        repositoryRoot: created.repository.root,
        gitCommonDir: created.repository.commonDir,
        worktreeRoot,
        path: created.path,
        branch: created.branch,
        baseBranch: created.baseBranch,
        baseSha: created.baseCommit,
        createdAt: 5,
      },
    });
    writeFile(join(worktree, 'README.md'), 'fixture\nedited\n');
    writeFile(join(worktree, 'untracked.txt'), 'new\n');
  }
  finishTaskRun(db, runId, { ...ending, endedAt: 6 });
  return { projectId: project.id, taskId: task.id, runId, root, worktree };
};

const failed = { status: 'failed', taskAction: 'fail', errorCode: 'non_zero_exit' } as const;
const stopped = { status: 'stopped', taskAction: 'stop', errorCode: null } as const;
const interrupted = {
  status: 'interrupted',
  taskAction: 'interrupt',
  errorCode: 'worker_restarted',
} as const;

const recoveryPath = (fixture: Ended, action: 'retry' | 'resume' | 'discard') =>
  `/api/projects/${fixture.projectId}/tasks/${fixture.taskId}/${action}`;

const routes = { retry: retryRoute, resume: resumeRoute, discard: discardRoute } as const;

const send = (
  fixture: Ended,
  action: 'retry' | 'resume' | 'discard',
  body: unknown,
  headers: Record<string, string> = {},
) =>
  routes[action](
    post(recoveryPath(fixture, action), body, headers),
    taskParams(fixture.projectId, fixture.taskId),
  );

test('Retry from Failed queues the task, starts nothing and leaves the worktree untouched', async () => {
  const fixture = await endedTask(failed);
  const db = getDatabase();
  const command = findLatestTaskCommand(db, fixture.taskId);
  const worktreeBefore = snapshot(fixture.worktree);
  const rootBefore = snapshot(fixture.root);
  assert.equal(
    getTaskRecoveryOptions(db, { id: fixture.taskId, status: 'failed' })?.recovery?.kind,
    'retry',
  );

  const response = await send(fixture, 'retry', { runId: fixture.runId });
  assert.equal(response.status, 200);
  const { task } = taskResponseSchema.parse(await response.json());
  assert.equal(task.status, 'queued');
  assert.deepEqual(findLatestTaskCommand(db, fixture.taskId), command, 'no start request');
  assert.equal(listTaskRuns(db, fixture.taskId).length, 1);
  assert.equal(findPendingRecovery(db, fixture.taskId)?.kind, 'retry');
  assert.deepEqual(snapshot(fixture.worktree), worktreeBefore);
  assert.deepEqual(snapshot(fixture.root), rootBefore);

  // The execution view shows the pending Retry.
  const view = await executionRoute(
    new Request(`${origin}${recoveryPath(fixture, 'retry').replace('/retry', '/execution')}`, {
      headers: { host: '127.0.0.1:3000' },
    }),
    taskParams(fixture.projectId, fixture.taskId),
  );
  const { execution } = taskExecutionResponseSchema.parse(await view.json());
  assert.equal(execution.recoveries[0]?.kind, 'retry');
  assert.equal(execution.recoveries[0]?.sourceAttempt, 1);
  assert.equal(execution.recoveries[0]?.workspaceRetained, true);
  assert.equal(execution.recoveries[0]?.followUpRunId, null);

  // A second submission (another tab) is refused; nothing else changes.
  const again = await send(fixture, 'retry', { runId: fixture.runId });
  assert.equal(again.status, 409);
  assert.equal(await errorCode(again), 'recovery_not_available');
  assert.equal(listTaskRecoveries(db, fixture.taskId).length, 1);
});

test('Retry without a worktree (failure before creation) is accepted', async () => {
  const fixture = await endedTask(failed, { withWorktree: false });
  const response = await send(fixture, 'retry', { runId: fixture.runId });
  assert.equal(response.status, 200);
  assert.equal(findPendingRecovery(getDatabase(), fixture.taskId)?.workspaceId, null);
});

const tamperings: ReadonlyArray<{ name: string; tamper: (fixture: Ended) => void }> = [
  {
    name: 'a commit on the task branch',
    tamper: ({ worktree }) => {
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '--quiet', '-m', 'Manual commit');
    },
  },
  {
    name: 'an unlocked worktree',
    tamper: ({ root, worktree }) => {
      git(root, 'worktree', 'unlock', worktree);
    },
  },
  {
    name: 'a moved worktree directory',
    tamper: ({ worktree }) => {
      renameSync(worktree, `${worktree}-moved`);
    },
  },
  {
    name: 'a switched branch',
    tamper: ({ worktree }) => {
      git(worktree, 'switch', '--quiet', '-c', 'tampered');
    },
  },
];

for (const { name, tamper } of tamperings) {
  test(`Retry is refused for ${name}, and nothing is reset or cleaned`, async () => {
    const fixture = await endedTask(failed);
    tamper(fixture);
    const location = existsSync(fixture.worktree) ? fixture.worktree : `${fixture.worktree}-moved`;
    const before = snapshot(location);
    const response = await send(fixture, 'retry', { runId: fixture.runId });
    assert.equal(response.status, 409);
    const body = apiErrorResponseSchema.parse(await response.json());
    assert.equal(body.error.code, 'workspace_unavailable');
    assert.match(body.error.message, /Nothing was queued, reset or cleaned/);
    assert.equal(findTaskById(getDatabase(), fixture.taskId)?.status, 'failed');
    assert.deepEqual(listTaskRecoveries(getDatabase(), fixture.taskId), []);
    assert.deepEqual(snapshot(location), before);
    assert.equal(readFileSync(join(location, 'untracked.txt'), 'utf8'), 'new\n');
  });
}

test('Resume from Stopped and Interrupted; Retry and Resume only where offered', async () => {
  const fromStopped = await endedTask(stopped);
  assert.equal(
    await errorCode(await send(fromStopped, 'retry', { runId: fromStopped.runId })),
    'recovery_not_available',
  );
  assert.equal((await send(fromStopped, 'resume', { runId: fromStopped.runId })).status, 200);

  const fromInterrupted = await endedTask(interrupted);
  assert.equal(
    await errorCode(await send(fromInterrupted, 'retry', { runId: fromInterrupted.runId })),
    'recovery_not_available',
  );
  const response = await send(fromInterrupted, 'resume', { runId: fromInterrupted.runId });
  assert.equal(response.status, 200);
  assert.equal(taskResponseSchema.parse(await response.json()).task.status, 'queued');

  const fromFailed = await endedTask(failed);
  assert.equal(
    await errorCode(await send(fromFailed, 'resume', { runId: fromFailed.runId })),
    'recovery_not_available',
  );
});

test('an interrupted attempt whose process cannot be ruled out needs an explicit confirmation', async () => {
  const fixture = await endedTask(interrupted);
  const db = getDatabase();
  // Authorized but no PID recorded before the worker restarted.
  updateRun("UPDATE task_runs SET authorization_id = 'auth-1' WHERE id = ?", fixture.runId);
  assert.equal(
    getTaskRecoveryOptions(db, { id: fixture.taskId, status: 'interrupted' })?.recovery
      ?.processConfirmationRequired,
    true,
  );
  const unconfirmed = await send(fixture, 'resume', { runId: fixture.runId });
  assert.equal(unconfirmed.status, 409);
  assert.equal(await errorCode(unconfirmed), 'process_stop_unconfirmed');
  const confirmed = await send(fixture, 'resume', {
    runId: fixture.runId,
    processStopConfirmed: true,
  });
  assert.equal(confirmed.status, 200);
  assert.equal(findPendingRecovery(db, fixture.taskId)?.processCheck, 'operator_confirmed');
});

test('a still-existing process group of the previous attempt refuses Resume', async () => {
  const fixture = await endedTask(stopped);
  const db = getDatabase();
  // A real, detached process group standing in for a lingering agent.
  const lingering = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  try {
    assert.ok(lingering.pid !== undefined);
    updateRun('UPDATE task_runs SET pid = ? WHERE id = ?', lingering.pid, fixture.runId);
    const options = getTaskRecoveryOptions(db, { id: fixture.taskId, status: 'stopped' });
    assert.equal(options?.recovery?.available, false);
    assert.match(options?.recovery?.unavailableReason ?? '', /still exists/);
    const response = await send(fixture, 'resume', { runId: fixture.runId });
    assert.equal(response.status, 409);
    assert.equal(await errorCode(response), 'process_may_be_running');
    assert.equal(findTaskById(db, fixture.taskId)?.status, 'stopped');
  } finally {
    lingering.kill('SIGKILL');
    await once(lingering, 'exit');
  }
  // Once the group is gone, Resume is accepted; still nothing is launched.
  const response = await send(fixture, 'resume', { runId: fixture.runId });
  assert.equal(response.status, 200);
  assert.equal(findPendingRecovery(db, fixture.taskId)?.processCheck, 'process_group_gone');
  assert.equal(listTaskRuns(db, fixture.taskId).length, 1);
});

test('stale requests and invalid bodies are refused', async () => {
  const fixture = await endedTask(failed);
  const stale = await send(fixture, 'retry', { runId: randomUUID() });
  assert.equal(stale.status, 409);
  assert.equal(await errorCode(stale), 'task_run_changed');
  const invalid = await send(fixture, 'retry', { runId: 'nope' });
  assert.equal(invalid.status, 400);
  const extra = await send(fixture, 'retry', { runId: fixture.runId, kind: 'resume' });
  assert.equal(extra.status, 400);
  assert.equal(findTaskById(getDatabase(), fixture.taskId)?.status, 'failed');
});

test('Discard requires confirmation, keeps every record, the worktree and the branch', async () => {
  const fixture = await endedTask(failed);
  const db = getDatabase();
  const runsBefore = listTaskRuns(db, fixture.taskId);
  const workspacesBefore = listTaskWorkspaces(db, fixture.taskId);
  const worktreeBefore = snapshot(fixture.worktree);
  const branches = git(fixture.root, 'branch', '--list');
  const worktrees = git(fixture.root, 'worktree', 'list', '--porcelain');

  const unconfirmed = await send(fixture, 'discard', { runId: fixture.runId });
  assert.equal(unconfirmed.status, 400);
  const notTrue = await send(fixture, 'discard', { runId: fixture.runId, confirmed: false });
  assert.equal(notTrue.status, 400);
  const stale = await send(fixture, 'discard', { runId: randomUUID(), confirmed: true });
  assert.equal(await errorCode(stale), 'task_run_changed');
  assert.equal(findTaskById(db, fixture.taskId)?.status, 'failed');

  const response = await send(fixture, 'discard', { runId: fixture.runId, confirmed: true });
  assert.equal(response.status, 200);
  assert.equal(taskResponseSchema.parse(await response.json()).task.status, 'discarded');
  assert.deepEqual(listTaskRuns(db, fixture.taskId), runsBefore);
  assert.deepEqual(listTaskWorkspaces(db, fixture.taskId), workspacesBefore);
  assert.deepEqual(snapshot(fixture.worktree), worktreeBefore);
  assert.equal(git(fixture.root, 'branch', '--list'), branches);
  assert.equal(git(fixture.root, 'worktree', 'list', '--porcelain'), worktrees);
  assert.equal(git(fixture.worktree, 'status', '--porcelain').includes('untracked.txt'), true);

  // Final: neither Retry nor a second Discard.
  assert.equal(
    await errorCode(await send(fixture, 'retry', { runId: fixture.runId })),
    'recovery_not_available',
  );
  assert.equal(
    await errorCode(await send(fixture, 'discard', { runId: fixture.runId, confirmed: true })),
    'discard_not_available',
  );
  assert.equal(getTaskRecoveryOptions(db, { id: fixture.taskId, status: 'discarded' }), null);
});

test('routes are project-scoped and guarded by Host, Origin and JSON checks', async () => {
  const fixture = await endedTask(failed);
  const other = await endedTask(failed);
  // A task of another project is missing.
  const crossProject = await retryRoute(
    post(recoveryPath(fixture, 'retry'), { runId: fixture.runId }),
    taskParams(other.projectId, fixture.taskId),
  );
  assert.equal(crossProject.status, 404);
  assert.equal(await errorCode(crossProject), 'task_not_found');

  for (const action of ['retry', 'resume', 'discard'] as const) {
    const foreign = await send(
      fixture,
      action,
      { runId: fixture.runId, confirmed: true },
      {
        origin: 'http://evil.example',
      },
    );
    assert.equal(foreign.status, 403);
    const badHost = await send(
      fixture,
      action,
      { runId: fixture.runId, confirmed: true },
      {
        host: 'evil.example',
      },
    );
    assert.equal(badHost.status, 403);
    const text = await routes[action](
      new Request(`${origin}${recoveryPath(fixture, action)}`, {
        method: 'POST',
        headers: { host: '127.0.0.1:3000', origin, 'content-type': 'text/plain' },
        body: JSON.stringify({ runId: fixture.runId, confirmed: true }),
      }),
      taskParams(fixture.projectId, fixture.taskId),
    );
    assert.equal(text.status, 415);
  }
  assert.equal(findTaskById(getDatabase(), fixture.taskId)?.status, 'failed');
  assert.deepEqual(listTaskRecoveries(getDatabase(), fixture.taskId), []);
});
