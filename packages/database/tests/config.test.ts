import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ensureWorktreeRoot,
  initializeDataRoot,
  resolveDatabasePath,
  resolveRuntimePaths,
  RuntimeConfigError,
} from '../src/index.js';

const home = '/Users/test user';
const applicationSupport = join(home, 'Library', 'Application Support', 'ai-agent-manager');

const resolve = (environment: Record<string, string | undefined>) =>
  resolveRuntimePaths({ environment, homeDirectory: home });

const withTemporaryDirectory = (run: (directory: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager config-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('defaults every path under the macOS application data directory of the given home', () => {
  assert.deepEqual(resolve({}), {
    dataRoot: applicationSupport,
    databasePath: join(applicationSupport, 'database.sqlite'),
    worktreeRoot: join(applicationSupport, 'worktrees'),
  });
  assert.equal(Object.isFrozen(resolve({})), true);
});

test('derives the database and worktree defaults from a custom data root', () => {
  assert.deepEqual(resolve({ AI_AGENT_MANAGER_DATA_ROOT: '/Volumes/Data Disk/agent manager/' }), {
    dataRoot: '/Volumes/Data Disk/agent manager',
    databasePath: '/Volumes/Data Disk/agent manager/database.sqlite',
    worktreeRoot: '/Volumes/Data Disk/agent manager/worktrees',
  });
  assert.equal(
    resolve({ AI_AGENT_MANAGER_DATA_ROOT: '~/App Data/../agent-data' }).dataRoot,
    join(home, 'agent-data'),
  );
});

test('accepts a custom worktree root such as a development directory beside repositories', () => {
  const paths = resolve({ AI_AGENT_MANAGER_WORKTREE_ROOT: '~/repos/.agent-worktrees' });
  assert.equal(paths.worktreeRoot, join(home, 'repos', '.agent-worktrees'));
  assert.equal(paths.dataRoot, applicationSupport);
});

test('keeps the existing database path override and gives it precedence over the data root', () => {
  const environment = {
    AI_AGENT_MANAGER_DATA_ROOT: '/srv/agent data',
    AI_AGENT_MANAGER_DATABASE_PATH: '/tmp/other db/database.sqlite',
    AI_AGENT_MANAGER_WORKTREE_ROOT: '/srv/worktrees',
  };
  assert.deepEqual(resolve(environment), {
    dataRoot: '/srv/agent data',
    databasePath: '/tmp/other db/database.sqlite',
    worktreeRoot: '/srv/worktrees',
  });
  assert.equal(resolveDatabasePath(environment, home), '/tmp/other db/database.sqlite');
  assert.equal(
    resolveDatabasePath({ AI_AGENT_MANAGER_DATA_ROOT: '/srv/agent data' }, home),
    '/srv/agent data/database.sqlite',
  );
  assert.equal(
    resolveDatabasePath({ AI_AGENT_MANAGER_DATABASE_PATH: '~/db.sqlite' }, home),
    join(home, 'db.sqlite'),
  );
});

test('rejects empty, relative, and malformed values with the variable name', () => {
  for (const name of [
    'AI_AGENT_MANAGER_DATA_ROOT',
    'AI_AGENT_MANAGER_DATABASE_PATH',
    'AI_AGENT_MANAGER_WORKTREE_ROOT',
  ]) {
    for (const value of ['', '   ', 'relative/path', '~', '~user/data', ':memory:', '/bad\0path']) {
      assert.throws(
        () => resolve({ [name]: value }),
        (error: unknown) => error instanceof RuntimeConfigError && error.message.startsWith(name),
        `${name}=${JSON.stringify(value)}`,
      );
    }
  }
});

test('rejects managed roots that are the home directory, filesystem root, or their parents', () => {
  for (const name of ['AI_AGENT_MANAGER_DATA_ROOT', 'AI_AGENT_MANAGER_WORKTREE_ROOT']) {
    for (const value of ['/', '/Users', home, '~/', `${home}/repos/..`]) {
      assert.throws(() => resolve({ [name]: value }), RuntimeConfigError, `${name}=${value}`);
    }
  }
});

test('keeps application data out of the worktree root', () => {
  assert.throws(
    () => resolve({ AI_AGENT_MANAGER_DATA_ROOT: '/data', AI_AGENT_MANAGER_WORKTREE_ROOT: '/data' }),
    /must not be the data root/,
  );
  assert.throws(
    () =>
      resolve({ AI_AGENT_MANAGER_DATA_ROOT: '/data/app', AI_AGENT_MANAGER_WORKTREE_ROOT: '/data' }),
    /must not be the data root/,
  );
  assert.throws(
    () =>
      resolve({
        AI_AGENT_MANAGER_WORKTREE_ROOT: '/worktrees',
        AI_AGENT_MANAGER_DATABASE_PATH: '/worktrees/task/database.sqlite',
      }),
    /must not be inside the worktree root/,
  );
  assert.throws(() => resolveRuntimePaths({ environment: {}, homeDirectory: 'relative' }));
});

test('resolution performs no filesystem I/O', () => {
  withTemporaryDirectory((directory) => {
    const missingHome = join(directory, 'missing home');
    resolveRuntimePaths({ environment: {}, homeDirectory: missingHome });
    resolveRuntimePaths({
      environment: { AI_AGENT_MANAGER_DATA_ROOT: join(directory, 'data root') },
      homeDirectory: missingHome,
    });
    assert.deepEqual(readdirSync(directory), []);
  });
});

test('initializes private directories idempotently without touching existing contents', () => {
  withTemporaryDirectory((directory) => {
    const paths = resolve({
      AI_AGENT_MANAGER_DATA_ROOT: join(directory, 'nested', 'data root'),
      AI_AGENT_MANAGER_WORKTREE_ROOT: join(directory, 'agent worktrees'),
    });
    assert.deepEqual(initializeDataRoot(paths), { path: paths.dataRoot, created: true });
    assert.equal(statSync(paths.dataRoot).mode & 0o777, 0o700);
    assert.equal(existsSync(paths.worktreeRoot), false);

    writeFileSync(join(paths.dataRoot, 'keep.txt'), 'keep');
    chmodSync(paths.dataRoot, 0o755);
    assert.deepEqual(initializeDataRoot(paths), { path: paths.dataRoot, created: false });
    assert.equal(readFileSync(join(paths.dataRoot, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(statSync(paths.dataRoot).mode & 0o777, 0o755);

    assert.equal(ensureWorktreeRoot(paths).created, true);
    assert.equal(ensureWorktreeRoot(paths).created, false);
    assert.equal(statSync(paths.worktreeRoot).isDirectory(), true);
  });
});

test('refuses to initialize over an existing file', () => {
  withTemporaryDirectory((directory) => {
    const file = join(directory, 'occupied');
    writeFileSync(file, 'preserve');
    assert.throws(() => initializeDataRoot({ dataRoot: file }));
    assert.throws(() => ensureWorktreeRoot({ worktreeRoot: join(file, 'worktrees') }));
    assert.equal(readFileSync(file, 'utf8'), 'preserve');
    mkdirSync(join(directory, 'dir'));
    assert.equal(initializeDataRoot({ dataRoot: join(directory, 'dir') }).created, false);
  });
});

test('importing the package creates no files or directories', () => {
  withTemporaryDirectory((directory) => {
    const fakeHome = join(directory, 'home dir');
    mkdirSync(fakeHome);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('AI_AGENT_MANAGER_')),
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--conditions=@ai-agent-manager/source',
        '--input-type=module',
        '--eval',
        "const db = await import('@ai-agent-manager/database'); db.resolveRuntimePaths();",
      ],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: {
          ...environment,
          HOME: fakeHome,
          AI_AGENT_MANAGER_WORKTREE_ROOT: join(directory, 'worktrees'),
        },
        encoding: 'utf8',
        shell: false,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(directory), ['home dir']);
    assert.deepEqual(readdirSync(fakeHome), []);
  });
});
