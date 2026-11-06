import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { trustedLocalDisclosure } from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  applyMigrations,
  claimPublication,
  claimStartCommand,
  completePublicationCommit,
  completePublicationPush,
  createDatabase,
  createPublication,
  findLatestTaskCommand,
  findProjectById,
  findTaskById,
  finishTaskRun,
  listQueuedWorkspaceCleanups,
  listTaskRuns,
  recordGitIntegrity,
  recordPublicationCommitObject,
  recordRunWorkspace,
  requestTaskExecution,
  setProjectExecutionTrust,
  startPublicationPush,
} from '@ai-agent-manager/database';
import { createTaskWorktree } from '@ai-agent-manager/git';
import { POST as archiveRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/archive/route';
import { POST as discardRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/discard/route';
import { POST as queueRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/queue/route';
import { POST as restoreRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/restore/route';
import { POST as cleanupRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/workspace/cleanup/route';
import { GET as workspaceRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/workspace/route';
import { POST as createTaskRoute } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as registerRoute } from '@/app/api/projects/route';
import { apiErrorResponseSchema, projectResponseSchema } from '@/lib/projects/contracts';
import { closeDatabase, getDatabase } from '@/lib/server/database';
import { getProjectBoard } from '@/lib/server/tasks';
import { partitionArchivedTasks } from '@/lib/tasks/board';
import { taskResponseSchema } from '@/lib/tasks/contracts';
import {
  workspaceCleanupResponseSchema,
  workspacePanelResponseSchema,
} from '@/lib/tasks/workspace';
import {
  createFixtureDirectory,
  createRepository,
  git,
  removeFixtureDirectory,
  snapshot,
  writeFile,
} from './fixtures';

// TM-02 routes against disposable repositories and real task worktrees: Archive/Restore, the
// read-only workspace panel and the Remove local worktree request. The web process never removes
// anything; a confirmed request is only recorded for the worker. No agent runs; "published" tasks
// get their commit in the worktree and the push recorded in the database (the real push path is
// covered by the worker tests).

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
  if (previousDatabasePath === undefined) delete process.env[databaseVariable];
  else process.env[databaseVariable] = previousDatabasePath;
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

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${origin}${path}`, {
    headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'same-origin', ...headers },
  });

const taskParams = (projectId: string, taskId: string) => ({
  params: Promise.resolve({ projectId, taskId }),
});

const errorCode = async (response: Response): Promise<string> =>
  apiErrorResponseSchema.parse(await response.json()).error.code;

type Fixture = {
  projectId: string;
  taskId: string;
  runId: string;
  workspaceId: string;
  root: string;
  worktree: string;
};

let counter = 0;

/** A task whose first attempt reached Review in a real, clean task worktree. */
const reviewedTask = async (): Promise<Fixture> => {
  counter += 1;
  const name = `workspace repo ${counter}`;
  const root = createRepository(join(directory, name));
  const registered = await registerRoute(
    post('/api/projects', { path: root, name, defaultBaseBranch: 'main', remoteName: null }),
  );
  const { project } = projectResponseSchema.parse(await registered.json());
  const created = await createTaskRoute(
    post(`/api/projects/${project.id}/tasks`, {
      title: `Workspace task ${counter}`,
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
      workerInstanceId: 'workspace-test',
      timeoutMs: 60_000,
      now: 4,
      probeProcessGroup: () => false,
    }).claimed,
  );
  const worktree = await createTaskWorktree({
    repositoryPath: root,
    baseBranch: 'main',
    taskId: task.id,
    worktreeRoot,
  });
  const workspace = recordRunWorkspace(db, {
    runId,
    workspace: {
      id: randomUUID(),
      taskId: task.id,
      generation: 1,
      repositoryRoot: worktree.repository.root,
      gitCommonDir: worktree.repository.commonDir,
      worktreeRoot,
      path: worktree.path,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      baseSha: worktree.baseCommit,
      createdAt: 5,
    },
  });
  recordGitIntegrity(db, runId, { status: 'clean', resultJson: null, checkedAt: 6 });
  finishTaskRun(db, runId, { status: 'completed', taskAction: 'complete_execution', endedAt: 6 });
  return {
    projectId: project.id,
    taskId: task.id,
    runId,
    workspaceId: workspace.id,
    root,
    worktree: worktree.path,
  };
};

/** Commits the result in the worktree and records a confirmed push (→ Done). */
const publishedTask = async (): Promise<Fixture & { commit: string }> => {
  const fixture = await reviewedTask();
  writeFile(join(fixture.worktree, 'feature.txt'), 'implemented\n');
  git(fixture.worktree, 'add', 'feature.txt');
  git(fixture.worktree, 'commit', '--quiet', '-m', 'Task result');
  const commit = git(fixture.worktree, 'rev-parse', 'HEAD').trim();
  const db = getDatabase();
  const { publication } = createPublication(db, {
    input: {
      id: randomUUID(),
      requestId: randomUUID(),
      taskId: fixture.taskId,
      runId: fixture.runId,
      workspaceId: fixture.workspaceId,
      inventoryRevision: 'revision',
      snapshotHash: 'd'.repeat(64),
      snapshotJson: '{}',
      fileCount: 1,
      baseCommit: git(fixture.root, 'rev-parse', 'main').trim(),
      branch: `agent/${fixture.taskId}`,
      remoteName: 'origin',
      remoteUrl: '/remote.git',
      remoteUrlDigest: 'e'.repeat(64),
      commitMessage: 'Task result',
    },
    now: 10,
  });
  const id = publication.id;
  assert.ok(
    claimPublication(db, { id, operationId: randomUUID(), workerInstanceId: 'w', now: 11 }),
  );
  recordPublicationCommitObject(db, { id, commitSha: commit, treeSha: 'f'.repeat(40), now: 12 });
  completePublicationCommit(db, { id, now: 13 });
  startPublicationPush(db, { id, operationId: randomUUID(), now: 14 });
  completePublicationPush(db, { id, outcome: 'created', now: 15 });
  assert.equal(findTaskById(db, fixture.taskId)?.status, 'done');
  return { ...fixture, commit };
};

const panel = async (fixture: Fixture) => {
  const response = await workspaceRoute(
    get(`/api/projects/${fixture.projectId}/tasks/${fixture.taskId}/workspace`),
    taskParams(fixture.projectId, fixture.taskId),
  );
  assert.equal(response.status, 200);
  return workspacePanelResponseSchema.parse(await response.json()).workspace;
};

const requestCleanup = (
  fixture: Fixture,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  cleanupRoute(
    post(
      `/api/projects/${fixture.projectId}/tasks/${fixture.taskId}/workspace/cleanup`,
      body,
      headers,
    ),
    taskParams(fixture.projectId, fixture.taskId),
  );

const archive = (fixture: Fixture, action: 'archive' | 'restore', headers = {}) =>
  (action === 'archive' ? archiveRoute : restoreRoute)(
    post(
      `/api/projects/${fixture.projectId}/tasks/${fixture.taskId}/${action}`,
      undefined,
      headers,
    ),
    taskParams(fixture.projectId, fixture.taskId),
  );

test('archive hides a task from the default board, keeps it inspectable and restores it unchanged', async () => {
  const fixture = await publishedTask();
  const db = getDatabase();
  const before = findTaskById(db, fixture.taskId);
  const runs = listTaskRuns(db, fixture.taskId);
  const worktreeBefore = snapshot(fixture.worktree);

  const archived = await archive(fixture, 'archive');
  assert.equal(archived.status, 200);
  const { task } = taskResponseSchema.parse(await archived.json());
  assert.equal(task.status, 'done');
  assert.notEqual(task.archivedAt, null);

  const board = getProjectBoard(db, fixture.projectId);
  assert.ok(board);
  const views = partitionArchivedTasks(board.tasks);
  assert.deepEqual(
    views.active.map(({ id }) => id),
    [],
  );
  assert.deepEqual(
    views.archived.map(({ id }) => id),
    [fixture.taskId],
  );
  // Still inspectable, with its worktree and history untouched; no start request was created.
  assert.equal((await panel(fixture)).state, 'retained');
  assert.deepEqual(listTaskRuns(db, fixture.taskId), runs);
  assert.deepEqual(snapshot(fixture.worktree), worktreeBefore);
  assert.equal(findLatestTaskCommand(db, fixture.taskId)?.status, 'accepted');

  const restored = await archive(fixture, 'restore');
  assert.equal(restored.status, 200);
  assert.deepEqual(findTaskById(db, fixture.taskId), before);
});

test('archive is refused for a task in review and for cross-origin requests', async () => {
  const fixture = await reviewedTask();
  const refused = await archive(fixture, 'archive');
  assert.equal(refused.status, 409);
  assert.equal(await errorCode(refused), 'task_not_archivable');

  const done = await publishedTask();
  const crossOrigin = await archive(done, 'archive', { origin: 'https://evil.example' });
  assert.equal(crossOrigin.status, 403);
  assert.equal(findTaskById(getDatabase(), done.taskId)?.archivedAt, null);
});

test('an archived task refuses lifecycle actions until restored', async () => {
  const fixture = await reviewedTask();
  const discarded = await discardRoute(
    post(`/api/projects/${fixture.projectId}/tasks/${fixture.taskId}/discard`, {
      runId: fixture.runId,
      confirmed: true,
    }),
    taskParams(fixture.projectId, fixture.taskId),
  );
  assert.equal(discarded.status, 200);
  assert.equal((await archive(fixture, 'archive')).status, 200);
  // Discarded is final anyway; an archived Backlog task shows the archived refusal.
  const created = await createTaskRoute(
    post(`/api/projects/${fixture.projectId}/tasks`, {
      title: 'Backlog task',
      prompt: 'Later.',
      agentRuntime: 'claude',
    }),
    { params: Promise.resolve({ projectId: fixture.projectId }) },
  );
  const { task } = taskResponseSchema.parse(await created.json());
  const backlog = { ...fixture, taskId: task.id };
  assert.equal((await archive(backlog, 'archive')).status, 200);
  const queued = await queueRoute(
    post(`/api/projects/${fixture.projectId}/tasks/${task.id}/queue`),
    taskParams(fixture.projectId, task.id),
  );
  assert.equal(queued.status, 409);
  assert.equal(await errorCode(queued), 'task_archived');
  assert.equal(findTaskById(getDatabase(), task.id)?.status, 'backlog');
});

test('the workspace panel reports a retained worktree and cleanup availability read-only', async () => {
  const review = await reviewedTask();
  const reviewPanel = await panel(review);
  assert.equal(reviewPanel.state, 'retained');
  assert.equal(reviewPanel.workspace?.path, review.worktree);
  assert.equal(reviewPanel.git?.managedLock, true);
  assert.equal(reviewPanel.cleanup.available, false);
  assert.match(reviewPanel.cleanup.reasons.join('\n'), /Review/);

  const done = await publishedTask();
  const rootBefore = snapshot(done.root);
  const worktreeBefore = snapshot(done.worktree);
  const donePanel = await panel(done);
  assert.equal(donePanel.cleanup.available, true);
  assert.equal(donePanel.cleanup.expectedCommit, done.commit);
  assert.equal(donePanel.cleanup.basis, 'published');
  assert.deepEqual(snapshot(done.root), rootBefore);
  assert.deepEqual(snapshot(done.worktree), worktreeBefore);

  const crossOrigin = await workspaceRoute(
    get(`/api/projects/${done.projectId}/tasks/${done.taskId}/workspace`, {
      'sec-fetch-site': 'cross-site',
    }),
    taskParams(done.projectId, done.taskId),
  );
  assert.equal(crossOrigin.status, 403);
});

test('a confirmed cleanup request is recorded for the worker; nothing is removed by the web', async () => {
  const done = await publishedTask();
  const worktreeBefore = snapshot(done.worktree);
  const requestId = randomUUID();
  const body = {
    requestId,
    workspaceId: done.workspaceId,
    expectedCommit: done.commit,
    confirmed: true,
  };

  // Guards: confirmation, strict body (no path), same origin, current commit.
  assert.equal((await requestCleanup(done, { ...body, confirmed: false })).status, 400);
  assert.equal((await requestCleanup(done, { ...body, path: done.worktree })).status, 400);
  assert.equal((await requestCleanup(done, body, { origin: 'https://evil.example' })).status, 403);
  const stale = await requestCleanup(done, { ...body, expectedCommit: 'b'.repeat(40) });
  assert.equal(await errorCode(stale), 'cleanup_state_changed');
  assert.equal(listQueuedWorkspaceCleanups(getDatabase()).length, 0);

  const response = await requestCleanup(done, body);
  assert.equal(response.status, 200);
  const { cleanup } = workspaceCleanupResponseSchema.parse(await response.json());
  assert.equal(cleanup.status, 'requested');
  // A double submit returns the same request; a new one is refused while it is pending.
  const repeated = workspaceCleanupResponseSchema.parse(
    await (await requestCleanup(done, body)).json(),
  );
  assert.equal(repeated.cleanup.id, cleanup.id);
  const another = await requestCleanup(done, { ...body, requestId: randomUUID() });
  assert.equal(await errorCode(another), 'cleanup_already_requested');

  assert.ok(existsSync(done.worktree));
  assert.deepEqual(snapshot(done.worktree), worktreeBefore);
  const pending = await panel(done);
  assert.equal(pending.current?.status, 'requested');
  // Verified against the pending removal's commit, not the base commit.
  assert.equal(pending.git?.identityVerified, true);
  assert.equal(pending.cleanup.available, false);
});

test('cleanup is refused for a review task and for a worktree with untracked files', async () => {
  const review = await reviewedTask();
  const refused = await requestCleanup(review, {
    requestId: randomUUID(),
    workspaceId: review.workspaceId,
    expectedCommit: git(review.root, 'rev-parse', 'main').trim(),
    confirmed: true,
  });
  assert.equal(await errorCode(refused), 'cleanup_not_available');

  const done = await publishedTask();
  writeFile(join(done.worktree, 'scratch.txt'), 'untracked\n');
  const body = {
    requestId: randomUUID(),
    workspaceId: done.workspaceId,
    expectedCommit: done.commit,
    confirmed: true,
  };
  const dirty = await requestCleanup(done, body);
  assert.equal(await errorCode(dirty), 'worktree_not_removable');
  const dirtyPanel = await panel(done);
  assert.equal(dirtyPanel.cleanup.available, false);
  assert.match(dirtyPanel.cleanup.reasons.join('\n'), /untracked/);
  assert.ok(existsSync(join(done.worktree, 'scratch.txt')));
  assert.equal(listQueuedWorkspaceCleanups(getDatabase()).length, 1); // only the earlier test's
});
