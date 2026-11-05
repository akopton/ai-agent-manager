import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  applyMigrations,
  createDatabase,
  type DatabaseConnection,
} from '@ai-agent-manager/database';

// Fixture repositories are created only inside temporary directories, with global and system Git
// configuration disabled so the developer's settings cannot affect them.
const fixtureEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) {
      delete env[name];
    }
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
};

/** Runs Git for fixture setup only. Never point this at a non-temporary directory. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: fixtureEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export const writeFile = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

/** Creates a repository on branch `main`, with one commit unless `empty` is set. */
export const createRepository = (path: string, { empty = false } = {}): string => {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '--quiet', '--initial-branch=main', '.');
  if (!empty) {
    writeFile(join(path, 'README.md'), 'fixture\n');
    git(path, 'add', 'README.md');
    git(path, 'commit', '--quiet', '-m', 'Initial commit');
  }
  return realpathSync(path);
};

/** Captures every file under `directory` (including `.git`) with its size, mtime, and content. */
export const snapshot = (directory: string): Map<string, string> => {
  const entries = new Map<string, string>();
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      const stats = lstatSync(child);
      const content = entry.isSymbolicLink()
        ? `link:${readlinkSync(child)}`
        : readFileSync(child).toString('base64');
      entries.set(relative(directory, child), `${stats.size}:${stats.mtimeMs}:${content}`);
    }
  };
  visit(directory);
  return entries;
};

/** Creates a canonical temporary directory whose name contains spaces. */
export const createFixtureDirectory = (): string =>
  realpathSync(mkdtempSync(join(tmpdir(), 'ai-agent-manager web fixture ')));

export const removeFixtureDirectory = (directory: string): void =>
  rmSync(directory, { recursive: true, force: true });

/** Opens a migrated database inside `directory`. */
export const createMigratedDatabase = (directory: string): DatabaseConnection => {
  const connection = createDatabase({ path: join(directory, 'data', 'database.sqlite') });
  applyMigrations(connection);
  return connection;
};
