import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createTaskWorktree,
  getWorkingTreeStatus,
  GitInputError,
  inspectTaskWorktree,
  removeTaskWorktree,
  TaskWorktreeError,
  type TaskWorktreeErrorCode,
} from '../src/index.js';
import { claimDestination, rollBackBranch, type DestinationClaim } from '../src/task-worktree.js';
import {
  createRepository,
  git,
  gitWithInput,
  snapshot,
  withFixtures,
  writeFile,
} from './fixtures.js';

const rejectsWith = (code: TaskWorktreeErrorCode) => (error: unknown) =>
  error instanceof TaskWorktreeError && error.code === code;

const branchExists = (root: string, branch: string): boolean => {
  try {
    git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

const repositoryKey = async (root: string): Promise<string> =>
  (
    await inspectTaskWorktree({
      repositoryPath: root,
      worktreePath: '/nonexistent/probe',
      branchName: 'probe',
    })
  ).repository.key;

/** Main repository with path spaces, plus a separate worktree root. */
const setUp = (directory: string) => ({
  root: createRepository(join(directory, 'my project')),
  worktreeRoot: join(directory, 'worktree root'),
});

test('creates a locked linked worktree on a new branch at the exact base commit', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    const baseCommit = git(root, 'rev-parse', 'main').trim();

    const worktree = await createTaskWorktree({
      repositoryPath: root,
      baseBranch: 'main',
      taskId: 'task-1',
      worktreeRoot,
    });

    const key = worktree.repository.key;
    assert.match(key, /^my-project-[0-9a-f]{12}$/);
    assert.deepEqual(worktree, {
      taskId: 'task-1',
      branch: 'agent/task-1',
      path: join(realpathSync(worktreeRoot), key, 'task-1'),
      baseBranch: 'main',
      baseCommit,
      repository: { root, commonDir: join(root, '.git'), key },
      lockReason: 'ai-agent-manager task worktree: agent/task-1',
    });
    assert.equal(git(root, 'rev-parse', 'agent/task-1').trim(), baseCommit);
    assert.equal(git(worktree.path, 'rev-parse', 'HEAD').trim(), baseCommit);
    assert.equal(git(worktree.path, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/agent/task-1');
    assert.equal(lstatSync(join(worktree.path, '.git')).isFile(), true);
    assert.equal(readFileSync(join(worktree.path, 'README.md'), 'utf8'), 'fixture\n');
    assert.match(git(root, 'worktree', 'list', '--porcelain'), /locked ai-agent-manager task/);
    // No upstream tracking config was written for the task branch.
    assert.throws(() => git(root, 'config', 'branch.agent/task-1.merge'));

    // A later task starts from the base branch's new local commit.
    writeFile(join(root, 'next.txt'), 'next\n');
    git(root, 'add', 'next.txt');
    git(root, 'commit', '--quiet', '-m', 'Advance main');
    const second = await createTaskWorktree({
      repositoryPath: root,
      baseBranch: 'main',
      taskId: 'task-2',
      branchName: 'feature/custom name',
      worktreeRoot,
    }).catch((error: unknown) => error);
    assert.ok(second instanceof GitInputError, 'branch names with spaces are rejected');
    const third = await createTaskWorktree({
      repositoryPath: root,
      baseBranch: 'main',
      taskId: 'task-2',
      branchName: 'feature/custom',
      worktreeRoot,
    });
    assert.equal(third.baseCommit, git(root, 'rev-parse', 'main').trim());
    assert.notEqual(third.baseCommit, baseCommit);
  });
});

test('leaves the main working tree, index, HEAD, and config unchanged, even when dirty', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    writeFile(join(root, 'staged.txt'), 'staged\n');
    git(root, 'add', 'staged.txt');
    writeFile(join(root, 'README.md'), 'modified in main\n');
    writeFile(join(root, 'untracked file.txt'), 'untracked\n');
    const statusBefore = await getWorkingTreeStatus(root);
    const filesBefore = snapshot(root);
    const ignoredGitMetadata = (path: string) =>
      path.startsWith('.git/worktrees') ||
      path.startsWith('.git/refs/heads/agent') ||
      path.startsWith('.git/logs');

    const worktree = await createTaskWorktree({
      repositoryPath: root,
      baseBranch: 'main',
      taskId: 'dirty-main',
      worktreeRoot,
    });

    const filesAfter = snapshot(root);
    for (const [path, value] of filesBefore) {
      assert.equal(filesAfter.get(path), value, path);
    }
    assert.deepEqual(
      [...filesAfter.keys()].filter((path) => !filesBefore.has(path) && !ignoredGitMetadata(path)),
      [],
    );
    assert.deepEqual(await getWorkingTreeStatus(root), statusBefore);
    assert.equal(git(root, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
    // The task worktree starts from the committed base, without the main tree's changes.
    assert.equal(readFileSync(join(worktree.path, 'README.md'), 'utf8'), 'fixture\n');
    assert.equal(existsSync(join(worktree.path, 'staged.txt')), false);
  });
});

