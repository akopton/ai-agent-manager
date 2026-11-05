import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildPublicationCommitMessage } from '@ai-agent-manager/core';
import {
  claimPublication,
  createPublication,
  findPublication,
  findTaskById,
  findWorkspace,
  listGitOperations,
  listTaskRuns,
  recordPublicationCommitObject,
  requestPublicationPushRetry,
  type PublicationRecord,
  type WorkspaceRecord,
} from '@ai-agent-manager/database';
import {
  captureReviewSnapshot,
  commitReviewSnapshot,
  readPublishRemote,
} from '@ai-agent-manager/git';
import {
  git,
  snapshotTree,
  withExecutionFixture,
  type ExecutionFixture,
} from './execution-fixtures.js';

// Approve & Push in the worker (M6-03) against a disposable source repository, a real task
// worktree from a fake-CLI run and a local bare remote. No real agent, no network. The developer's
// global Git configuration is hidden so identity and signing come from the fixture repository.

let home = '';
const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

before(() => {
  home = mkdtempSync(join(tmpdir(), 'ai-agent-manager worker publish home '));
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

type Reviewed = { taskId: string; runId: string; workspace: WorkspaceRecord; remote: string };

/** Adds a bare `origin`, runs one fake-CLI attempt to Review and returns its workspace. */
const reviewedTask = async (fixture: ExecutionFixture): Promise<Reviewed> => {
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
  const service = fixture.service();
  await service.start();
  try {
    await service.tick();
    assert.equal(
      await fixture.waitForTaskStatus(taskId, ['review', 'failed', 'stopped', 'interrupted']),
      'review',
    );
  } finally {
    await service.stop();
  }
  const [run] = listTaskRuns(fixture.db, taskId);
  assert.ok(run?.workspaceId);
  const record = findWorkspace(fixture.db, run.workspaceId);
  assert.ok(record);
  return { taskId, runId: run.id, workspace: record, remote };
};

/** Records an approval exactly as the web process does: fresh snapshot, server-side destination. */
const approve = async (
  fixture: ExecutionFixture,
  reviewed: Reviewed,
): Promise<PublicationRecord> => {
  const { workspace } = reviewed;
  const capture = await captureReviewSnapshot({
    repositoryPath: fixture.repository.root,
    worktreePath: workspace.path,
    branchName: workspace.branch,
    baseCommit: workspace.baseSha,
  });
  assert.equal(capture.status, 'ready');
  assert.ok(capture.status === 'ready');
  const remote = await readPublishRemote(fixture.repository.root, 'origin');
  assert.ok(remote);
  const task = findTaskById(fixture.db, reviewed.taskId);
  assert.ok(task);
  return createPublication(fixture.db, {
    input: {
      id: randomUUID(),
      requestId: randomUUID(),
      taskId: reviewed.taskId,
      runId: reviewed.runId,
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
        taskId: task.id,
        title: task.title,
        attempt: 1,
        runId: reviewed.runId,
      }),
    },
    now: Date.now(),
  }).publication;
};

/** Starts a worker, runs one polling pass and waits for the publication to settle. */
const runWorker = async (
  fixture: ExecutionFixture,
  overrides: Parameters<ExecutionFixture['service']>[0] = {},
) => {
  const service = fixture.service(overrides);
  await service.start();
  try {
    await service.tick();
    await service.publicationsIdle();
  } finally {
    await service.stop();
  }
};

const refs = (repository: string): string[] =>
  git(repository, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean);

const branchCommit = (repository: string, branch: string): string | null => {
  try {
    return git(repository, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).trim();
  } catch {
    return null;
  }
};

const operations = (fixture: ExecutionFixture, publication: PublicationRecord) =>
  listGitOperations(fixture.db, [publication.id]).map(({ kind, status, errorCode }) =>
    [kind, status, errorCode].join(':'),
  );

