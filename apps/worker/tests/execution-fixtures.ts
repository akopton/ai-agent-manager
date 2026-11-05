import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
import { join, relative } from 'node:path';
import { trustedLocalDisclosure, type AgentRuntime, type TaskStatus } from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  applyMigrations,
  createDatabase,
  createTask,
  findTaskById,
  insertProject,
  requestTaskExecution,
  setProjectExecutionTrust,
  transitionTask,
  type DatabaseConnection,
} from '@ai-agent-manager/database';
import {
  createExecutionService,
  type ExecutionServiceOptions,
} from '../src/execution/execution-service.js';
import { createRecordingLogger, type RecordingLogger } from './helpers.js';

// Disposable fixtures for the execution slice: a temporary Git repository (never a real one), a
// temporary SQLite database, and fake Claude/Codex CLIs that only answer discovery and replay a
// scenario. Global and system Git config are ignored for fixture setup.

const fixtureGitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
});

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: fixtureGitEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export const createRepository = (path: string): { root: string; commonDir: string } => {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '--quiet', '--initial-branch=main', '.');
  writeFileSync(join(path, 'README.md'), 'fixture\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '--quiet', '-m', 'Initial commit');
  const root = realpathSync(path);
  return { root, commonDir: realpathSync(join(root, '.git')) };
};

/** Every file under `directory` with size, mtime and content, for before/after comparisons. */
export const snapshotTree = (directory: string): Map<string, string> => {
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

export type FakeStep =
  | { stdout: unknown }
  | { stderr: string }
  | { sleepMs: number }
  | { writeFile: string; content: string }
  /** Commits everything in the worktree with an isolated Git config (simulates agent overreach). */
  | { gitCommit: string }
  | { exit: number }
  | { hang: true };

const versionLines: Record<AgentRuntime, string> = {
  claude: '2.1.317 (Claude Code)',
  codex: 'codex-cli 0.166.0',
};

const helpTexts: Record<AgentRuntime, string> = {
  claude: `Usage: claude [options] [command] [prompt]
Options:
  --model <model>              Model for the current session
  --output-format <format>     "text", "json", or "stream-json"
  --permission-mode <mode>     Permission mode to use for the session
  --permission-prompts <target>  "host" or "none"
  -p, --print                  Print response and exit
  --restricted                 Restricted mode
  --strict-mcp-config          Only use MCP servers from --mcp-config
  --verbose                    Override verbose mode setting
`,
  codex: `Usage: codex exec [OPTIONS] [PROMPT]
Options:
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
      --ignore-user-config
      --ignore-rules
      --json
`,
};

const fakeCliSource = (nodePath: string, runtime: AgentRuntime): string => `#!${nodePath}
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dir = __dirname;
const args = process.argv.slice(2);
const done = (text, code) => process.stdout.write(text, () => process.exit(code));
if (args[0] === '--version') done(${JSON.stringify(versionLines[runtime])} + '\\n', 0);
else if (args.includes('--help')) done(${JSON.stringify(helpTexts[runtime])}, 0);
else {
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  let stdin = '';
  process.stdin.on('data', (chunk) => (stdin += chunk));
  process.stdin.on('end', async () => {
    fs.appendFileSync(path.join(dir, 'invocations.jsonl'), JSON.stringify({ args, cwd: process.cwd(), stdin }) + '\\n');
    const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    for (const step of scenario.steps) {
      if ('stdout' in step) await write(process.stdout, JSON.stringify(step.stdout) + '\\n');
      else if ('stderr' in step) await write(process.stderr, step.stderr + '\\n');
      else if ('sleepMs' in step) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
      else if ('writeFile' in step) fs.writeFileSync(path.join(process.cwd(), step.writeFile), step.content);
      else if ('gitCommit' in step) {
        const base = ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
        spawnSync('git', [...base, 'add', '-A'], { env: gitEnv });
        spawnSync('git', [...base, 'commit', '-q', '-m', step.gitCommit], { env: gitEnv });
      }
      else if ('exit' in step) process.exit(step.exit);
      else if ('hang' in step) { setInterval(() => {}, 1000); return; }
    }
  });
}
`;

export type FakeCli = {
  executablePath: string;
  setSteps: (steps: FakeStep[]) => void;
  invocations: () => { args: string[]; cwd: string; stdin: string }[];
};

export const createFakeCli = (directory: string, runtime: AgentRuntime): FakeCli => {
  mkdirSync(directory, { recursive: true });
  const executablePath = join(directory, runtime);
  writeFileSync(executablePath, fakeCliSource(process.execPath, runtime));
  chmodSync(executablePath, 0o755);
  const setSteps = (steps: FakeStep[]): void =>
    writeFileSync(join(directory, 'scenario.json'), JSON.stringify({ steps }));
  setSteps([]);
  return {
    executablePath: realpathSync(executablePath),
    setSteps,
    invocations: () => {
      const file = join(directory, 'invocations.jsonl');
      return existsSync(file)
        ? readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line))
        : [];
    },
  };
};