test('rejects a missing base branch and invalid identifiers before creating anything', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    await assert.rejects(
      createTaskWorktree({
        repositoryPath: root,
        baseBranch: 'develop',
        taskId: 't',
        worktreeRoot,
      }),
      rejectsWith('BASE_BRANCH_NOT_FOUND'),
    );
    git(root, 'update-ref', 'refs/remotes/origin/remote-only', 'HEAD');
    await assert.rejects(
      createTaskWorktree({
        repositoryPath: root,
        baseBranch: 'remote-only',
        taskId: 't',
        worktreeRoot,
      }),
      rejectsWith('BASE_BRANCH_NOT_FOUND'),
    );

    for (const taskId of ['', 'Task-1', '../escape', 'a/b', '.hidden', '-x', 'x'.repeat(65)]) {
      await assert.rejects(
        createTaskWorktree({ repositoryPath: root, baseBranch: 'main', taskId, worktreeRoot }),
        GitInputError,
        taskId,
      );
    }
    for (const branchName of ['-x', 'a..b', 'bad name', 'x.lock', 'main', '../../x', 'a/.b']) {
      await assert.rejects(
        createTaskWorktree({
          repositoryPath: root,
          baseBranch: 'main',
          taskId: 'valid',
          branchName,
          worktreeRoot,
        }),
        GitInputError,
        branchName,
      );
    }
    await assert.rejects(
      createTaskWorktree({
        repositoryPath: root,
        baseBranch: 'main',
        taskId: 'valid',
        worktreeRoot: 'relative/root',
      }),
      GitInputError,
    );
    assert.equal(existsSync(worktreeRoot), false);
    assert.deepEqual(
      git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads').trim().split('\n'),
      ['refs/heads/main'],
    );
  });
});

test('rejects repositories that are not a main working tree', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    const options = { baseBranch: 'main', taskId: 'task', worktreeRoot };
    git(directory, 'init', '--quiet', '--bare', join(directory, 'bare.git'));
    mkdirSync(join(root, 'nested'));
    const linked = join(directory, 'linked');
    git(root, 'worktree', 'add', '--quiet', '-b', 'linked', linked);
    for (const repositoryPath of [
      join(directory, 'bare.git'),
      join(root, 'nested'),
      linked,
      join(directory, 'missing'),
    ]) {
      await assert.rejects(
        createTaskWorktree({ ...options, repositoryPath }),
        rejectsWith('INVALID_REPOSITORY'),
        repositoryPath,
      );
    }
  });
});

