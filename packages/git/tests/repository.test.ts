import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateRepository } from '../src/index.js';
import { createRepository, git, withFixtures, writeFile } from './fixtures.js';

test('accepts a normal repository root whose path contains spaces', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'my project'));
    assert.deepEqual(await validateRepository(root), {
      valid: true,
      repository: {
        path: root,
        root,
        isRoot: true,
        gitDir: join(root, '.git'),
        commonDir: join(root, '.git'),
        isLinkedWorktree: false,
      },
    });
  });
});

test('rejects invalid, missing, and non-directory paths without running Git', async () => {
  await withFixtures(async (directory) => {
    for (const path of ['', 'relative/path', '/bad\0path']) {
      const result = await validateRepository(path);
      assert.equal(result.valid, false);
      assert.equal(result.valid === false && result.reason, 'invalid_path');
    }
    const missing = await validateRepository(join(directory, 'missing'));
    assert.equal(missing.valid === false && missing.reason, 'not_found');

    const file = join(directory, 'file.txt');
    writeFile(file, 'not a directory');
    const notDirectory = await validateRepository(file);
    assert.equal(notDirectory.valid === false && notDirectory.reason, 'not_directory');
    const belowFile = await validateRepository(join(file, 'child'));
    assert.equal(belowFile.valid === false && belowFile.reason, 'not_found');
  });
});

test('rejects an existing directory that is not a Git repository', async () => {
  await withFixtures(async (directory) => {
    const plain = join(directory, 'plain dir');
    mkdirSync(plain);
    const result = await validateRepository(plain);
    assert.equal(result.valid === false && result.reason, 'not_git_repository');
  });
});

test('reports nested paths with their root unless nested paths are explicitly allowed', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    const nested = join(root, 'src', 'deep dir');
    mkdirSync(nested, { recursive: true });

    assert.deepEqual(await validateRepository(nested), {
      valid: false,
      reason: 'not_repository_root',
      message: 'The path is inside a Git working tree but is not its root.',
      root,
    });

    const allowed = await validateRepository(nested, { allowNestedPath: true });
    assert.ok(allowed.valid);
    assert.equal(allowed.repository.path, nested);
    assert.equal(allowed.repository.root, root);
    assert.equal(allowed.repository.isRoot, false);
  });
});

test('rejects bare repositories and paths inside Git metadata', async () => {
  await withFixtures(async (directory) => {
    const bare = join(directory, 'origin.git');
    git(directory, 'init', '--quiet', '--bare', bare);
    const bareResult = await validateRepository(bare);
    assert.equal(bareResult.valid === false && bareResult.reason, 'bare_repository');

    const root = createRepository(join(directory, 'repo'));
    const metadata = await validateRepository(join(root, '.git'));
    assert.equal(metadata.valid === false && metadata.reason, 'inside_git_directory');
  });
});

test('identifies a linked worktree whose .git is a file and reports the shared common dir', async () => {
  await withFixtures(async (directory) => {
    const main = createRepository(join(directory, 'main repo'));
    const linkedPath = join(directory, 'linked worktree');
    git(main, 'worktree', 'add', '--quiet', '-b', 'task/one', linkedPath);
    assert.equal(lstatSync(join(linkedPath, '.git')).isFile(), true);

    const result = await validateRepository(linkedPath);
    assert.ok(result.valid);
    assert.equal(result.repository.root, linkedPath);
    assert.equal(result.repository.isLinkedWorktree, true);
    assert.equal(result.repository.commonDir, join(main, '.git'));
    // Git derives the worktree's admin directory name from the path, replacing spaces.
    assert.equal(result.repository.gitDir, join(main, '.git', 'worktrees', 'linked-worktree'));

    const mainResult = await validateRepository(main);
    assert.equal(mainResult.valid && mainResult.repository.isLinkedWorktree, false);
  });
});

test('canonicalizes a symlinked repository path', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    const link = join(directory, 'link to repo');
    symlinkSync(root, link);
    const result = await validateRepository(link);
    assert.ok(result.valid);
    assert.equal(result.repository.path, root);
    assert.equal(result.repository.isRoot, true);
  });
});
