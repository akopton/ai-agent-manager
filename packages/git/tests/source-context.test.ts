import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  listIgnoredTrackedPaths,
  listSourceTree,
  readSourceBlob,
  resolveSourceSnapshot,
  searchSource,
  SourceContextError,
  verifySourceRepository,
} from '../src/source-context.js';
import { createRepository, git, snapshot, withFixtures, writeFile } from './fixtures.js';

// C4 — read-only source access: Git object reads of the checkout's HEAD commit only. Disposable
// repositories in temporary directories.

const identity = (root: string) => ({
  localPath: root,
  gitCommonDir: realpathSync(join(root, '.git')),
});

const createProjectRepository = (directory: string): string => {
  const root = createRepository(join(directory, 'project repo'));
  writeFile(join(root, 'src/worker.ts'), 'export const runQueuedTask = () => {\n  return 1;\n};\n');
  writeFile(join(root, 'src/Upper.ts'), 'const RUNQUEUEDTASK = 2;\n');
  writeFile(join(root, '-dash.txt'), '--flag literal\n');
  writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  writeFile(join(root, 'ignored.txt'), 'force added\n');
  symlinkSync('../../outside', join(root, 'src/link'));
  git(root, 'add', '--', 'src', '-dash.txt', '.gitignore');
  git(root, 'add', '-f', 'ignored.txt');
  git(root, 'commit', '--quiet', '-m', 'Project files');
  return root;
};

test('resolves the HEAD commit and branch of the registered checkout', async () => {
  await withFixtures(async (directory) => {
    const root = createProjectRepository(directory);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const resolved = await resolveSourceSnapshot(identity(root));
    assert.deepEqual(resolved, {
      root,
      commonDir: identity(root).gitCommonDir,
      commit: head,
      branch: 'main',
    });
    git(root, 'checkout', '--quiet', '--detach');
    assert.equal((await resolveSourceSnapshot(identity(root))).branch, null);
  });
});

test('fails closed for a missing, different, empty or linked-worktree checkout', async () => {
  await withFixtures(async (directory) => {
    const root = createProjectRepository(directory);
    const other = createRepository(join(directory, 'other repo'));
    const empty = createRepository(join(directory, 'empty repo'), { empty: true });
    const linked = join(directory, 'linked');
    git(root, 'worktree', 'add', '--quiet', '-b', 'task', linked);
    const code = async (expected: { localPath: string; gitCommonDir: string }) => {
      try {
        await resolveSourceSnapshot(expected);
        return 'ok';
      } catch (error) {
        assert.ok(error instanceof SourceContextError);
        return error.code;
      }
    };
    assert.equal(
      await code({ ...identity(root), localPath: join(directory, 'missing') }),
      'repository_unavailable',
    );
    assert.equal(
      await code({ localPath: other, gitCommonDir: identity(root).gitCommonDir }),
      'repository_unavailable',
    );
    assert.equal(await code(identity(empty)), 'no_commit');
    // A task worktree is never read as if it were the project's main checkout.
    assert.equal(
      await code({ localPath: realpathSync(linked), gitCommonDir: identity(root).gitCommonDir }),
      'repository_unavailable',
    );
    await assert.rejects(
      verifySourceRepository({ localPath: other, gitCommonDir: identity(root).gitCommonDir }),
    );
    assert.deepEqual(await verifySourceRepository(identity(root)), {
      root,
      commonDir: identity(root).gitCommonDir,
    });
  });
});