test('refuses existing task branches and destinations without touching them', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    const options = { repositoryPath: root, baseBranch: 'main', worktreeRoot };
    git(root, 'branch', 'agent/existing');
    const existingCommit = git(root, 'rev-parse', 'agent/existing').trim();
    await assert.rejects(
      createTaskWorktree({ ...options, taskId: 'existing' }),
      rejectsWith('BRANCH_EXISTS'),
    );
    assert.equal(git(root, 'rev-parse', 'agent/existing').trim(), existingCommit);

    const first = await createTaskWorktree({ ...options, taskId: 'first' });
    const repositoryDirectory = join(realpathSync(worktreeRoot), first.repository.key);
    const occupied = join(repositoryDirectory, 'occupied');
    writeFile(join(occupied, 'user file.txt'), 'keep me\n');
    await assert.rejects(
      createTaskWorktree({ ...options, taskId: 'occupied' }),
      rejectsWith('DESTINATION_EXISTS'),
    );
    assert.equal(readFileSync(join(occupied, 'user file.txt'), 'utf8'), 'keep me\n');
    assert.equal(branchExists(root, 'agent/occupied'), false);

    symlinkSync(join(directory, 'nowhere'), join(repositoryDirectory, 'dangling'));
    await assert.rejects(
      createTaskWorktree({ ...options, taskId: 'dangling' }),
      rejectsWith('DESTINATION_EXISTS'),
    );
    assert.equal(lstatSync(join(repositoryDirectory, 'dangling')).isSymbolicLink(), true);
  });
});

test('separates repositories with identical directory names', async () => {
  await withFixtures(async (directory) => {
    const worktreeRoot = join(directory, 'worktrees');
    const first = createRepository(join(directory, 'one', 'app'));
    const second = createRepository(join(directory, 'two', 'app'));
    const a = await createTaskWorktree({
      repositoryPath: first,
      baseBranch: 'main',
      taskId: 'task-1',
      worktreeRoot,
    });
    const b = await createTaskWorktree({
      repositoryPath: second,
      baseBranch: 'main',
      taskId: 'task-1',
      worktreeRoot,
    });
    assert.notEqual(a.repository.key, b.repository.key);
    assert.match(a.repository.key, /^app-/);
    assert.notEqual(a.path, b.path);
    assert.deepEqual(readdirSync(worktreeRoot).sort(), [a.repository.key, b.repository.key].sort());
  });
});

test('rejects symlinked repository directories and worktree roots inside the repository', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    const options = { repositoryPath: root, baseBranch: 'main', taskId: 'task' };
    const key = await repositoryKey(root);

    const elsewhere = join(directory, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(worktreeRoot);
    symlinkSync(elsewhere, join(worktreeRoot, key));
    await assert.rejects(
      createTaskWorktree({ ...options, worktreeRoot }),
      rejectsWith('UNSAFE_PATH'),
    );
    assert.deepEqual(readdirSync(elsewhere), []);

    for (const insideRoot of [join(root, '.worktrees'), join(root, '.git', 'task-worktrees')]) {
      await assert.rejects(
        createTaskWorktree({ ...options, worktreeRoot: insideRoot }),
        rejectsWith('UNSAFE_PATH'),
        insideRoot,
      );
    }
    assert.equal(branchExists(root, 'agent/task'), false);

    // A symlinked worktree root is resolved to its canonical location.
    const realRoot = join(directory, 'real root');
    mkdirSync(realRoot);
    symlinkSync(realRoot, join(directory, 'root link'));
    const created = await createTaskWorktree({
      ...options,
      worktreeRoot: join(directory, 'root link'),
    });
    assert.equal(created.path, join(realRoot, created.repository.key, 'task'));
  });
});

