// Local development entry point for `pnpm dev`. Not used in production.
//
// 1. Requires Node.js 24 (fails with instructions otherwise).
// 2. Defaults the development database to ~/tmp/ai-agent-manager-dev/database.sqlite unless
//    AI_AGENT_MANAGER_DATABASE_PATH or AI_AGENT_MANAGER_DATA_ROOT is already set.
// 3. Applies pending migrations synchronously (with a backup of an existing database) and stops
//    if that fails.
// 4. Starts the web app and worker (`pnpm dev:apps`) with the very same environment.
//
// Plain JavaScript using only Node.js built-ins, so the version check runs on any Node.js.
import { spawn, spawnSync } from 'node:child_process';
import { constants, homedir } from 'node:os';
import { join } from 'node:path';

const requiredNodeMajor = 24;
const databaseVariable = 'AI_AGENT_MANAGER_DATABASE_PATH';
const dataRootVariable = 'AI_AGENT_MANAGER_DATA_ROOT';

const fail = (lines) => {
  console.error(['', ...lines.map((line) => `[dev] ${line}`), ''].join('\n'));
  process.exit(1);
};

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor !== requiredNodeMajor) {
  fail([
    `Node.js ${requiredNodeMajor} is required, but ${process.version} is active (${process.execPath}).`,
    'Switch this shell to Node.js 24 and run `pnpm dev` again:',
    '  nvm install && nvm use                               # nvm (reads .nvmrc)',
    '  fnm use --install-if-missing                         # fnm',
    '  export PATH="$(brew --prefix node@24)/bin:$PATH"     # Homebrew node@24 (keg-only)',
    'After switching Node.js major versions, run once: pnpm rebuild better-sqlite3',
  ]);
}

const isSet = (name) => process.env[name] !== undefined && process.env[name] !== '';

// An explicit database path or data root always wins; only an unconfigured shell gets the
// development default. The child processes receive this exact environment, so the migration
// step, the web server and the worker all resolve the same database file.
const environment = { ...process.env };
if (isSet(databaseVariable)) {
  console.log(`[dev] Using ${databaseVariable} from the environment.`);
} else if (isSet(dataRootVariable)) {
  console.log(`[dev] Using the database inside ${dataRootVariable} from the environment.`);
} else {
  environment[databaseVariable] = join(homedir(), 'tmp', 'ai-agent-manager-dev', 'database.sqlite');
  console.log(`[dev] ${databaseVariable} defaults to ${environment[databaseVariable]}`);
}

// Re-invoke the pnpm that launched this script when possible, otherwise pnpm from PATH.
const pnpmCommand = (args) => {
  const execPath = process.env.npm_execpath;
  if (execPath === undefined || execPath === '') {
    return { command: 'pnpm', args };
  }
  if (/\.[cm]?js$/.test(execPath)) {
    return { command: process.execPath, args: [execPath, ...args] };
  }
  return { command: execPath, args };
};

const migrate = pnpmCommand([
  '--silent',
  '--filter',
  '@ai-agent-manager/database',
  'run',
  'db:migrate:dev',
]);
const migration = spawnSync(migrate.command, migrate.args, {
  env: environment,
  stdio: 'inherit',
  shell: false,
});
if (migration.error !== undefined || migration.status !== 0) {
  fail([
    migration.error === undefined
      ? `Database migration failed (${migration.signal ?? `exit code ${migration.status}`}).`
      : `Could not run the database migration: ${migration.error.message}`,
    'The web app and worker were not started.',
    'If the error mentions NODE_MODULE_VERSION, run: pnpm rebuild better-sqlite3',
  ]);
}

const apps = pnpmCommand(['run', 'dev:apps']);
const child = spawn(apps.command, apps.args, { env: environment, stdio: 'inherit', shell: false });

// Ctrl+C reaches every process in the terminal's foreground group, so the children shut down on
// their own; keep this process alive until they exit. Signals sent only to this process (for
// example `kill <pid>`) are forwarded.
process.on('SIGINT', () => {});
for (const signal of ['SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => fail([`Could not start the web app and worker: ${error.message}`]));
child.on('exit', (code, signal) => {
  process.exit(code ?? 128 + (constants.signals[signal] ?? 0));
});
