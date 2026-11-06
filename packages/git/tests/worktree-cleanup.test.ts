import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createTaskWorktree,
  inspectTaskWorktree,
  inspectWorktreeForCleanup,
  relockTaskWorktree,
  removeTaskWorktree,
  TaskWorktreeError,
  type TaskWorktree,
} from '../src/index.js';
import { createRepository, git, snapshot, withFixtures, writeFile } from './fixtures.js';

// TM-02: the read-only cleanup inspection and the guarded removal, against disposable
// repositories with real task worktrees. "Published" means the task branch was advanced to a new
// commit in the worktree, as Approve & Push does; nothing is pushed here.

const taskA = '00000000-0000-4000-8000-00000000000a';
const taskB = '00000000-0000-4000-8000-00000000000b';

type Setup = { root: string; worktreeRoot: string };

const setUp = (directory: string): Setup => {
  const root = createRepository(join(directory, 'source repo'));
  writeFile(join(root, '.gitignore'), 'node_modules/\n.env\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '--quiet', '-m', 'Ignore build output');
  const worktreeRoot = join(directory, 'managed worktrees');
  mkdirSync(worktreeRoot);
  return { root, worktreeRoot: realpathSync(worktreeRoot) };
};

const recordOf = (worktree: TaskWorktree, worktreeRoot: string) => ({
  taskId: worktree.taskId,
  repositoryRoot: worktree.repository.root,
  gitCommonDir: worktree.repository.commonDir,
  worktreeRoot,
  path: worktree.path,
  branch: worktree.branch,
  baseBranch: worktree.baseBranch,
  baseSha: worktree.baseCommit,
});

/** Commits a result in the worktree, so the task branch points at a new commit. */
const publish = (worktree: TaskWorktree): string => {
  writeFile(join(worktree.path, 'feature.txt'), 'implemented\n');
  git(worktree.path, 'add', 'feature.txt');
  git(worktree.path, 'commit', '--quiet', '-m', 'Task result');
  return git(worktree.path, 'rev-parse', 'HEAD').trim();
};

const created = async ({ root, worktreeRoot }: Setup, taskId = taskA) =>
  createTaskWorktree({ repositoryPath: root, baseBranch: 'main', taskId, worktreeRoot });

const inspect = (setup: Setup, worktree: TaskWorktree, expectedCommit: string) =>
  inspectWorktreeForCleanup({
    repository: { localPath: setup.root, gitCommonDir: worktree.repository.commonDir },
    taskId: worktree.taskId,
    workspace: recordOf(worktree, setup.worktreeRoot),
    worktreeRoot: setup.worktreeRoot,
    expectedCommit,
  });

const checkoutFiles = (entries: Map<string, string>) =>
  [...entries].filter(([path]) => !path.startsWith('.git/'));

const targetOf = (worktree: TaskWorktree) => ({
  repositoryPath: worktree.repository.root,
  worktreePath: worktree.path,
  branchName: worktree.branch,
});

test('a clean published worktree is removable; removal keeps the branch, checkout and other worktrees', async () => {
  await withFixtures(async (directory) => {
    const setup = setUp(directory);
    const worktree = await created(setup);
    const other = await created(setup, taskB);
    writeFile(join(other.path, 'other.txt'), 'unrelated work\n');
    const commit = publish(worktree);
    writeFile(join(setup.root, 'operator.txt'), 'uncommitted operator work\n');
    const checkout = snapshot(setup.root);

    const inspection = await inspect(setup, worktree, commit);
    assert.equal(inspection.presence, 'present');
    assert.deepEqual(inspection.identity, { ok: true });
    assert.equal(inspection.managedLock, true);
    assert.equal(inspection.workingTree?.clean, true);
    assert.equal(inspection.ignoredCount, 0);
    assert.deepEqual(inspection.blockers, []);
    // Inspection is read-only.
    assert.deepEqual(snapshot(setup.root), checkout);

    const removed = await removeTaskWorktree({ ...targetOf(worktree), expectedCommit: commit });
    assert.equal(removed.branchCommit, commit);
    assert.equal(existsSync(worktree.path), false);
    assert.equal(git(setup.root, 'rev-parse', worktree.branch).trim(), commit);
    assert.equal(git(setup.root, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
    // The checkout's files are untouched; only Git's own worktree registration changed.
    assert.deepEqual(checkoutFiles(snapshot(setup.root)), checkoutFiles(checkout));
    assert.equal(readFileSync(join(other.path, 'other.txt'), 'utf8'), 'unrelated work\n');
    assert.equal((await inspectTaskWorktree(targetOf(other))).state, 'ready');

    const after = await inspect(setup, worktree, commit);
    assert.equal(after.presence, 'missing');
    assert.notDeepEqual(after.blockers, []);
  });
});

test('uncommitted, untracked and ignored files block removal and are preserved', async () => {
  await withFixtures(async (directory) => {
    const setup = setUp(directory);
    const worktree = await created(setup);
    const commit = publish(worktree);

    writeFile(join(worktree.path, 'feature.txt'), 'edited after publishing\n');
    let inspection = await inspect(setup, worktree, commit);
    assert.match(
      inspection.blockers.join('\n'),
      /uncommitted or untracked files \(1 changed path\)/,
    );
    await assert.rejects(
      removeTaskWorktree({ ...targetOf(worktree), expectedCommit: commit }),
      (error: unknown) => error instanceof TaskWorktreeError && error.code === 'WORKTREE_DIRTY',
    );
    git(worktree.path, 'checkout', '--', 'feature.txt');

    writeFile(join(worktree.path, 'notes.txt'), 'untracked\n');
    inspection = await inspect(setup, worktree, commit);
    assert.match(inspection.blockers.join('\n'), /1 untracked path/);
    await assert.rejects(removeTaskWorktree({ ...targetOf(worktree), expectedCommit: commit }));
    assert.equal(readFileSync(join(worktree.path, 'notes.txt'), 'utf8'), 'untracked\n');
    git(worktree.path, 'clean', '--quiet', '-f', '--', 'notes.txt');

    writeFile(join(worktree.path, '.env'), 'SECRET=1\n');
    inspection = await inspect(setup, worktree, commit);
    assert.equal(inspection.workingTree?.clean, true);
    assert.equal(inspection.ignoredCount, 1);
    assert.match(inspection.blockers.join('\n'), /1 Git-ignored path/);
    await assert.rejects(removeTaskWorktree({ ...targetOf(worktree), expectedCommit: commit }));
    assert.equal(readFileSync(join(worktree.path, '.env'), 'utf8'), 'SECRET=1\n');
  });
});

test('unexpected commits, a switched branch or a missing lock fail closed', async () => {
  await withFixtures(async (directory) => {
    const setup = setUp(directory);
    const worktree = await created(setup);
    const commit = publish(worktree);

    // A commit after the recorded one.
    writeFile(join(worktree.path, 'more.txt'), 'more\n');
    git(worktree.path, 'add', 'more.txt');
    git(worktree.path, 'commit', '--quiet', '-m', 'Unexpected');
    let inspection = await inspect(setup, worktree, commit);
    assert.equal(inspection.identity.ok, false);
    assert.match(inspection.blockers.join('\n'), /expected commit/);
    await assert.rejects(
      removeTaskWorktree({ ...targetOf(worktree), expectedCommit: commit }),
      (error: unknown) => error instanceof TaskWorktreeError && error.code === 'NOT_VERIFIED',
    );
    assert.ok(existsSync(join(worktree.path, 'more.txt')));
    git(worktree.path, 'reset', '--quiet', '--hard', commit);

    // Unlocked.
    git(setup.root, 'worktree', 'unlock', worktree.path);
    inspection = await inspect(setup, worktree, commit);
    assert.equal(inspection.locked, false);
    assert.equal(inspection.identity.ok, false);
    await assert.rejects(removeTaskWorktree({ ...targetOf(worktree), expectedCommit: commit }));
    assert.equal(await relockTaskWorktree(targetOf(worktree)), true);
    assert.deepEqual((await inspect(setup, worktree, commit)).blockers, []);

    // Switched to another branch.
    git(worktree.path, 'switch', '--quiet', '-c', 'elsewhere');
    inspection = await inspect(setup, worktree, commit);
    assert.equal(inspection.presence, 'inconsistent');
    assert.notDeepEqual(inspection.blockers, []);
    await assert.rejects(removeTaskWorktree({ ...targetOf(worktree), expectedCommit: commit }));
    // The narrow relock never touches a worktree with other problems.
    git(setup.root, 'worktree', 'unlock', worktree.path);
    assert.equal(await relockTaskWorktree(targetOf(worktree)), false);
    assert.ok(existsSync(worktree.path));
  });
});

test('a relocated worktree, another managed root or the main checkout is never accepted', async () => {
  await withFixtures(async (directory) => {
    const setup = setUp(directory);
    const worktree = await created(setup);
    const commit = publish(worktree);

    // The record names a different managed root than the one the worktree lives in.
    const elsewhere = join(directory, 'other root');
    mkdirSync(elsewhere);
    const foreignRoot = await inspectWorktreeForCleanup({
      repository: { localPath: setup.root, gitCommonDir: worktree.repository.commonDir },
      taskId: worktree.taskId,
      workspace: recordOf(worktree, setup.worktreeRoot),
      worktreeRoot: realpathSync(elsewhere),
      expectedCommit: commit,
    });
    assert.equal(foreignRoot.identity.ok, false);
    assert.notDeepEqual(foreignRoot.blockers, []);

    // The record claims the main checkout.
    const mainCheckout = await inspectWorktreeForCleanup({
      repository: { localPath: setup.root, gitCommonDir: worktree.repository.commonDir },
      taskId: worktree.taskId,
      workspace: { ...recordOf(worktree, setup.worktreeRoot), path: setup.root },
      worktreeRoot: setup.worktreeRoot,
      expectedCommit: commit,
    });
    assert.notDeepEqual(mainCheckout.blockers, []);
    await assert.rejects(
      removeTaskWorktree({
        ...targetOf(worktree),
        worktreePath: setup.root,
        expectedCommit: commit,
      }),
    );
    assert.ok(existsSync(join(setup.root, 'README.md')));

    // The worktree was moved by hand: the recorded location is missing.
    git(setup.root, 'worktree', 'unlock', worktree.path);
    const moved = join(directory, 'moved');
    git(setup.root, 'worktree', 'move', worktree.path, moved);
    const relocated = await inspect(setup, worktree, commit);
    assert.equal(relocated.presence, 'missing');
    assert.notDeepEqual(relocated.blockers, []);
    assert.ok(existsSync(join(moved, 'feature.txt')));
  });
});