test('does not run repository hooks, fsmonitor, or filters while creating or removing', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    writeFile(join(root, '.gitattributes'), '*.dat filter=probe\n');
    writeFile(join(root, 'payload.dat'), 'raw\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'Filtered payload');

    // Installed after the fixture commits so that only the code under test could trigger them.
    const markers = join(directory, 'markers');
    mkdirSync(markers);
    const hook = `#!/bin/sh\ntouch "${markers}/$(basename "$0")"\n`;
    const customHooks = join(directory, 'custom hooks');
    for (const hooksDirectory of [join(root, '.git', 'hooks'), customHooks]) {
      for (const name of ['post-checkout', 'reference-transaction', 'post-index-change']) {
        writeFile(join(hooksDirectory, name), hook);
        chmodSync(join(hooksDirectory, name), 0o755);
      }
    }
    git(root, 'config', 'filter.probe.smudge', `touch "${markers}/smudge"; cat`);
    git(root, 'config', 'filter.probe.clean', `touch "${markers}/clean"; cat`);
    git(root, 'config', 'filter.probe.required', 'true');
    git(root, 'config', 'core.fsmonitor', `touch "${markers}/fsmonitor"; false`);

    const create = (taskId: string) =>
      createTaskWorktree({ repositoryPath: root, baseBranch: 'main', taskId, worktreeRoot });
    const remove = (worktree: { path: string; branch: string }) =>
      removeTaskWorktree({
        repositoryPath: root,
        worktreePath: worktree.path,
        branchName: worktree.branch,
      });

    const defaultHooks = await create('default-hooks');
    // Filters were not applied: the checked-out file is the raw blob.
    assert.equal(readFileSync(join(defaultHooks.path, 'payload.dat'), 'utf8'), 'raw\n');
    await remove(defaultHooks);

    git(root, 'config', 'core.hooksPath', customHooks);
    await remove(await create('configured-hooks'));

    assert.deepEqual(readdirSync(markers), []);

    // Control: plain Git in the same repository does run them.
    git(root, 'worktree', 'add', '--quiet', '-b', 'control', join(directory, 'control'));
    assert.deepEqual(readdirSync(markers).sort(), [
      'fsmonitor',
      'post-checkout',
      'post-index-change',
      'reference-transaction',
      'smudge',
    ]);
  });
});

test('inspects ready, absent, branch-only, and mismatched worktrees', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    const other = createRepository(join(directory, 'other'));
    const worktree = await createTaskWorktree({
      repositoryPath: root,
      baseBranch: 'main',
      taskId: 'inspect',
      worktreeRoot,
    });
    const target = {
      repositoryPath: root,
      worktreePath: worktree.path,
      branchName: worktree.branch,
    };

    const ready = await inspectTaskWorktree(target);
    assert.equal(ready.state, 'ready');
    assert.deepEqual(ready.issues, []);
    assert.deepEqual(ready.head, {
      kind: 'branch',
      branch: 'agent/inspect',
      commit: worktree.baseCommit,
    });
    assert.equal(ready.workingTree?.isClean, true);
    assert.equal(ready.locked, true);

    writeFile(join(worktree.path, 'agent output.txt'), 'work\n');
    const dirty = await inspectTaskWorktree(target);
    assert.equal(dirty.state, 'ready');
    assert.deepEqual(dirty.workingTree?.untracked, ['agent output.txt']);

    const wrongBranch = await inspectTaskWorktree({ ...target, branchName: 'agent/other' });
    assert.equal(wrongBranch.state, 'inconsistent');
    assert.ok(wrongBranch.issues.includes('branch_mismatch'));
    assert.ok(wrongBranch.issues.includes('lock_reason_mismatch'));
    assert.ok(wrongBranch.issues.includes('branch_missing'));

    const wrongRepository = await inspectTaskWorktree({ ...target, repositoryPath: other });
    assert.equal(wrongRepository.state, 'inconsistent');
    assert.ok(wrongRepository.issues.includes('not_registered'));
    assert.ok(wrongRepository.issues.includes('different_repository'));

    const absent = await inspectTaskWorktree({
      ...target,
      worktreePath: join(directory, 'none'),
      branchName: 'agent/none',
    });
    assert.equal(absent.state, 'absent');

    git(root, 'branch', 'agent/interrupted');
    const branchOnly = await inspectTaskWorktree({
      ...target,
      worktreePath: join(directory, 'interrupted'),
      branchName: 'agent/interrupted',
    });
    assert.equal(branchOnly.state, 'branch_only');

    const main = await inspectTaskWorktree({ ...target, worktreePath: root, branchName: 'main' });
    assert.equal(main.state, 'inconsistent');
    assert.ok(main.issues.includes('main_worktree'));
  });
});

