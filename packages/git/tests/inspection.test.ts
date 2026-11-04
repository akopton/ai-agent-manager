import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  getHead,
  getWorkingTreeStatus,
  GitInputError,
  hasLocalBranch,
  inspectRepository,
  listBranches,
  listRemotes,
  redactRemoteUrl,
} from '../src/index.js';
import { createRepository, git, withFixtures, writeFile } from './fixtures.js';

const headCommit = (root: string): string => git(root, 'rev-parse', 'HEAD').trim();

test('reports attached, detached, and unborn HEAD states', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    const commit = headCommit(root);
    assert.deepEqual(await getHead(root), { kind: 'branch', branch: 'main', commit });
    assert.match(commit, /^[0-9a-f]{40}$/);

    git(root, 'checkout', '--quiet', '--detach');
    assert.deepEqual(await getHead(root), { kind: 'detached', commit });

    const empty = createRepository(join(directory, 'empty'), { empty: true });
    assert.deepEqual(await getHead(empty), { kind: 'unborn', branch: 'main', commit: null });
    assert.deepEqual(await listBranches(empty), []);
  });
});

test('lists local branches and checks base branch existence', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    const commit = headCommit(root);
    git(root, 'branch', 'feature/login');
    git(root, 'branch', 'release-1.0');
    git(root, 'update-ref', 'refs/remotes/origin/remote-only', commit);

    assert.deepEqual(await listBranches(root), [
      { name: 'feature/login', commit },
      { name: 'main', commit },
      { name: 'release-1.0', commit },
    ]);
    assert.equal(await hasLocalBranch(root, 'main'), true);
    assert.equal(await hasLocalBranch(root, 'feature/login'), true);
    assert.equal(await hasLocalBranch(root, 'missing'), false);
    assert.equal(await hasLocalBranch(root, 'remote-only'), false);
    for (const name of ['', '-main', 'a..b', 'has space', 'x.lock', 'a/.b', 'main^', '@', 'a//b']) {
      await assert.rejects(hasLocalBranch(root, name), GitInputError, name);
    }
  });
});

test('lists no remotes, then multiple remotes with push URLs and redacted credentials', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    assert.deepEqual(await listRemotes(root), []);

    const localRemote = join(directory, 'remote dir', 'origin.git');
    git(root, 'remote', 'add', 'origin', localRemote);
    git(root, 'remote', 'add', 'team.mirror', 'https://user:secret@git.example.com/team/repo.git');
    git(root, 'remote', 'set-url', '--push', 'origin', 'git@example.com:me/repo.git');
    git(root, 'remote', 'add', 'gitea', 'ssh://git@gitea.example.com:2222/me/repo.git');

    assert.deepEqual(await listRemotes(root), [
      { name: 'origin', fetchUrls: [localRemote], pushUrls: ['git@example.com:me/repo.git'] },
      {
        name: 'team.mirror',
        fetchUrls: ['https://***@git.example.com/team/repo.git'],
        pushUrls: [],
      },
      {
        name: 'gitea',
        fetchUrls: ['ssh://git@gitea.example.com:2222/me/repo.git'],
        pushUrls: [],
      },
    ]);
    assert.equal(redactRemoteUrl('https://ghp_token@github.com/a/b'), 'https://***@github.com/a/b');
    assert.equal(redactRemoteUrl('https://github.com/a/b'), 'https://github.com/a/b');
  });
});

test('reports clean, modified, staged, untracked, deleted, and unusual paths', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    writeFile(join(root, 'tracked.txt'), 'one\n');
    writeFile(join(root, 'remove me.txt'), 'gone\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'More files');
    assert.deepEqual(await getWorkingTreeStatus(root), {
      isClean: true,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    });

    writeFile(join(root, 'README.md'), 'modified\n');
    writeFile(join(root, 'tracked.txt'), 'staged\n');
    git(root, 'add', 'tracked.txt');
    writeFile(join(root, 'tracked.txt'), 'staged then modified\n');
    writeFile(join(root, 'new file.txt'), 'staged new\n');
    git(root, 'add', 'new file.txt');
    rmSync(join(root, 'remove me.txt'));
    const unusual = ['nested dir/inner file.txt', '-leading dash', 'line\nbreak', 'zażółć.txt'];
    for (const path of unusual) {
      writeFile(join(root, path), 'untracked\n');
    }

    const status = await getWorkingTreeStatus(root);
    assert.equal(status.isClean, false);
    assert.deepEqual(status.staged.sort(), ['new file.txt', 'tracked.txt']);
    assert.deepEqual(status.unstaged.sort(), ['README.md', 'remove me.txt', 'tracked.txt']);
    assert.deepEqual(status.untracked.sort(), [...unusual].sort());
    assert.deepEqual(status.conflicted, []);
  });
});

test('reports unresolved merge conflicts', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    git(root, 'checkout', '--quiet', '-b', 'other');
    writeFile(join(root, 'README.md'), 'other\n');
    git(root, 'commit', '--quiet', '-am', 'Other');
    git(root, 'checkout', '--quiet', 'main');
    writeFile(join(root, 'README.md'), 'main\n');
    git(root, 'commit', '--quiet', '-am', 'Main');
    assert.throws(() => git(root, 'merge', '--quiet', 'other'));
    const status = await getWorkingTreeStatus(root);
    assert.deepEqual(status.conflicted, ['README.md']);
    assert.equal(status.isClean, false);
  });
});

test('inspects a repository without remotes and a linked worktree independently', async () => {
  await withFixtures(async (directory) => {
    const main = createRepository(join(directory, 'main'));
    const linked = join(directory, 'task worktree');
    git(main, 'worktree', 'add', '--quiet', '-b', 'task/one', linked);
    writeFile(join(linked, 'work.txt'), 'agent output\n');

    const mainInspection = await inspectRepository(main);
    assert.ok(mainInspection.valid);
    assert.deepEqual(mainInspection.remotes, []);
    assert.equal(mainInspection.head.kind === 'branch' && mainInspection.head.branch, 'main');
    assert.equal(mainInspection.workingTree.isClean, true);

    const linkedInspection = await inspectRepository(linked);
    assert.ok(linkedInspection.valid);
    assert.equal(linkedInspection.repository.isLinkedWorktree, true);
    assert.equal(
      linkedInspection.head.kind === 'branch' && linkedInspection.head.branch,
      'task/one',
    );
    assert.deepEqual(
      linkedInspection.branches.map((branch) => branch.name),
      ['main', 'task/one'],
    );
    assert.deepEqual(linkedInspection.workingTree.untracked, ['work.txt']);

    const invalid = await inspectRepository(join(directory, 'missing'));
    assert.deepEqual(invalid, {
      valid: false,
      reason: 'not_found',
      message: 'The path does not exist.',
    });
  });
});