test('publishes the approved change set to the task branch on the remote and marks Done', async () => {
  await withExecutionFixture(async (fixture) => {
    const reviewed = await reviewedTask(fixture);
    const { root } = fixture.repository;
    // The operator's own checkout is dirty; publishing must leave it exactly as it is.
    writeFileSync(join(root, 'local-notes.txt'), 'uncommitted operator work\n');
    const sourceBefore = snapshotTree(root);
    const sourceRefsBefore = refs(root);
    const remoteRefsBefore = refs(reviewed.remote);

    const publication = await approve(fixture, reviewed);
    assert.equal(findTaskById(fixture.db, reviewed.taskId)?.status, 'review');
    await runWorker(fixture);

    const done = findPublication(fixture.db, publication.id);
    assert.equal(done?.status, 'pushed', done?.errorMessage ?? '');
    assert.equal(findTaskById(fixture.db, reviewed.taskId)?.status, 'done');
    assert.deepEqual(operations(fixture, publication), ['commit:succeeded:', 'push:succeeded:']);
    const commit = done?.commitSha;
    assert.ok(commit);

    const { branch, baseSha } = reviewed.workspace;
    assert.equal(branchCommit(root, branch), commit);
    assert.equal(branchCommit(reviewed.remote, branch), commit);
    assert.equal(git(root, 'rev-parse', `${commit}^`).trim(), baseSha);
    assert.equal(git(root, 'show', `${commit}:feature.txt`), 'implemented\n');
    assert.match(git(root, 'log', '-1', '--format=%s%n%b', commit), /AI Agent Manager task: /);

    // Remote: only the task branch was created; main is untouched.
    assert.deepEqual(
      refs(reviewed.remote).filter((line) => !remoteRefsBefore.includes(line)),
      [`refs/heads/${branch} ${commit}`],
    );
    // Source repository: only the task branch and its remote-tracking ref changed; the checkout,
    // its uncommitted file and every other ref are unchanged.
    assert.deepEqual(
      refs(root)
        .filter((line) => !sourceRefsBefore.includes(line))
        .sort(),
      [`refs/heads/${branch} ${commit}`, `refs/remotes/origin/${branch} ${commit}`].sort(),
    );
    const sourceAfter = snapshotTree(root);
    for (const [file, value] of sourceBefore) {
      if (file.startsWith('.git/')) continue;
      assert.equal(sourceAfter.get(file), value, file);
    }
    assert.equal(git(root, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
  });
});

test('a worktree changed after approval is refused before anything is committed', async () => {
  const tampers: Array<[string, (reviewed: Reviewed) => void]> = [
    ['unapproved file', ({ workspace }) => writeFileSync(join(workspace.path, 'extra.txt'), 'x\n')],
    [
      'edited file',
      ({ workspace }) => writeFileSync(join(workspace.path, 'feature.txt'), 'edited later\n'),
    ],
    [
      'unexpected commit',
      ({ workspace }) => {
        git(workspace.path, 'add', '--all');
        git(workspace.path, 'commit', '--quiet', '-m', 'Agent commit after review');
      },
    ],
    ['branch switch', ({ workspace }) => git(workspace.path, 'switch', '--quiet', '-c', 'other')],
    [
      'unlocked worktree',
      ({ workspace }) => git(workspace.path, 'worktree', 'unlock', workspace.path),
    ],
    ['missing worktree', ({ workspace }) => renameSync(workspace.path, `${workspace.path}-moved`)],
  ];
  for (const [name, tamper] of tampers) {
    await withExecutionFixture(async (fixture) => {
      const reviewed = await reviewedTask(fixture);
      const publication = await approve(fixture, reviewed);
      tamper(reviewed);
      const branchBefore = branchCommit(fixture.repository.root, reviewed.workspace.branch);
      await runWorker(fixture);
      const failed = findPublication(fixture.db, publication.id);
      assert.equal(failed?.status, 'failed', name);
      assert.equal(failed?.failureStage, 'validation', `${name}: ${failed?.errorCode}`);
      assert.equal(failed?.commitSha, null, name);
      assert.equal(findTaskById(fixture.db, reviewed.taskId)?.status, 'review', name);
      assert.equal(
        branchCommit(fixture.repository.root, reviewed.workspace.branch),
        branchBefore,
        `${name}: the worker did not move the task branch`,
      );
      assert.equal(branchCommit(reviewed.remote, reviewed.workspace.branch), null, name);
    });
  }
});

test('a failed push keeps the single commit and is retried without a new commit', async () => {
  await withExecutionFixture(async (fixture) => {
    const reviewed = await reviewedTask(fixture);
    const publication = await approve(fixture, reviewed);
    const parked = `${reviewed.remote}-offline`;
    renameSync(reviewed.remote, parked);
    await runWorker(fixture);

    const failed = findPublication(fixture.db, publication.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.failureStage, 'push');
    assert.equal(failed?.errorCode, 'push_remote_unavailable');
    assert.ok(failed?.commitSha);
    assert.equal(findTaskById(fixture.db, reviewed.taskId)?.status, 'review', 'not Done');
    assert.equal(
      branchCommit(fixture.repository.root, reviewed.workspace.branch),
      failed.commitSha,
    );

    renameSync(parked, reviewed.remote);
    requestPublicationPushRetry(fixture.db, {
      taskId: reviewed.taskId,
      publicationId: publication.id,
      now: Date.now(),
    });
    await runWorker(fixture);
    const pushed = findPublication(fixture.db, publication.id);
    assert.equal(pushed?.status, 'pushed', pushed?.errorMessage ?? '');
    assert.equal(pushed?.commitSha, failed.commitSha, 'the same commit was pushed');
    assert.equal(branchCommit(reviewed.remote, reviewed.workspace.branch), failed.commitSha);
    assert.equal(
      git(
        fixture.repository.root,
        'rev-list',
        '--count',
        `${reviewed.workspace.baseSha}..${failed.commitSha}`,
      ).trim(),
      '1',
    );
    assert.deepEqual(operations(fixture, publication), [
      'commit:succeeded:',
      'push:failed:push_remote_unavailable',
      'push:succeeded:',
    ]);
    assert.equal(findTaskById(fixture.db, reviewed.taskId)?.status, 'done');
  });
});

test('a non-fast-forward remote branch is rejected, never forced', async () => {
  await withExecutionFixture(async (fixture) => {
    const reviewed = await reviewedTask(fixture);
    const { branch } = reviewed.workspace;
    const other = join(fixture.directory, 'other clone');
    git(fixture.directory, 'clone', '--quiet', reviewed.remote, other);
    writeFileSync(join(other, 'conflict.txt'), 'someone else\n');
    git(other, 'add', 'conflict.txt');
    git(other, 'commit', '--quiet', '-m', 'Other work');
    git(other, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    const remoteBranch = branchCommit(reviewed.remote, branch);

    const publication = await approve(fixture, reviewed);
    await runWorker(fixture);
    const failed = findPublication(fixture.db, publication.id);
    assert.equal(failed?.errorCode, 'push_rejected_non_fast_forward');
    assert.equal(branchCommit(reviewed.remote, branch), remoteBranch, 'remote branch unchanged');
    assert.equal(findTaskById(fixture.db, reviewed.taskId)?.status, 'review');
  });
});

test('restart reconciliation never resumes a publication and keeps an existing commit', async () => {
  // Crash after the branch moved but before the commit was recorded as complete.
  await withExecutionFixture(async (fixture) => {
    const reviewed = await reviewedTask(fixture);
    const publication = await approve(fixture, reviewed);
    const claim = claimPublication(fixture.db, {
      id: publication.id,
      operationId: randomUUID(),
      workerInstanceId: 'crashed-worker',
      now: Date.now(),
    });
    assert.ok(claim);
    await commitReviewSnapshot({
      repositoryPath: fixture.repository.root,
      worktreePath: reviewed.workspace.path,
      branchName: reviewed.workspace.branch,
      baseCommit: reviewed.workspace.baseSha,
      snapshot: JSON.parse(publication.snapshotJson) as Parameters<
        typeof commitReviewSnapshot
      >[0]['snapshot'],
      snapshotHash: publication.snapshotHash,
      message: publication.commitMessage,
      onCommitObject: ({ commitSha, treeSha }) => {
        recordPublicationCommitObject(fixture.db, {
          id: publication.id,
          commitSha,
          treeSha,
          now: Date.now(),
        });
      },
    });
    // The worker "crashed" here. A new worker reconciles from Git state and does not push.
    await runWorker(fixture);
    const reconciled = findPublication(fixture.db, publication.id);
    assert.equal(reconciled?.status, 'failed');
    assert.equal(reconciled?.failureStage, 'push');
    assert.equal(reconciled?.errorCode, 'interrupted');
    assert.equal(branchCommit(reviewed.remote, reviewed.workspace.branch), null, 'not pushed');
    assert.equal(findTaskById(fixture.db, reviewed.taskId)?.status, 'review');

    requestPublicationPushRetry(fixture.db, {
      taskId: reviewed.taskId,
      publicationId: publication.id,
      now: Date.now(),
    });
    await runWorker(fixture);
    assert.equal(findPublication(fixture.db, publication.id)?.status, 'pushed');
    assert.equal(findTaskById(fixture.db, reviewed.taskId)?.status, 'done');
  });

  // Crash before anything was committed: nothing to keep; a fresh approval is possible.
  await withExecutionFixture(async (fixture) => {
    const reviewed = await reviewedTask(fixture);
    const publication = await approve(fixture, reviewed);
    claimPublication(fixture.db, {
      id: publication.id,
      operationId: randomUUID(),
      workerInstanceId: 'crashed-worker',
      now: Date.now(),
    });
    await runWorker(fixture);
    const reconciled = findPublication(fixture.db, publication.id);
    assert.equal(reconciled?.failureStage, 'commit');
    assert.equal(reconciled?.errorCode, 'interrupted');
    assert.equal(
      branchCommit(fixture.repository.root, reviewed.workspace.branch),
      reviewed.workspace.baseSha,
    );
    const again = await approve(fixture, reviewed);
    assert.equal(again.status, 'approved');
  });
});

test('repeated polling while a publication runs never starts a second one', async () => {
  await withExecutionFixture(async (fixture) => {
    const reviewed = await reviewedTask(fixture);
    const publication = await approve(fixture, reviewed);
    let commits = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = fixture.service({
      publicationGit: {
        commit: async (options) => {
          commits += 1;
          await gate;
          return commitReviewSnapshot(options);
        },
      },
    });
    await service.start();
    try {
      await service.tick();
      await service.tick();
      await service.tick();
      release();
      await service.publicationsIdle();
      await service.tick();
      await service.publicationsIdle();
    } finally {
      await service.stop();
    }
    assert.equal(commits, 1);
    assert.equal(findPublication(fixture.db, publication.id)?.status, 'pushed');
    assert.equal(
      listGitOperations(fixture.db, [publication.id]).filter(({ kind }) => kind === 'commit')
        .length,
      1,
    );
  });
});