test('removes a clean worktree and preserves its branch, including new commits', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    const worktree = await createTaskWorktree({
      repositoryPath: root,
      baseBranch: 'main',
      taskId: 'done',
      worktreeRoot,
    });
    writeFile(join(worktree.path, 'result.txt'), 'result\n');
    git(worktree.path, 'add', 'result.txt');
    git(worktree.path, 'commit', '--quiet', '-m', 'Agent result');
    const agentCommit = git(worktree.path, 'rev-parse', 'HEAD').trim();

    const target = {
      repositoryPath: root,
      worktreePath: worktree.path,
      branchName: worktree.branch,
    };
    assert.deepEqual(await removeTaskWorktree(target), {
      path: worktree.path,
      branch: 'agent/done',
      branchCommit: agentCommit,
    });
    assert.equal(existsSync(worktree.path), false);
    assert.doesNotMatch(git(root, 'worktree', 'list', '--porcelain'), /agent\/done/);
    assert.equal(git(root, 'rev-parse', 'agent/done').trim(), agentCommit);
    assert.equal((await inspectTaskWorktree(target)).state, 'branch_only');
    assert.equal(git(root, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
  });
});

test('refuses to remove dirty worktrees and preserves their changes and lock', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    writeFile(join(root, '.gitignore'), '.env\n');
    git(root, 'add', '.gitignore');
    git(root, 'commit', '--quiet', '-m', 'Ignore env');
    const create = (taskId: string) =>
      createTaskWorktree({ repositoryPath: root, baseBranch: 'main', taskId, worktreeRoot });
    const targetOf = (worktree: { path: string; branch: string }) => ({
      repositoryPath: root,
      worktreePath: worktree.path,
      branchName: worktree.branch,
    });

    const modified = await create('modified');
    writeFile(join(modified.path, 'README.md'), 'changed\n');
    const staged = await create('staged');
    writeFile(join(staged.path, 'new.txt'), 'new\n');
    git(staged.path, 'add', 'new.txt');
    const untracked = await create('untracked');
    writeFile(join(untracked.path, 'notes', 'todo.txt'), 'todo\n');
    const ignored = await create('ignored');
    writeFile(join(ignored.path, '.env'), 'SECRET=1\n');

    for (const worktree of [modified, staged, untracked, ignored]) {
      await assert.rejects(
        removeTaskWorktree(targetOf(worktree)),
        rejectsWith('WORKTREE_DIRTY'),
        worktree.taskId,
      );
      const inspection = await inspectTaskWorktree(targetOf(worktree));
      assert.equal(inspection.state, 'ready', worktree.taskId);
      assert.equal(inspection.locked, true);
    }
    assert.equal(readFileSync(join(modified.path, 'README.md'), 'utf8'), 'changed\n');
    assert.equal(readFileSync(join(untracked.path, 'notes', 'todo.txt'), 'utf8'), 'todo\n');
    assert.equal(readFileSync(join(ignored.path, '.env'), 'utf8'), 'SECRET=1\n');

    await removeTaskWorktree({ ...targetOf(ignored), allowIgnoredFiles: true });
    assert.equal(existsSync(ignored.path), false);
  });
});

test('refuses to remove the main, unrelated, unlocked, symlinked, or broken worktrees', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    const before = snapshot(root);
    await assert.rejects(
      removeTaskWorktree({ repositoryPath: root, worktreePath: root, branchName: 'main' }),
      (error: unknown) =>
        error instanceof TaskWorktreeError &&
        error.code === 'NOT_VERIFIED' &&
        error.inspection?.issues.includes('main_worktree') === true,
    );
    assert.deepEqual(snapshot(root), before);

    const manual = join(directory, 'manual worktree');
    git(root, 'worktree', 'add', '--quiet', '-b', 'agent/manual', manual);
    await assert.rejects(
      removeTaskWorktree({
        repositoryPath: root,
        worktreePath: manual,
        branchName: 'agent/manual',
      }),
      rejectsWith('NOT_VERIFIED'),
    );
    assert.equal(existsSync(manual), true);

    const worktree = await createTaskWorktree({
      repositoryPath: root,
      baseBranch: 'main',
      taskId: 'managed',
      worktreeRoot,
    });
    const target = {
      repositoryPath: root,
      worktreePath: worktree.path,
      branchName: worktree.branch,
    };

    const link = join(directory, 'link to worktree');
    symlinkSync(worktree.path, link);
    await assert.rejects(
      removeTaskWorktree({ ...target, worktreePath: link }),
      rejectsWith('NOT_VERIFIED'),
    );

    git(root, 'worktree', 'unlock', worktree.path);
    git(root, 'worktree', 'lock', '--reason', 'kept by user', worktree.path);
    await assert.rejects(removeTaskWorktree(target), rejectsWith('NOT_VERIFIED'));
    git(root, 'worktree', 'unlock', worktree.path);
    await assert.rejects(removeTaskWorktree(target), rejectsWith('NOT_VERIFIED'));
    assert.equal(existsSync(worktree.path), true);
    assert.equal(branchExists(root, worktree.branch), true);
  });
});