test('lists committed regular files only; symlinks and submodules are skipped', async () => {
  await withFixtures(async (directory) => {
    const root = createProjectRepository(directory);
    const subCommit = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${subCommit},vendor/sub`);
    git(root, 'commit', '--quiet', '-m', 'Submodule entry');
    writeFile(join(root, 'untracked.ts'), 'secret = 1\n');
    const resolved = await resolveSourceSnapshot(identity(root));
    const tree = await listSourceTree(resolved, { maxEntries: 1_000 });
    const paths = tree.files.map((entry) => entry.path).sort();
    assert.deepEqual(paths, [
      '-dash.txt',
      '.gitignore',
      'README.md',
      'ignored.txt',
      'src/Upper.ts',
      'src/worker.ts',
    ]);
    assert.deepEqual(tree.skipped.sort(), ['src/link', 'vendor/sub']);
    assert.equal(tree.total, 8);
    assert.equal(tree.truncated, false);
    const small = await listSourceTree(resolved, { maxEntries: 2 });
    assert.equal(small.files.length + small.skipped.length, 2);
    assert.equal(small.truncated, true);
    assert.deepEqual([...(await listIgnoredTrackedPaths(resolved))], ['ignored.txt']);
  });
});

test('reads committed content, not uncommitted edits, within the size limit', async () => {
  await withFixtures(async (directory) => {
    const root = createProjectRepository(directory);
    writeFileSync(join(root, 'src/worker.ts'), 'UNCOMMITTED EDIT\n');
    const resolved = await resolveSourceSnapshot(identity(root));
    const tree = await listSourceTree(resolved, { maxEntries: 1_000 });
    const worker = tree.files.find((entry) => entry.path === 'src/worker.ts');
    assert.ok(worker !== undefined);
    const content = (await readSourceBlob(resolved, worker, 1_000)).toString('utf8');
    assert.match(content, /runQueuedTask/);
    assert.doesNotMatch(content, /UNCOMMITTED/);
    await assert.rejects(
      readSourceBlob(resolved, worker, 10),
      (error: unknown) => error instanceof SourceContextError && error.code === 'read_failed',
    );
    await assert.rejects(readSourceBlob(resolved, { ...worker, oid: 'HEAD:src/worker.ts' }, 1_000));
  });
});

test('searches the commit literally and case-insensitively, unaffected by repository grep config', async () => {
  await withFixtures(async (directory) => {
    const root = createProjectRepository(directory);
    writeFileSync(
      join(root, 'src/worker.ts'),
      'runQueuedTask only in the working tree\n'.repeat(3),
    );
    git(root, 'config', 'grep.column', 'true');
    git(root, 'config', 'grep.fullName', 'true');
    git(root, 'config', 'grep.patternType', 'perl');
    const resolved = await resolveSourceSnapshot(identity(root));
    const result = await searchSource(resolved, 'runqueuedtask', {
      maxMatchesPerFile: 3,
      maxOutputBytes: 1_000_000,
    });
    assert.deepEqual(Object.fromEntries(result.matches), {
      'src/Upper.ts': [1],
      'src/worker.ts': [1],
    });
    const dash = await searchSource(resolved, '--flag', {
      maxMatchesPerFile: 3,
      maxOutputBytes: 1_000_000,
    });
    assert.deepEqual([...dash.matches.keys()], ['-dash.txt']);
    const regex = await searchSource(resolved, 'run.*Task', {
      maxMatchesPerFile: 3,
      maxOutputBytes: 1_000_000,
    });
    assert.equal(regex.matches.size, 0);
    const limited = await searchSource(resolved, 'e', { maxMatchesPerFile: 3, maxOutputBytes: 40 });
    assert.equal(limited.truncated, true);
    await assert.rejects(
      searchSource(resolved, 'a\nb', { maxMatchesPerFile: 1, maxOutputBytes: 100 }),
    );
  });
});

test('no read changes the repository, its index or Git metadata', async () => {
  await withFixtures(async (directory) => {
    const root = createProjectRepository(directory);
    writeFileSync(join(root, 'src/worker.ts'), 'dirty\n');
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes/untracked.md'), 'untracked\n');
    // Settle the index first: the fixture's own `git status` may refresh it.
    const statusBefore = git(root, 'status', '--porcelain=v2', '--branch');
    const before = snapshot(root);
    const resolved = await resolveSourceSnapshot(identity(root));
    const tree = await listSourceTree(resolved, { maxEntries: 1_000 });
    await listIgnoredTrackedPaths(resolved);
    for (const entry of tree.files) await readSourceBlob(resolved, entry, 100_000);
    await searchSource(resolved, 'task', { maxMatchesPerFile: 3, maxOutputBytes: 1_000_000 });
    await verifySourceRepository(identity(root));
    assert.deepEqual(snapshot(root), before);
    assert.equal(git(root, 'status', '--porcelain=v2', '--branch'), statusBefore);
    assert.match(statusBefore, /src\/worker\.ts/);
    assert.equal(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
  });
});
