import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildPublicationCommitMessage } from '@ai-agent-manager/core';
import {
  claimWorkspaceCleanup,
  createPublication,
  findTaskById,
  findWorkspace,
  findWorkspaceCleanup,
  listTaskPublications,
  listTaskRuns,
  listTaskWorkspaces,
  requestWorkspaceCleanup,
  type WorkspaceRecord,
} from '@ai-agent-manager/database';
import { captureReviewSnapshot, readPublishRemote } from '@ai-agent-manager/git';
import {
  git,
  snapshotTree,
  withExecutionFixture,
  type ExecutionFixture,
} from './execution-fixtures.js';

// Remove local worktree (TM-02) in the worker, end to end: a fake-CLI attempt reaches Review, is
// published through the real Approve & Push path to a local bare remote (no network, no real agent),
// and the operator's confirmed cleanup request is executed by the worker. The developer's global Git
// configuration is hidden so identity and signing come from the fixture repository.

let home = '';
const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

before(() => {
  home = mkdtempSync(join(tmpdir(), 'ai-agent-manager worker cleanup home '));
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

type Published = {
  taskId: string;
  workspace: WorkspaceRecord;
  remote: string;
  commit: string;
};

const refs = (repository: string): string[] =>
  git(repository, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean);

const checkoutFiles = (directory: string) =>
  [...snapshotTree(directory)].filter(([path]) => !path.startsWith('.git/'));

/** Runs a fake-CLI attempt to Review, approves it and lets the worker publish it (→ Done). */
const publishedTask = async (fixture: ExecutionFixture): Promise<Published> => {
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

  fixture.grantConsent();
  const taskId = fixture.queuedTask('codex');
  fixture.requestStart(taskId);
  const runner = fixture.service();
  await runner.start();
  try {
    await runner.tick();
    assert.equal(await fixture.waitForTaskStatus(taskId, ['review', 'failed']), 'review');
  } finally {
    await runner.stop();
  }
  const [run] = listTaskRuns(fixture.db, taskId);
  assert.ok(run?.workspaceId);
  const workspace = findWorkspace(fixture.db, run.workspaceId);
  assert.ok(workspace);

  const capture = await captureReviewSnapshot({
    repositoryPath: root,
    worktreePath: workspace.path,
    branchName: workspace.branch,
    baseCommit: workspace.baseSha,
  });
  assert.ok(capture.status === 'ready');
  const destination = await readPublishRemote(root, 'origin');
  assert.ok(destination);
  const task = findTaskById(fixture.db, taskId);
  assert.ok(task);
  createPublication(fixture.db, {
    input: {
      id: randomUUID(),
      requestId: randomUUID(),
      taskId,
      runId: run.id,
      workspaceId: workspace.id,
      inventoryRevision: capture.revision,
      snapshotHash: capture.snapshotHash,
      snapshotJson: JSON.stringify(capture.snapshot),
      fileCount: capture.snapshot.files.length,
      baseCommit: workspace.baseSha,
      branch: workspace.branch,
      remoteName: destination.name,
      remoteUrl: destination.displayUrl,
      remoteUrlDigest: destination.urlDigest,
      commitMessage: buildPublicationCommitMessage({
        taskId,
        title: task.title,
        attempt: 1,
        runId: run.id,
      }),
    },
    now: Date.now(),
  });
  const publisher = fixture.service();
  await publisher.start();
  try {
    await publisher.tick();
    await publisher.publicationsIdle();
  } finally {
    await publisher.stop();
  }
  const [publication] = listTaskPublications(fixture.db, taskId);
  assert.equal(publication?.status, 'pushed', publication?.errorMessage ?? '');
  assert.equal(findTaskById(fixture.db, taskId)?.status, 'done');
  assert.ok(publication.commitSha);
  return { taskId, workspace, remote, commit: publication.commitSha };
};

const requestCleanup = (fixture: ExecutionFixture, published: Published, now = Date.now()) =>
  requestWorkspaceCleanup(fixture.db, {
    id: randomUUID(),
    taskId: published.taskId,
    input: {
      requestId: randomUUID(),
      workspaceId: published.workspace.id,
      expectedCommit: published.commit,
      confirmed: true,
    },
    now,
  }).cleanup;

/** Starts a worker, runs one polling pass and waits for the cleanup to settle. */
const runCleanup = async (fixture: ExecutionFixture) => {
  const service = fixture.service();
  await service.start();
  try {
    await service.tick();
    await service.cleanupsIdle();
  } finally {
    await service.stop();
  }
};

test('removes a published task worktree and keeps the branch, remote, checkout and records', async () => {
  await withExecutionFixture(async (fixture) => {
    const published = await publishedTask(fixture);
    const { root } = fixture.repository;
    // Unrelated local work: a dirty main checkout and a manually created worktree.
    writeFileSync(join(root, 'operator-notes.txt'), 'uncommitted operator work\n');
    const unrelated = join(fixture.directory, 'manual worktree');
    git(root, 'worktree', 'add', '--quiet', '-b', 'manual', unrelated);
    writeFileSync(join(unrelated, 'draft.txt'), 'draft\n');
    const checkoutBefore = checkoutFiles(root);
    const remoteRefsBefore = refs(published.remote);
    const runsBefore = listTaskRuns(fixture.db, published.taskId);
    const publicationsBefore = listTaskPublications(fixture.db, published.taskId);
    const invocations = fixture.clis.codex.invocations().length;

    const cleanup = requestCleanup(fixture, published);
    assert.equal(cleanup.status, 'requested');
    // Recording the request changed nothing on disk.
    assert.ok(existsSync(published.workspace.path));

    await runCleanup(fixture);
    const done = findWorkspaceCleanup(fixture.db, cleanup.id);
    assert.equal(done?.status, 'removed', done?.errorMessage ?? '');
    assert.equal(done?.branchCommit, published.commit);
    assert.equal(existsSync(published.workspace.path), false);
    assert.doesNotMatch(git(root, 'worktree', 'list', '--porcelain'), new RegExp(published.taskId));
    // The local task branch, the remote and the operator's work are untouched.
    assert.equal(git(root, 'rev-parse', published.workspace.branch).trim(), published.commit);
    assert.deepEqual(refs(published.remote), remoteRefsBefore);
    assert.deepEqual(checkoutFiles(root), checkoutBefore);
    assert.equal(readFileSync(join(unrelated, 'draft.txt'), 'utf8'), 'draft\n');
    assert.equal(git(root, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
    // History is preserved; no agent ran and nothing new was published.
    assert.equal(findTaskById(fixture.db, published.taskId)?.status, 'done');
    assert.deepEqual(listTaskRuns(fixture.db, published.taskId), runsBefore);
    assert.deepEqual(listTaskPublications(fixture.db, published.taskId), publicationsBefore);
    assert.equal(listTaskWorkspaces(fixture.db, published.taskId).length, 1);
    assert.equal(fixture.clis.codex.invocations().length, invocations);

    // A repeated request is refused; nothing else happens.
    assert.throws(() => requestCleanup(fixture, published), /already removed/);
  });
});

test('a worktree that changed after the request is preserved', async () => {
  await withExecutionFixture(async (fixture) => {
    const published = await publishedTask(fixture);
    const cleanup = requestCleanup(fixture, published);
    const untracked = join(published.workspace.path, 'late-file.txt');
    writeFileSync(untracked, 'written after the request\n');

    await runCleanup(fixture);
    const failed = findWorkspaceCleanup(fixture.db, cleanup.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.errorCode, 'worktree_not_removable');
    assert.match(failed?.errorMessage ?? '', /untracked/);
    assert.equal(readFileSync(untracked, 'utf8'), 'written after the request\n');
    assert.match(
      git(fixture.repository.root, 'worktree', 'list', '--porcelain'),
      /locked ai-agent-manager task worktree/,
    );
  });
});

test('a worktree that was unlocked or switched after the request is preserved', async () => {
  await withExecutionFixture(async (fixture) => {
    const published = await publishedTask(fixture);
    const { root } = fixture.repository;
    const first = requestCleanup(fixture, published);
    git(root, 'worktree', 'unlock', published.workspace.path);
    await runCleanup(fixture);
    assert.equal(findWorkspaceCleanup(fixture.db, first.id)?.status, 'failed');
    assert.ok(existsSync(published.workspace.path));

    git(
      root,
      'worktree',
      'lock',
      '--reason',
      `ai-agent-manager task worktree: ${published.workspace.branch}`,
      published.workspace.path,
    );
    git(published.workspace.path, 'switch', '--quiet', '-c', 'elsewhere');
    const second = requestCleanup(fixture, published);
    await runCleanup(fixture);
    assert.equal(findWorkspaceCleanup(fixture.db, second.id)?.status, 'failed');
    assert.ok(existsSync(published.workspace.path));
  });
});

test('an interrupted removal is settled from Git state and never repeated', async () => {
  await withExecutionFixture(async (fixture) => {
    const published = await publishedTask(fixture);
    const { root } = fixture.repository;
    const target = published.workspace.path;

    // Interrupted before Git did anything: the worktree stays, the request fails.
    const first = requestCleanup(fixture, published);
    assert.ok(
      claimWorkspaceCleanup(fixture.db, { id: first.id, workerInstanceId: 'old', now: Date.now() })
        .claimed,
    );
    await runCleanup(fixture);
    assert.equal(findWorkspaceCleanup(fixture.db, first.id)?.status, 'failed');
    assert.equal(findWorkspaceCleanup(fixture.db, first.id)?.errorCode, 'interrupted');
    assert.ok(existsSync(target));

    // Interrupted between unlock and remove: the lock is restored, nothing is removed.
    const second = requestCleanup(fixture, published);
    assert.ok(
      claimWorkspaceCleanup(fixture.db, { id: second.id, workerInstanceId: 'old', now: Date.now() })
        .claimed,
    );
    git(root, 'worktree', 'unlock', target);
    await runCleanup(fixture);
    assert.match(findWorkspaceCleanup(fixture.db, second.id)?.errorMessage ?? '', /locked again/);
    assert.match(
      git(root, 'worktree', 'list', '--porcelain'),
      /locked ai-agent-manager task worktree/,
    );

    // Interrupted after Git removed it: recorded as removed, the branch is kept.
    const third = requestCleanup(fixture, published);
    assert.ok(
      claimWorkspaceCleanup(fixture.db, { id: third.id, workerInstanceId: 'old', now: Date.now() })
        .claimed,
    );
    git(root, 'worktree', 'unlock', target);
    git(root, 'worktree', 'remove', target);
    await runCleanup(fixture);
    const settled = findWorkspaceCleanup(fixture.db, third.id);
    assert.equal(settled?.status, 'removed');
    assert.equal(settled?.errorCode, 'interrupted_after_removal');
    assert.equal(git(root, 'rev-parse', published.workspace.branch).trim(), published.commit);
  });
});

test('a request the worker did not pick up in time expires instead of running later', async () => {
  await withExecutionFixture(async (fixture) => {
    const published = await publishedTask(fixture);
    const stale = requestCleanup(fixture, published, Date.now() - 60 * 60 * 1000);
    await runCleanup(fixture);
    assert.equal(findWorkspaceCleanup(fixture.db, stale.id)?.errorCode, 'request_expired');
    assert.ok(existsSync(published.workspace.path));
  });
});