test('reports interrupted states and never reuses them', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    const worktree = await createTaskWorktree({
      repositoryPath: root,
      baseBranch: 'main',
      taskId: 'interrupted',
      worktreeRoot,
    });
    const target = {
      repositoryPath: root,
      worktreePath: worktree.path,
      branchName: worktree.branch,
    };

    // The directory disappeared while Git still has it registered (for example, an interrupted
    // cleanup). Inspection reports it; removal and re-creation refuse.
    rmSync(worktree.path, { recursive: true, force: true });
    const missing = await inspectTaskWorktree(target);
    assert.equal(missing.state, 'inconsistent');
    assert.ok(missing.issues.includes('path_missing'));
    await assert.rejects(removeTaskWorktree(target), rejectsWith('NOT_VERIFIED'));
    await assert.rejects(
      createTaskWorktree({
        repositoryPath: root,
        baseBranch: 'main',
        taskId: 'interrupted',
        branchName: 'agent/retry',
        worktreeRoot,
      }),
      rejectsWith('DESTINATION_EXISTS'),
    );

    // A leftover directory that Git does not know about.
    const leftover = join(realpathSync(worktreeRoot), worktree.repository.key, 'leftover');
    writeFile(join(leftover, 'partial.txt'), 'partial\n');
    git(root, 'branch', 'agent/leftover');
    const unregistered = await inspectTaskWorktree({
      ...target,
      worktreePath: leftover,
      branchName: 'agent/leftover',
    });
    assert.equal(unregistered.state, 'inconsistent');
    assert.ok(unregistered.issues.includes('not_registered'));
    assert.equal(readFileSync(join(leftover, 'partial.txt'), 'utf8'), 'partial\n');
  });
});

test('rolls back only the branch it created when git worktree add fails', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    // A base commit whose checkout fails: the file name exceeds the filesystem limit.
    const blob = git(root, 'hash-object', '-w', 'README.md').trim();
    const longTree = gitWithInput(
      root,
      `100644 blob ${blob}\t${'a'.repeat(300)}\n`,
      'mktree',
    ).trim();
    const commit = git(root, 'commit-tree', longTree, '-p', 'HEAD', '-m', 'Unrepresentable').trim();
    git(root, 'update-ref', 'refs/heads/broken', commit);
    const before = snapshot(root);

    await assert.rejects(
      createTaskWorktree({
        repositoryPath: root,
        baseBranch: 'broken',
        taskId: 'fails',
        worktreeRoot,
      }),
      (error: unknown) =>
        error instanceof TaskWorktreeError &&
        error.code === 'CREATE_FAILED' &&
        error.cause !== undefined,
    );
    assert.equal(branchExists(root, 'agent/fails'), false);
    assert.doesNotMatch(git(root, 'worktree', 'list', '--porcelain'), /fails/);
    // The claimed destination was released; the shared repository directory is kept, empty.
    const key = await repositoryKey(root);
    assert.deepEqual(readdirSync(worktreeRoot), [key]);
    assert.deepEqual(readdirSync(join(worktreeRoot, key)), []);
    const after = snapshot(root);
    for (const [path, value] of before) {
      if (!path.startsWith('.git/logs') && !path.startsWith('.git/refs')) {
        assert.equal(after.get(path), value, path);
      }
    }
  });
});

