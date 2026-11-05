import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { trustedLocalDisclosure, type GitIntegrityResultStatus } from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  applyMigrations,
  claimStartCommand,
  createDatabase,
  findProjectById,
  findTaskById,
  findTaskRun,
  finishTaskRun,
  recordGitIntegrity,
  recordRunWorkspace,
  requestTaskExecution,
  setProjectExecutionTrust,
} from '@ai-agent-manager/database';
import { createTaskWorktree } from '@ai-agent-manager/git';
import { GET as diffRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/review/diff/route';
import { GET as reviewRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/review/route';
import { POST as queueRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/queue/route';
import { POST as createTaskRoute } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as registerRoute } from '@/app/api/projects/route';
import { apiErrorResponseSchema, projectResponseSchema } from '@/lib/projects/contracts';
import {
  fileDiffResponseSchema,
  taskReviewResponseSchema,
  type TaskReviewView,
} from '@/lib/review/contracts';
import { closeDatabase, getDatabase } from '@/lib/server/database';
import { taskResponseSchema } from '@/lib/tasks/contracts';
import {
  createFixtureDirectory,
  createRepository,
  git,
  removeFixtureDirectory,
  snapshot,
  writeFile,
} from './fixtures';

// Review Changes against disposable repositories and real task worktrees created by the
// production worktree manager. No agent runs: the "agent" changes are made by the test.

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

const post = (path: string, body?: unknown): Request =>
  new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${origin}${path}`, { headers: { host: '127.0.0.1:3000', ...headers } });

const taskParams = (projectId: string, taskId: string) => ({
  params: Promise.resolve({ projectId, taskId }),
});

const errorCode = async (response: Response): Promise<string> =>
  apiErrorResponseSchema.parse(await response.json()).error.code;

type Fixture = {
  projectId: string;
  taskId: string;
  runId: string;
  root: string;
  worktree: string;
};

const registerProject = async (name: string, seed?: (root: string) => void) => {
  const root = createRepository(join(directory, name));
  if (seed !== undefined) {
    seed(root);
    git(root, 'add', '--all');
    git(root, 'commit', '--quiet', '-m', 'Seed');
  }
  const registered = await registerRoute(
    post('/api/projects', { path: root, name, defaultBaseBranch: 'main', remoteName: null }),
  );
  assert.equal(registered.status, 201);
  const { project } = projectResponseSchema.parse(await registered.json());
  return { projectId: project.id, root };
};

const createQueuedTask = async (projectId: string, title = 'Agent task'): Promise<string> => {
  const created = await createTaskRoute(
    post(`/api/projects/${projectId}/tasks`, {
      title,
      prompt: 'Change things.',
      agentRuntime: 'codex',
    }),
    { params: Promise.resolve({ projectId }) },
  );
  const { task } = taskResponseSchema.parse(await created.json());
  await queueRoute(
    post(`/api/projects/${projectId}/tasks/${task.id}/queue`),
    taskParams(projectId, task.id),
  );
  return task.id;
};

/** Claims a run and creates its worktree the way the worker does; leaves the run active. */
const startRun = async (projectId: string, root: string, taskId: string) => {
  const db = getDatabase();
  const project = findProjectById(db, projectId);
  assert.ok(project);
  setProjectExecutionTrust(db, {
    projectId,
    trust: {
      trust: 'trusted_local',
      localPath: project.localPath,
      gitCommonDir: project.gitCommonDir,
    },
    now: 2,
  });
  const commandId = randomUUID();
  const runId = randomUUID();
  requestTaskExecution(db, { id: commandId, taskId, now: 3 });
  const claim = claimStartCommand(db, {
    commandId,
    runId,
    workerInstanceId: 'review-test',
    timeoutMs: 60_000,
    now: 4,
  });
  assert.equal(claim.claimed, true);
  const worktree = await createTaskWorktree({
    repositoryPath: root,
    baseBranch: 'main',
    taskId,
    worktreeRoot,
  });
  recordRunWorkspace(db, {
    runId,
    workspace: {
      id: randomUUID(),
      taskId,
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
  return { runId, worktree: worktree.path };
};

const finishRun = (runId: string, integrity: GitIntegrityResultStatus = 'clean'): void => {
  const db = getDatabase();
  recordGitIntegrity(db, runId, {
    status: integrity,
    resultJson:
      integrity === 'clean'
        ? JSON.stringify({ findings: [], totalFindings: 0 })
        : JSON.stringify({
            findings: [
              { code: 'branch_ref_changed', disposition: 'violation', subject: 'refs/heads/x' },
            ],
            totalFindings: 1,
          }),
    checkedAt: 6,
  });
  const finished = finishTaskRun(db, runId, {
    status: 'completed',
    taskAction: integrity === 'clean' ? 'complete_execution' : 'fail',
    exitCode: 0,
    errorCode: integrity === 'clean' ? null : `git_integrity_${integrity}`,
    summary: 'Done. I changed some files.',
    endedAt: 7,
  });
  assert.ok(finished);
};

const setUpRun = async (
  name: string,
  {
    seed,
    change,
    integrity = 'clean',
  }: {
    seed?: (root: string) => void;
    change?: (worktree: string) => void;
    integrity?: GitIntegrityResultStatus;
  } = {},
): Promise<Fixture> => {
  const { projectId, root } = await registerProject(name, seed);
  const taskId = await createQueuedTask(projectId);
  const { runId, worktree } = await startRun(projectId, root, taskId);
  change?.(worktree);
  finishRun(runId, integrity);
  return { projectId, taskId, runId, root, worktree };
};

const fetchReview = async (projectId: string, taskId: string): Promise<TaskReviewView> => {
  const response = await reviewRoute(
    get(`/api/projects/${projectId}/tasks/${taskId}/review`),
    taskParams(projectId, taskId),
  );
  assert.equal(response.status, 200);
  return taskReviewResponseSchema.parse(await response.json()).review;
};

const requestDiff = (
  { projectId, taskId }: { projectId: string; taskId: string },
  path: string | null,
  headers: Record<string, string> = {},
): Promise<Response> => {
  const query = path === null ? '' : `?${new URLSearchParams({ path })}`;
  return diffRoute(
    get(`/api/projects/${projectId}/tasks/${taskId}/review/diff${query}`, headers),
    taskParams(projectId, taskId),
  );
};

const fetchDiff = async (fixture: Fixture, path: string) => {
  const response = await requestDiff(fixture, path);
  assert.equal(response.status, 200, `diff of ${path}`);
  return fileDiffResponseSchema.parse(await response.json()).diff;
};

const seedFiles = (root: string): void => {
  writeFile(join(root, 'src', 'app.ts'), 'export const answer = 41;\n');
  writeFile(join(root, 'docs', 'old-name.md'), '# Notes\n\nSome notes that stay the same.\n');
  writeFile(join(root, 'remove-me.txt'), 'obsolete\n');
  writeFile(join(root, 'unchanged.txt'), 'unchanged\n');
  writeFile(join(root, '.gitignore'), 'build/\n');
};

const agentChanges = (worktree: string): void => {
  writeFile(join(worktree, 'README.md'), 'fixture\nchanged by agent\n');
  writeFile(join(worktree, 'src', 'app.ts'), 'export const answer = 42;\n');
  rmSync(join(worktree, 'remove-me.txt'));
  git(worktree, 'mv', 'docs/old-name.md', 'docs/new-name.md');
  writeFile(join(worktree, 'staged.ts'), 'export const staged = true;\n');
  git(worktree, 'add', 'staged.ts');
  writeFile(join(worktree, 'hello.txt'), 'Hello from the agent\n');
  writeFileSync(join(worktree, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff, 0x00]));
  writeFile(join(worktree, 'big.txt'), 'a\n'.repeat(800 * 1024));
  writeFileSync(join(worktree, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  writeFile(join(worktree, 'build', 'output.js'), 'ignored\n');
};

test('lists added, modified, deleted, renamed, staged and untracked files with readable diffs', async () => {
  const fixture = await setUpRun('changes repo', { seed: seedFiles, change: agentChanges });
  const review = await fetchReview(fixture.projectId, fixture.taskId);

  assert.equal(review.task.status, 'review');
  assert.equal(review.run?.status, 'completed');
  assert.equal(review.run?.gitIntegrity.status, 'clean');
  assert.deepEqual(review.eligibility, { eligible: true, reasons: [] });
  assert.equal(review.workspace?.branch, `agent/${fixture.taskId}`);
  assert.equal(review.changes.state, 'available');
  if (review.changes.state !== 'available') return;
  assert.equal(review.changes.consistency, 'stable');
  assert.equal(review.changes.ignoredCount, 1);

  const byPath = new Map(review.changes.files.map((file) => [file.path, file]));
  assert.deepEqual(
    [...byPath.keys()].sort(),
    [
      'README.md',
      'big.txt',
      'docs/new-name.md',
      'hello.txt',
      'image.bin',
      'latin1.txt',
      'remove-me.txt',
      'src/app.ts',
      'staged.ts',
    ].sort(),
  );
  assert.equal(byPath.get('README.md')?.change, 'modified');
  assert.equal(byPath.get('remove-me.txt')?.change, 'deleted');
  assert.equal(byPath.get('docs/new-name.md')?.change, 'renamed');
  assert.equal(byPath.get('docs/new-name.md')?.previousPath, 'docs/old-name.md');
  assert.equal(byPath.get('staged.ts')?.change, 'added');
  assert.equal(byPath.get('staged.ts')?.tracked, true);
  assert.equal(byPath.get('hello.txt')?.change, 'added');
  assert.equal(byPath.get('hello.txt')?.tracked, false);
  assert.equal(byPath.get('image.bin')?.diffOmitted, 'binary');
  assert.equal(byPath.get('big.txt')?.diffOmitted, 'too_large');
  assert.equal(byPath.get('latin1.txt')?.diffOmitted, 'unsupported_encoding');
  assert.equal(byPath.has('build/output.js'), false, 'ignored files are not listed');
  assert.equal(byPath.has('unchanged.txt'), false);

  const readme = await fetchDiff(fixture, 'README.md');
  assert.match(readme.patch ?? '', /^\+changed by agent$/m);
  const hello = await fetchDiff(fixture, 'hello.txt');
  assert.match(hello.patch ?? '', /new file mode/);
  assert.match(hello.patch ?? '', /^\+Hello from the agent$/m);
  const removed = await fetchDiff(fixture, 'remove-me.txt');
  assert.match(removed.patch ?? '', /deleted file mode/);
  assert.match(removed.patch ?? '', /^-obsolete$/m);
  const renamed = await fetchDiff(fixture, 'docs/old-name.md');
  assert.equal(renamed.file.path, 'docs/new-name.md');
  assert.match(renamed.patch ?? '', /rename from docs\/old-name\.md/);
  const staged = await fetchDiff(fixture, 'staged.ts');
  assert.match(staged.patch ?? '', /^\+export const staged = true;$/m);
});

test('binary, oversized and undecodable files are identified and never rendered', async () => {
  const fixture = await setUpRun('omissions repo', {
    change: (worktree) => {
      writeFileSync(join(worktree, 'image.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
      writeFile(join(worktree, 'big.txt'), 'b\n'.repeat(700 * 1024));
      writeFileSync(join(worktree, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
      // A tracked file grown beyond the limit is omitted as well.
      writeFile(join(worktree, 'README.md'), 'c\n'.repeat(700 * 1024));
    },
  });
  for (const [path, omitted] of [
    ['image.bin', 'binary'],
    ['big.txt', 'too_large'],
    ['latin1.txt', 'unsupported_encoding'],
    ['README.md', 'too_large'],
  ] as const) {
    const diff = await fetchDiff(fixture, path);
    assert.equal(diff.patch, null, path);
    assert.equal(diff.omitted, omitted, path);
  }
});

test('an unreadable file yields a safe error, never file content or a crash', async () => {
  const fixture = await setUpRun('unreadable repo', {
    change: (worktree) => {
      writeFile(join(worktree, 'secret.txt'), 'top secret\n');
      chmodSync(join(worktree, 'secret.txt'), 0o000);
    },
  });
  try {
    // The inventory fails closed for the whole worktree: no partial list, no content.
    const review = await fetchReview(fixture.projectId, fixture.taskId);
    assert.deepEqual(review.changes, {
      state: 'unavailable',
      code: 'workspace_inaccessible',
      message: 'The task worktree exists but could not be read (permission denied).',
    });
    assert.equal(review.eligibility.eligible, false);
    const response = await requestDiff(fixture, 'secret.txt');
    assert.equal(response.status, 409);
    const text = await response.text();
    assert.doesNotMatch(text, /top secret/);
    assert.match(text, /workspace_inaccessible/);
  } finally {
    chmodSync(join(fixture.worktree, 'secret.txt'), 0o600);
  }
});

test('an agent that changed nothing gets an empty change list', async () => {
  const fixture = await setUpRun('no changes repo');
  const review = await fetchReview(fixture.projectId, fixture.taskId);
  assert.equal(review.changes.state, 'available');
  if (review.changes.state !== 'available') return;
  assert.deepEqual(review.changes.files, []);
  assert.equal(review.changes.totalFiles, 0);
  assert.equal(review.eligibility.eligible, true);
});

test('paths outside the change inventory are refused without reading them', async () => {
  const fixture = await setUpRun('paths repo', {
    seed: seedFiles,
    change: (worktree) => writeFile(join(worktree, 'hello.txt'), 'hi\n'),
  });
  for (const path of [
    '../../../../etc/passwd',
    '/etc/passwd',
    'unchanged.txt',
    '.git/config',
    '.git',
    'src/../hello.txt',
    './hello.txt',
    'missing.txt',
    fixture.root,
  ]) {
    const response = await requestDiff(fixture, path);
    assert.equal(response.status, 404, path);
    assert.equal(await errorCode(response), 'review_file_not_found', path);
  }
  for (const path of [null, '']) {
    const response = await requestDiff(fixture, path);
    assert.equal(response.status, 400);
    assert.equal(await errorCode(response), 'invalid_request');
  }
});

test('review routes are scoped to the task’s project', async () => {
  const fixture = await setUpRun('scoped repo a', {
    change: (worktree) => writeFile(join(worktree, 'hello.txt'), 'hi\n'),
  });
  const other = await registerProject('scoped repo b');
  const review = await reviewRoute(
    get(`/api/projects/${other.projectId}/tasks/${fixture.taskId}/review`),
    taskParams(other.projectId, fixture.taskId),
  );
  assert.equal(review.status, 404);
  assert.equal(await errorCode(review), 'task_not_found');
  const diff = await requestDiff(
    { projectId: other.projectId, taskId: fixture.taskId },
    'hello.txt',
  );
  assert.equal(diff.status, 404);
  assert.equal(await errorCode(diff), 'task_not_found');

  const unknown = await reviewRoute(
    get(`/api/projects/not-a-project/tasks/${fixture.taskId}/review`),
    taskParams('not-a-project', fixture.taskId),
  );
  assert.equal(unknown.status, 404);
  assert.equal(await errorCode(unknown), 'project_not_found');
});

test('review routes follow the loopback Host and same-origin rules', async () => {
  const fixture = await setUpRun('guard repo', {
    change: (worktree) => writeFile(join(worktree, 'hello.txt'), 'hi\n'),
  });
  const path = `/api/projects/${fixture.projectId}/tasks/${fixture.taskId}/review`;
  const params = taskParams(fixture.projectId, fixture.taskId);

  const badHost = await reviewRoute(
    new Request(`http://evil.example${path}`, { headers: { host: 'evil.example' } }),
    params,
  );
  assert.equal(badHost.status, 403);
  assert.equal(await errorCode(badHost), 'forbidden_host');

  const crossOrigin: Record<string, string>[] = [
    { origin: 'http://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ];
  for (const headers of crossOrigin) {
    const review = await reviewRoute(get(path, headers), params);
    assert.equal(review.status, 403);
    assert.equal(await errorCode(review), 'forbidden_origin');
    const diff = await requestDiff(fixture, 'hello.txt', headers);
    assert.equal(diff.status, 403);
  }

  const sameOrigin = await requestDiff(fixture, 'hello.txt', {
    origin,
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(sameOrigin.status, 200);
});

test('review is read-only: worktree, repository and database records are unchanged', async () => {
  const fixture = await setUpRun('read only repo', { seed: seedFiles, change: agentChanges });
  const db = getDatabase();
  const repositoryBefore = snapshot(fixture.root);
  const worktreeBefore = snapshot(fixture.worktree);
  const taskBefore = findTaskById(db, fixture.taskId);
  const runBefore = findTaskRun(db, fixture.runId);

  const review = await fetchReview(fixture.projectId, fixture.taskId);
  assert.equal(review.changes.state, 'available');
  if (review.changes.state !== 'available') return;
  for (const file of review.changes.files) {
    await fetchDiff(fixture, file.path);
  }
  await fetchReview(fixture.projectId, fixture.taskId);

  assert.deepEqual(snapshot(fixture.root), repositoryBefore);
  assert.deepEqual(snapshot(fixture.worktree), worktreeBefore);
  assert.deepEqual(findTaskById(db, fixture.taskId), taskBefore);
  assert.deepEqual(findTaskRun(db, fixture.runId), runBefore);
  // The untracked file stays untracked and nothing is staged by the review.
  assert.match(git(fixture.worktree, 'status', '--porcelain'), /^\?\? hello\.txt$/m);
});

test('review modules never import agent execution or call mutating helpers', () => {
  const sources = ['lib/server/review.ts', 'lib/server/review-route.ts'].map((path) =>
    readFileSync(join(import.meta.dirname, '..', path), 'utf8'),
  );
  for (const source of sources) {
    assert.doesNotMatch(source, /@ai-agent-manager\/(?:agents|orchestrator)/);
    assert.doesNotMatch(source, /node:child_process|spawn\(|execFile/);
    assert.doesNotMatch(
      source,
      /createTaskWorktree|removeTaskWorktree|requestTaskExecution|claimStartCommand|finishTaskRun|transitionTask|recordGitIntegrity/,
    );
    assert.doesNotMatch(source, /\.(?:insert|update|delete)\(/);
  }
  for (const route of ['review/route.ts', 'review/diff/route.ts']) {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'app/api/projects/[projectId]/tasks/[taskId]', route),
      'utf8',
    );
    assert.deepEqual(source.match(/export const (\w+)/g), ['export const GET']);
  }
});

test('an integrity violation is shown and blocks the normal review path', async () => {
  const fixture = await setUpRun('violation repo', {
    change: (worktree) => writeFile(join(worktree, 'hello.txt'), 'hi\n'),
    integrity: 'violation',
  });
  const review = await fetchReview(fixture.projectId, fixture.taskId);
  assert.equal(review.task.status, 'failed');
  assert.equal(review.run?.gitIntegrity.status, 'violation');
  assert.equal(review.run?.reviewEligible, false);
  assert.equal(review.eligibility.eligible, false);
  assert.ok(review.eligibility.reasons.includes('integrity_violation'));
  assert.ok(review.eligibility.reasons.includes('task_not_in_review'));
  // The changes stay inspectable.
  assert.equal(review.changes.state, 'available');

  const inconclusive = await setUpRun('inconclusive repo', { integrity: 'inconclusive' });
  const blocked = await fetchReview(inconclusive.projectId, inconclusive.taskId);
  assert.ok(blocked.eligibility.reasons.includes('integrity_inconclusive'));
});

test('a task without a run, or with an active run, has no inspectable changes', async () => {
  const { projectId, root } = await registerProject('active repo');
  const neverRan = await createQueuedTask(projectId, 'Never ran');
  const idle = await fetchReview(projectId, neverRan);
  assert.equal(idle.run, null);
  assert.deepEqual(idle.eligibility.reasons, ['no_run']);
  assert.equal(idle.changes.state, 'unavailable');

  const taskId = await createQueuedTask(projectId, 'Running');
  const { runId, worktree } = await startRun(projectId, root, taskId);
  writeFile(join(worktree, 'hello.txt'), 'in progress\n');
  try {
    const review = await fetchReview(projectId, taskId);
    assert.equal(review.changes.state, 'unavailable');
    if (review.changes.state === 'unavailable') {
      assert.equal(review.changes.code, 'review_unavailable');
    }
    assert.ok(review.eligibility.reasons.includes('run_active'));
    const diff = await requestDiff({ projectId, taskId }, 'hello.txt');
    assert.equal(diff.status, 409);
    assert.equal(await errorCode(diff), 'review_unavailable');
  } finally {
    finishRun(runId);
  }
});

const expectUnavailable = async (fixture: Fixture, code: string): Promise<void> => {
  const review = await fetchReview(fixture.projectId, fixture.taskId);
  assert.equal(review.changes.state, 'unavailable');
  if (review.changes.state === 'unavailable') {
    assert.equal(review.changes.code, code);
    assert.doesNotMatch(review.changes.message, /hello from|secret/i);
  }
  assert.equal(review.eligibility.eligible, false);
  assert.ok(review.eligibility.reasons.includes('changes_unavailable'));
  const diff = await requestDiff(fixture, 'hello.txt');
  assert.equal(diff.status, 409);
  assert.equal(await errorCode(diff), code);
};

const withHello = (worktree: string) => writeFile(join(worktree, 'hello.txt'), 'hello from\n');

test('a missing or moved worktree is reported safely and left as it is', async () => {
  const fixture = await setUpRun('moved repo', { change: withHello });
  const moved = `${fixture.worktree}-moved`;
  renameSync(fixture.worktree, moved);
  await expectUnavailable(fixture, 'workspace_not_verified');
  renameSync(moved, fixture.worktree);
  assert.equal((await fetchReview(fixture.projectId, fixture.taskId)).changes.state, 'available');
});

test('an unlocked or switched worktree is not trusted', async () => {
  const unlocked = await setUpRun('unlocked repo', { change: withHello });
  git(unlocked.root, 'worktree', 'unlock', unlocked.worktree);
  await expectUnavailable(unlocked, 'workspace_not_verified');

  const switched = await setUpRun('switched repo', { change: withHello });
  git(switched.worktree, 'switch', '--quiet', '-c', 'elsewhere');
  await expectUnavailable(switched, 'workspace_not_verified');
});

test('tampered workspace records are refused before anything is read', async () => {
  const fixture = await setUpRun('tampered repo', { change: withHello });
  const other = await setUpRun('tampered other repo', { change: withHello });
  const db = getDatabase();
  const run = findTaskRun(db, fixture.runId);
  const otherRun = findTaskRun(db, other.runId);
  assert.ok(run?.workspaceId);
  assert.ok(otherRun?.workspaceId);
  const workspaceId = run.workspaceId;
  // Simulates tampering with the database outside the application, through a second connection.
  const connection = createDatabase({ path: process.env[databaseVariable] });
  const sql = (statement: string, ...values: string[]) =>
    connection.sqlite.prepare(statement).run(...values);
  const original = connection.sqlite
    .prepare('SELECT path, base_sha AS baseSha FROM workspaces WHERE id = ?')
    .get(workspaceId) as { path: string; baseSha: string };
  const project = findProjectById(db, fixture.projectId);
  assert.ok(project);

  try {
    // The main checkout, an arbitrary directory, and a directory inside the main checkout.
    // (Another task's worktree path is covered below: paths are unique per workspace.)
    for (const path of [fixture.root, '/etc', join(fixture.root, fixture.taskId)]) {
      sql('UPDATE workspaces SET path = ? WHERE id = ?', path, workspaceId);
      await expectUnavailable(fixture, 'workspace_identity_mismatch');
    }
    sql('UPDATE workspaces SET path = ? WHERE id = ?', original.path, workspaceId);

    // The run pointing at another task's workspace record.
    sql('UPDATE task_runs SET workspace_id = ? WHERE id = ?', otherRun.workspaceId, fixture.runId);
    await expectUnavailable(fixture, 'workspace_identity_mismatch');
    sql('UPDATE task_runs SET workspace_id = ? WHERE id = ?', workspaceId, fixture.runId);

    // A project whose registered repository identity no longer matches the workspace.
    sql(
      'UPDATE projects SET git_common_dir = ? WHERE id = ?',
      join(directory, 'replaced repository', '.git'),
      fixture.projectId,
    );
    await expectUnavailable(fixture, 'workspace_identity_mismatch');
    sql(
      'UPDATE projects SET git_common_dir = ? WHERE id = ?',
      project.gitCommonDir,
      fixture.projectId,
    );

    // A base commit that does not exist in the repository.
    sql(
      'UPDATE workspaces SET base_sha = ? WHERE id = ?',
      '0123456789abcdef0123456789abcdef01234567',
      workspaceId,
    );
    await expectUnavailable(fixture, 'base_commit_missing');
  } finally {
    sql(
      'UPDATE workspaces SET path = ?, base_sha = ? WHERE id = ?',
      original.path,
      original.baseSha,
      workspaceId,
    );
    connection.close();
  }
  assert.equal((await fetchReview(fixture.projectId, fixture.taskId)).changes.state, 'available');
});
