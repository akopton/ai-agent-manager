import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  captureReviewSnapshot,
  commitReviewSnapshot,
  createTaskWorktree,
  PublishError,
  pushTaskBranch,
  readPublishRemote,
  type PublishErrorCode,
  type ReviewSnapshotCapture,
  type TaskChangesOptions,
} from '../src/index.js';
import { createRepository, git, snapshot, withFixtures, writeFile } from './fixtures.js';

// Approve & Push primitives against disposable repositories and local bare remotes only. The
// developer's global Git configuration is hidden (HOME points to an empty directory), so identity,
// signing and hooks come only from each fixture repository.

let home = '';
const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

before(() => {
  home = mkdtempSync(join(tmpdir(), 'ai-agent-manager publish home '));
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

const message = 'Add greeting\n\nAI Agent Manager task T-1, attempt 1.';

const setUp = async (directory: string, { withRemote = true } = {}) => {
  const root = createRepository(join(directory, 'main repo'));
  git(root, 'config', 'user.name', 'Publisher');
  git(root, 'config', 'user.email', 'publisher@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFile(join(root, 'src', 'app.ts'), 'export const answer = 41;\n');
  writeFile(join(root, 'docs', 'old-name.md'), '# Notes\n');
  writeFile(join(root, 'remove-me.txt'), 'obsolete\n');
  writeFile(join(root, '.gitignore'), '.env\nbuild/\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Base');
  git(root, 'branch', 'unrelated');
  const remote = join(directory, 'remote.git');
  if (withRemote) {
    git(directory, 'init', '--quiet', '--bare', remote);
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '--quiet', 'origin', 'main');
  }
  const worktree = await createTaskWorktree({
    repositoryPath: root,
    baseBranch: 'main',
    taskId: 'publish',
    worktreeRoot: join(directory, 'worktrees'),
  });
  const target: TaskChangesOptions = {
    repositoryPath: root,
    worktreePath: worktree.path,
    branchName: worktree.branch,
    baseCommit: worktree.baseCommit,
  };
  return { root, remote, path: worktree.path, branch: worktree.branch, target };
};

const agentChanges = (path: string): void => {
  writeFile(join(path, 'src', 'app.ts'), 'export const answer = 42;\n');
  rmSync(join(path, 'remove-me.txt'));
  git(path, 'mv', 'docs/old-name.md', 'docs/new-name.md');
  writeFile(join(path, 'staged.ts'), 'export const staged = true;\n');
  git(path, 'add', 'staged.ts');
  writeFile(join(path, 'hello.txt'), 'Hello from the agent\n');
  writeFile(join(path, 'bin', 'run.sh'), '#!/bin/sh\necho run\n');
  chmodSync(join(path, 'bin', 'run.sh'), 0o755);
  symlinkSync('hello.txt', join(path, 'hello-link'));
  writeFileSync(join(path, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff]));
  writeFile(join(path, '.env'), 'SECRET=ignored\n');
  writeFile(join(path, 'build', 'out.js'), 'ignored\n');
};

const ready = (capture: ReviewSnapshotCapture) => {
  assert.equal(capture.status, 'ready', JSON.stringify(capture.status === 'blocked' && capture));
  assert.ok(capture.status === 'ready');
  return capture;
};

const rejectsWith = (code: PublishErrorCode) => (error: unknown) => {
  assert.ok(error instanceof PublishError, String(error));
  assert.equal(error.code, code, error.message);
  return true;
};

const refs = (root: string): string =>
  git(root, 'for-each-ref', '--format=%(refname) %(objectname)');

const lsTree = (root: string, commit: string): string =>
  git(root, 'ls-tree', '-r', '--full-tree', commit);

test('captures every change with exact content hashes and nothing ignored', async () => {
  await withFixtures(async (directory) => {
    const { path, target } = await setUp(directory);
    agentChanges(path);
    const capture = ready(await captureReviewSnapshot(target));
    const entries = Object.fromEntries(
      capture.snapshot.entries.map((entry) => [
        entry.path,
        entry.action === 'write' ? entry.mode : 'delete',
      ]),
    );
    assert.deepEqual(entries, {
      'bin/run.sh': '100755',
      'docs/new-name.md': '100644',
      'docs/old-name.md': 'delete',
      'hello-link': '120000',
      'hello.txt': '100644',
      'image.bin': '100644',
      'remove-me.txt': 'delete',
      'src/app.ts': '100644',
      'staged.ts': '100644',
    });
    assert.equal(capture.snapshot.headCommit, capture.snapshot.baseCommit);
    // Deterministic: the same worktree yields the same hash.
    assert.equal(ready(await captureReviewSnapshot(target)).snapshotHash, capture.snapshotHash);
  });
});

test('blocks change sets that cannot be published as reviewed', async () => {
  await withFixtures(async (directory) => {
    const { path, target } = await setUp(directory);
    const empty = await captureReviewSnapshot(target);
    assert.equal(empty.status, 'blocked');
    assert.deepEqual(empty.status === 'blocked' && empty.blockers.map(({ code }) => code), [
      'no_changes',
    ]);

    writeFile(join(path, 'hello.txt'), 'hi\n');
    createRepository(join(path, 'nested'));
    const nested = await captureReviewSnapshot(target);
    assert.equal(nested.status, 'blocked');
    assert.ok(
      nested.status === 'blocked' &&
        nested.blockers.some(
          ({ code, path: blocked }) => code === 'unsupported_file' && blocked === 'nested/',
        ),
    );
    rmSync(join(path, 'nested'), { recursive: true, force: true });

    writeFile(join(path, 'big.txt'), 'x'.repeat(2048));
    const large = await captureReviewSnapshot({ ...target, publishLimits: { maxFileBytes: 1024 } });
    assert.ok(
      large.status === 'blocked' && large.blockers.some(({ code }) => code === 'file_too_large'),
    );

    git(path, 'add', 'hello.txt');
    git(path, 'commit', '--quiet', '-m', 'Agent commit');
    const committed = await captureReviewSnapshot(target);
    assert.ok(
      committed.status === 'blocked' &&
        committed.blockers.some(({ code }) => code === 'unexpected_commits'),
    );
  });
});

test('commits exactly the approved snapshot on the task branch only', async () => {
  await withFixtures(async (directory) => {
    const { root, path, branch, target } = await setUp(directory);
    agentChanges(path);
    const capture = ready(await captureReviewSnapshot(target));
    const mainBefore = snapshot(root);
    const refsBefore = refs(root);

    let branchAtCallback: string | null = null;
    const result = await commitReviewSnapshot({
      ...target,
      snapshot: capture.snapshot,
      snapshotHash: capture.snapshotHash,
      message,
      onCommitObject: () => {
        branchAtCallback = git(root, 'rev-parse', `refs/heads/${branch}`).trim();
      },
    });
    assert.equal(
      branchAtCallback,
      target.baseCommit,
      'the SHA is reported before the branch moves',
    );
    assert.equal(git(root, 'rev-parse', `refs/heads/${branch}`).trim(), result.commitSha);
    assert.equal(git(root, 'rev-parse', `${result.commitSha}^`).trim(), target.baseCommit);
    assert.equal(
      git(root, 'rev-list', '--count', `${target.baseCommit}..${result.commitSha}`).trim(),
      '1',
    );
    assert.equal(
      git(root, 'log', '-1', '--format=%an <%ae>%n%B', result.commitSha).trim(),
      `Publisher <publisher@example.invalid>\n${message}`,
    );

    const tree = lsTree(root, result.commitSha);
    assert.match(tree, /^100755 blob \S+\tbin\/run\.sh$/m);
    assert.match(tree, /^120000 blob \S+\thello-link$/m);
    assert.match(tree, /\tdocs\/new-name\.md$/m);
    assert.doesNotMatch(tree, /old-name|remove-me|\.env|build\//);
    assert.equal(
      git(root, 'show', `${result.commitSha}:src/app.ts`),
      'export const answer = 42;\n',
    );
    assert.equal(git(root, 'cat-file', '-p', `${result.commitSha}:hello-link`), 'hello.txt');

    // Only the task branch moved; the main checkout, other branches and the remote are untouched.
    const changedRefs = refs(root)
      .split('\n')
      .filter((line) => !refsBefore.split('\n').includes(line));
    assert.deepEqual(changedRefs, [`refs/heads/${branch} ${result.commitSha}`]);
    const mainAfter = snapshot(root);
    for (const [file, value] of mainBefore) {
      if (file.startsWith('.git/')) continue;
      assert.equal(mainAfter.get(file), value, file);
    }
    // The worktree is clean apart from ignored files, and its files were not rewritten.
    assert.equal(result.indexSynced, true);
    assert.equal(git(path, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.equal(
      git(path, 'status', '--porcelain', '--ignored', '--untracked-files=all').trim(),
      '!! .env\n!! build/out.js'.trim(),
    );
  });
});

test('refuses to commit when the worktree changed after the approval', async () => {
  for (const tamper of [
    (path: string) => writeFile(join(path, 'hello.txt'), 'changed after review\n'),
    (path: string) => writeFile(join(path, 'unapproved.txt'), 'new file after review\n'),
    (path: string) => chmodSync(join(path, 'hello.txt'), 0o755),
  ]) {
    await withFixtures(async (directory) => {
      const { root, path, branch, target } = await setUp(directory);
      writeFile(join(path, 'hello.txt'), 'hello\n');
      const capture = ready(await captureReviewSnapshot(target));
      tamper(path);
      const objectsBefore = git(root, 'count-objects', '-v');
      await assert.rejects(
        commitReviewSnapshot({
          ...target,
          snapshot: capture.snapshot,
          snapshotHash: capture.snapshotHash,
          message,
        }),
        rejectsWith('snapshot_changed'),
      );
      assert.equal(git(root, 'rev-parse', `refs/heads/${branch}`).trim(), target.baseCommit);
      assert.equal(git(root, 'count-objects', '-v'), objectsBefore, 'no objects were written');
    });
  }
});

test('refuses to commit on a moved branch or with a forged snapshot', async () => {
  await withFixtures(async (directory) => {
    const { root, path, branch, target } = await setUp(directory);
    writeFile(join(path, 'hello.txt'), 'hello\n');
    const capture = ready(await captureReviewSnapshot(target));

    const forged = {
      ...capture.snapshot,
      entries: capture.snapshot.entries.filter((entry) => entry.path !== 'hello.txt'),
    };
    await assert.rejects(
      commitReviewSnapshot({
        ...target,
        snapshot: forged,
        snapshotHash: capture.snapshotHash,
        message,
      }),
      rejectsWith('snapshot_changed'),
    );

    git(path, 'add', 'hello.txt');
    git(path, 'commit', '--quiet', '-m', 'Unexpected agent commit');
    const moved = git(root, 'rev-parse', `refs/heads/${branch}`).trim();
    await assert.rejects(
      commitReviewSnapshot({
        ...target,
        snapshot: capture.snapshot,
        snapshotHash: capture.snapshotHash,
        message,
      }),
      rejectsWith('branch_moved'),
    );
    assert.equal(git(root, 'rev-parse', `refs/heads/${branch}`).trim(), moved);
  });
});

test('reports whitespace errors and a missing Git identity without committing', async () => {
  await withFixtures(async (directory) => {
    const { root, path, branch, target } = await setUp(directory);
    writeFile(join(path, 'hello.txt'), 'trailing space \n');
    const capture = ready(await captureReviewSnapshot(target));
    await assert.rejects(
      commitReviewSnapshot({
        ...target,
        snapshot: capture.snapshot,
        snapshotHash: capture.snapshotHash,
        message,
      }),
      rejectsWith('diff_check_failed'),
    );
    assert.equal(git(root, 'rev-parse', `refs/heads/${branch}`).trim(), target.baseCommit);
  });
  await withFixtures(async (directory) => {
    const { root, path, branch, target } = await setUp(directory);
    git(root, 'config', '--unset', 'user.name');
    git(root, 'config', '--unset', 'user.email');
    writeFile(join(path, 'hello.txt'), 'hello\n');
    const capture = ready(await captureReviewSnapshot(target));
    await assert.rejects(
      commitReviewSnapshot({
        ...target,
        snapshot: capture.snapshot,
        snapshotHash: capture.snapshotHash,
        message,
      }),
      rejectsWith('git_identity_missing'),
    );
    assert.equal(git(root, 'rev-parse', `refs/heads/${branch}`).trim(), target.baseCommit);
  });
});

test('pushes only the task branch, idempotently, and never forces', async () => {
  await withFixtures(async (directory) => {
    const { root, remote, path, branch, target } = await setUp(directory);
    writeFile(join(path, 'hello.txt'), 'hello\n');
    const capture = ready(await captureReviewSnapshot(target));
    const { commitSha } = await commitReviewSnapshot({
      ...target,
      snapshot: capture.snapshot,
      snapshotHash: capture.snapshotHash,
      message,
    });
    const publishRemote = await readPublishRemote(root, 'origin');
    assert.ok(publishRemote);
    assert.equal(publishRemote.displayUrl, remote);
    const remoteRefsBefore = refs(remote);
    const push = {
      ...target,
      commitSha,
      remoteName: 'origin',
      expectedRemoteDigest: publishRemote.urlDigest,
    };

    assert.equal((await pushTaskBranch(push)).outcome, 'created');
    assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`).trim(), commitSha);
    assert.equal(
      git(remote, 'rev-parse', 'refs/heads/main').trim(),
      target.baseCommit,
      'the base branch on the remote is untouched',
    );
    assert.deepEqual(
      refs(remote)
        .split('\n')
        .filter((line) => !remoteRefsBefore.split('\n').includes(line)),
      [`refs/heads/${branch} ${commitSha}`],
    );

    // Retrying after a success is "up to date", never a second commit.
    assert.equal((await pushTaskBranch(push)).outcome, 'up_to_date');
    assert.equal(git(remote, 'rev-list', '--count', `refs/heads/${branch}`).trim(), '3');
  });
});

test('push failures are classified and leave the commit and remote as they were', async () => {
  await withFixtures(async (directory) => {
    const { root, remote, path, branch, target } = await setUp(directory);
    writeFile(join(path, 'hello.txt'), 'hello\n');
    const capture = ready(await captureReviewSnapshot(target));
    const { commitSha } = await commitReviewSnapshot({
      ...target,
      snapshot: capture.snapshot,
      snapshotHash: capture.snapshotHash,
      message,
    });
    const publishRemote = await readPublishRemote(root, 'origin');
    assert.ok(publishRemote);
    const push = {
      ...target,
      commitSha,
      remoteName: 'origin',
      expectedRemoteDigest: publishRemote.urlDigest,
    };

    // Someone else already published a different commit on the task branch: non-fast-forward.
    const other = join(directory, 'other clone');
    git(directory, 'clone', '--quiet', remote, other);
    writeFile(join(other, 'conflict.txt'), 'other\n');
    git(other, 'add', 'conflict.txt');
    git(other, 'commit', '--quiet', '-m', 'Other work');
    git(other, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    const remoteHead = git(remote, 'rev-parse', `refs/heads/${branch}`).trim();
    await assert.rejects(pushTaskBranch(push), rejectsWith('push_rejected_non_fast_forward'));
    assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`).trim(), remoteHead);
    assert.equal(git(root, 'rev-parse', `refs/heads/${branch}`).trim(), commitSha);
    git(remote, 'update-ref', '-d', `refs/heads/${branch}`);

    // The remote URL changed after approval.
    git(root, 'remote', 'set-url', '--push', 'origin', join(directory, 'elsewhere.git'));
    await assert.rejects(pushTaskBranch(push), rejectsWith('remote_changed'));
    git(root, 'config', '--unset', 'remote.origin.pushurl');

    // An unreachable remote (moved away) is reported; the push can be retried later.
    const moved = join(directory, 'moved.git');
    git(directory, 'clone', '--quiet', '--bare', remote, moved);
    rmSync(remote, { recursive: true, force: true });
    await assert.rejects(pushTaskBranch(push), rejectsWith('push_remote_unavailable'));
    assert.equal(git(root, 'rev-parse', `refs/heads/${branch}`).trim(), commitSha);

    // A missing remote and a branch that no longer points at the commit are refused before Git
    // contacts anything.
    await assert.rejects(
      pushTaskBranch({ ...push, remoteName: 'upstream' }),
      rejectsWith('remote_not_found'),
    );
    await assert.rejects(
      pushTaskBranch({ ...push, commitSha: target.baseCommit }),
      rejectsWith('branch_moved'),
    );
  });
});

test('a project without a remote has no publish destination', async () => {
  await withFixtures(async (directory) => {
    const { root } = await setUp(directory, { withRemote: false });
    assert.equal(await readPublishRemote(root, 'origin'), null);
    assert.equal(await readPublishRemote(root, '--upload-pack=x'), null);
  });
});