test('claims the destination atomically and never adopts an existing directory', async () => {
  await withFixtures(async (directory) => {
    // An empty directory is exactly what `git worktree add` would silently adopt.
    const empty = join(directory, 'empty');
    mkdirSync(empty);
    const identity = lstatSync(empty, { bigint: true }).ino;
    await assert.rejects(claimDestination(empty), rejectsWith('DESTINATION_EXISTS'));
    assert.equal(lstatSync(empty, { bigint: true }).ino, identity);

    symlinkSync(join(directory, 'nowhere'), join(directory, 'dangling'));
    await assert.rejects(
      claimDestination(join(directory, 'dangling')),
      rejectsWith('DESTINATION_EXISTS'),
    );
    writeFile(join(directory, 'file'), 'file\n');
    await assert.rejects(
      claimDestination(join(directory, 'file')),
      rejectsWith('DESTINATION_EXISTS'),
    );

    const claim = await claimDestination(join(directory, 'claimed'));
    assert.equal(lstatSync(claim.path).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(claim.path), []);
    // A second, concurrent claim of the same path loses.
    await assert.rejects(claimDestination(claim.path), rejectsWith('DESTINATION_EXISTS'));
  });
});

test('refuses a destination created by another process, empty or not', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    const key = await repositoryKey(root);
    const destination = join(worktreeRoot, key, 'task');
    mkdirSync(destination, { recursive: true });
    const identity = lstatSync(destination, { bigint: true }).ino;

    await assert.rejects(
      createTaskWorktree({
        repositoryPath: root,
        baseBranch: 'main',
        taskId: 'task',
        worktreeRoot,
      }),
      rejectsWith('DESTINATION_EXISTS'),
    );
    assert.equal(lstatSync(destination, { bigint: true }).ino, identity);
    assert.deepEqual(readdirSync(destination), []);
    assert.equal(branchExists(root, 'agent/task'), false);
    assert.doesNotMatch(git(root, 'worktree', 'list', '--porcelain'), /agent\/task/);
  });
});

test('lets exactly one of several concurrent creations of the same task win', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    for (let round = 0; round < 3; round += 1) {
      const taskId = `same-${round}`;
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          createTaskWorktree({ repositoryPath: root, baseBranch: 'main', taskId, worktreeRoot }),
        ),
      );
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      assert.equal(fulfilled.length, 1, `round ${round}`);
      for (const result of results) {
        if (result.status === 'rejected') {
          assert.ok(
            result.reason instanceof TaskWorktreeError &&
              ['DESTINATION_EXISTS', 'BRANCH_EXISTS'].includes(result.reason.code),
            String(result.reason),
          );
        }
      }
      const winner = fulfilled[0]?.status === 'fulfilled' ? fulfilled[0].value : undefined;
      assert.ok(winner);
      const inspection = await inspectTaskWorktree({
        repositoryPath: root,
        worktreePath: winner.path,
        branchName: winner.branch,
      });
      assert.equal(inspection.state, 'ready');
    }
  });
});

test('releases only its own claim when another creation takes the same branch', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    for (let round = 0; round < 3; round += 1) {
      const branchName = `agent/shared-${round}`;
      const taskIds = ['a', 'b', 'c', 'd'].map((suffix) => `shared-${round}-${suffix}`);
      const results = await Promise.allSettled(
        taskIds.map((taskId) =>
          createTaskWorktree({
            repositoryPath: root,
            baseBranch: 'main',
            taskId,
            branchName,
            worktreeRoot,
          }),
        ),
      );
      const winners = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      assert.equal(winners.length, 1, `round ${round}`);
      for (const result of results) {
        if (result.status === 'rejected') {
          assert.ok(
            result.reason instanceof TaskWorktreeError && result.reason.code === 'BRANCH_EXISTS',
            String(result.reason),
          );
        }
      }
      // Losing attempts released their claimed directories; only the winner's remains.
      const repositoryDirectory = join(
        realpathSync(worktreeRoot),
        winners[0]?.repository.key ?? '',
      );
      assert.deepEqual(
        readdirSync(repositoryDirectory).filter((name) => name.startsWith(`shared-${round}-`)),
        [winners[0]?.taskId],
      );
    }
  });
});