export const successSteps: Record<AgentRuntime, FakeStep[]> = {
  codex: [
    { stdout: { type: 'thread.started', thread_id: 'thread-1' } },
    { writeFile: 'feature.txt', content: 'implemented\n' },
    { stdout: { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'Done.' } } },
    { stdout: { type: 'turn.completed', usage: {} } },
  ],
  claude: [
    { stdout: { type: 'system', subtype: 'init', session_id: 'session-1', model: 'fake-model' } },
    { writeFile: 'feature.txt', content: 'implemented\n' },
    { stdout: { type: 'result', subtype: 'success', is_error: false, result: 'Done.' } },
  ],
};

export type ExecutionFixture = {
  directory: string;
  connection: DatabaseConnection;
  db: DatabaseConnection['db'];
  databasePath: string;
  repository: { root: string; commonDir: string };
  worktreeRoot: string;
  projectId: string;
  clis: Record<AgentRuntime, FakeCli>;
  logger: RecordingLogger;
  /** Accepts the current disclosure and trusts the project, as the operator would. */
  grantConsent: () => void;
  /** Creates a task and queues it; returns its ID. */
  queuedTask: (runtime?: AgentRuntime, prompt?: string) => string;
  /** Records an operator start request for a queued task. */
  requestStart: (taskId: string) => void;
  service: (
    overrides?: Partial<ExecutionServiceOptions>,
  ) => ReturnType<typeof createExecutionService>;
  waitForTaskStatus: (
    taskId: string,
    statuses: TaskStatus[],
    timeoutMs?: number,
  ) => Promise<TaskStatus>;
  reopen: () => DatabaseConnection;
};

export const withExecutionFixture = async (
  run: (fixture: ExecutionFixture) => Promise<void>,
): Promise<void> => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-agent-manager worker exec ')));
  const databasePath = join(directory, 'data', 'database.sqlite');
  const connection = createDatabase({ path: databasePath });
  const extra: DatabaseConnection[] = [];
  try {
    applyMigrations(connection);
    const { db } = connection;
    const repository = createRepository(join(directory, 'source repo'));
    const projectId = randomUUID();
    insertProject(db, {
      id: projectId,
      name: 'Fixture',
      localPath: repository.root,
      gitCommonDir: repository.commonDir,
      remoteName: null,
      defaultBaseBranch: 'main',
      instructions: 'Keep changes small.',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const clis = {
      claude: createFakeCli(join(directory, 'bin', 'claude'), 'claude'),
      codex: createFakeCli(join(directory, 'bin', 'codex'), 'codex'),
    };
    clis.claude.setSteps(successSteps.claude);
    clis.codex.setSteps(successSteps.codex);
    const worktreeRoot = join(directory, 'worktrees');
    const logger = createRecordingLogger();
    const fixture: ExecutionFixture = {
      directory,
      connection,
      db,
      databasePath,
      repository,
      worktreeRoot,
      projectId,
      clis,
      logger,
      grantConsent: () => {
        const at = Date.now() - 60_000;
        acceptTrustedLocal(db, {
          input: {
            disclosureVersion: trustedLocalDisclosure.version,
            acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
          },
          now: at,
        });
        setProjectExecutionTrust(db, {
          projectId,
          trust: {
            trust: 'trusted_local',
            localPath: repository.root,
            gitCommonDir: repository.commonDir,
          },
          now: at,
        });
      },
      queuedTask: (runtime = 'codex', prompt = 'Create feature.txt. Secret prompt text.') => {
        const id = randomUUID();
        createTask(db, {
          id,
          input: { projectId, title: `Task ${id.slice(0, 8)}`, prompt, agentRuntime: runtime },
          now: Date.now(),
        });
        transitionTask(db, { id, action: 'queue', now: Date.now() });
        return id;
      },
      requestStart: (taskId) => {
        requestTaskExecution(db, { id: randomUUID(), taskId, now: Date.now() });
      },
      service: (overrides = {}) =>
        createExecutionService({
          db,
          logger,
          worktreeRoot,
          pollIntervalMs: 25,
          leaseTtlMs: 5_000,
          runTimeoutMs: 60_000,
          limits: { stopGraceMs: 300 },
          detectionOptions: {
            claude: { executablePath: clis.claude.executablePath },
            codex: { executablePath: clis.codex.executablePath },
          },
          ...overrides,
        }),
      waitForTaskStatus: async (taskId, statuses, timeoutMs = 20_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const status = findTaskById(db, taskId)?.status;
          if (status !== undefined && statuses.includes(status)) return status;
          if (Date.now() > deadline) {
            throw new Error(
              `Task ${taskId} did not reach ${statuses.join('/')} (now ${status}).\n${logger.messages.join('\n')}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
      reopen: () => {
        const reopened = createDatabase({ path: databasePath });
        extra.push(reopened);
        return reopened;
      },
    };
    await run(fixture);
  } finally {
    for (const other of extra) other.close();
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

export const waitFor = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