test('creates the shared repository directory safely under concurrency', async () => {
  await withFixtures(async (directory) => {
    const { root, worktreeRoot } = setUp(directory);
    const results = await Promise.allSettled(
      ['one', 'two', 'three', 'four'].map((taskId) =>
        createTaskWorktree({ repositoryPath: root, baseBranch: 'main', taskId, worktreeRoot }),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
    );
  });
});

test('rollback preserves resources unless both the claim and the branch are provably owned', async () => {
  await withFixtures(async (directory) => {
    const { root } = setUp(directory);
    const repository = { root, commonDir: join(root, '.git'), key: await repositoryKey(root) };
    const baseCommit = git(root, 'rev-parse', 'HEAD').trim();
    const cause = new Error('worktree add failed');
    const rollBack = (branch: string, claim: DestinationClaim) =>
      rollBackBranch(repository, branch, baseCommit, claim, cause, {});

    // Another process wrote into the claimed directory: preserve the directory and branch.
    git(root, 'branch', 'agent/written');
    const written = await claimDestination(join(directory, 'written'));
    writeFile(join(written.path, 'foreign.txt'), 'foreign\n');
    await assert.rejects(
      rollBack('agent/written', written),
      (error: unknown) =>
        error instanceof TaskWorktreeError &&
        error.code === 'RECOVERY_REQUIRED' &&
        error.recovery?.pathExists === true &&
        error.recovery.branchCommit === baseCommit,
    );
    assert.equal(readFileSync(join(written.path, 'foreign.txt'), 'utf8'), 'foreign\n');
    assert.equal(branchExists(root, 'agent/written'), true);

    // The claimed directory was replaced by another process's (empty) directory.
    git(root, 'branch', 'agent/swapped');
    const swapped = await claimDestination(join(directory, 'swapped'));
    rmdirSync(swapped.path);
    mkdirSync(swapped.path);
    await assert.rejects(rollBack('agent/swapped', swapped), rejectsWith('RECOVERY_REQUIRED'));
    assert.equal(existsSync(swapped.path), true);
    assert.equal(branchExists(root, 'agent/swapped'), true);

    // The branch moved to another commit: it is no longer definitely ours.
    writeFile(join(root, 'other.txt'), 'other\n');
    git(root, 'add', 'other.txt');
    git(root, 'commit', '--quiet', '-m', 'Other');
    git(root, 'branch', 'agent/moved');
    const moved = await claimDestination(join(directory, 'moved'));
    await assert.rejects(rollBack('agent/moved', moved), rejectsWith('RECOVERY_REQUIRED'));
    assert.equal(branchExists(root, 'agent/moved'), true);
    assert.equal(existsSync(moved.path), true);

    // The branch is checked out in another worktree.
    git(root, 'branch', 'agent/used', baseCommit);
    git(root, 'worktree', 'add', '--quiet', join(directory, 'used'), 'agent/used');
    const used = await claimDestination(join(directory, 'used claim'));
    await assert.rejects(rollBack('agent/used', used), rejectsWith('RECOVERY_REQUIRED'));
    assert.equal(branchExists(root, 'agent/used'), true);

    // Owned and unreferenced, with the empty claim still present (Git normally removes it):
    // the claim and the branch are both rolled back.
    git(root, 'branch', 'agent/owned', baseCommit);
    const owned = await claimDestination(join(directory, 'owned'));
    await assert.rejects(rollBack('agent/owned', owned), rejectsWith('CREATE_FAILED'));
    assert.equal(branchExists(root, 'agent/owned'), false);
    assert.equal(existsSync(owned.path), false);

    // Owned, and Git already removed the claimed directory.
    git(root, 'branch', 'agent/cleaned', baseCommit);
    const cleaned = await claimDestination(join(directory, 'cleaned'));
    rmdirSync(cleaned.path);
    await assert.rejects(rollBack('agent/cleaned', cleaned), rejectsWith('CREATE_FAILED'));
    assert.equal(branchExists(root, 'agent/cleaned'), false);
  });
});
