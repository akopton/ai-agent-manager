import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conversationDisclosure,
  type AgentRuntime,
  type ConversationContextMode,
  type ConversationLanguageMode,
} from '@ai-agent-manager/core';
import {
  acceptConversationDisclosure,
  applyMigrations,
  createConversation,
  createDatabase,
  findConversationTurn,
  insertProject,
  sendConversationMessage,
  type DatabaseConnection,
} from '@ai-agent-manager/database';
import { createExecutionService } from '../src/execution/execution-service.js';
import { createRepository } from './execution-fixtures.js';
import { createRecordingLogger, type RecordingLogger } from './helpers.js';

// Shared fixture for worker tests of conversation work (C2 turns, C3 proposal generations): fake
// Claude/Codex CLIs, a disposable repository and a temporary database. No real CLI runs.

export type Step =
  | { stdout: unknown }
  | { stderr: string }
  | { sleepMs: number }
  | { exit: number }
  | { hang: true }
  /** Writes stdin into an assistant reply (Claude) or agent message (Codex). */
  | { echo: true };

export const helpTexts: Record<AgentRuntime, string> = {
  claude: `Options:
  --disable-slash-commands  --model <model>  --no-session-persistence  --output-format <format>
  --permission-mode <mode>  --permission-prompts <target>  -p, --print  --restricted  --safe-mode
  --strict-mcp-config  --tools <tools...>  --verbose
`,
  codex: `Options:
  -m, --model <MODEL>  -s, --sandbox <SANDBOX_MODE>  --ephemeral  --skip-git-repo-check
  --ignore-user-config  --ignore-rules  --json
`,
};
export const versionLines: Record<AgentRuntime, string> = {
  claude: '2.1.317 (Claude Code)',
  codex: 'codex-cli 0.166.0',
};

export const fakeSource = (runtime: AgentRuntime): string => `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const args = process.argv.slice(2);
const done = (text) => process.stdout.write(text, () => process.exit(0));
if (args[0] === '--version') done(${JSON.stringify(versionLines[runtime])} + '\\n');
else if (args.includes('--help')) done(${JSON.stringify(helpTexts[runtime])});
else {
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  // C4: a { sequence } scenario gives each invocation its own steps (planning, then answer).
  const logFile = path.join(dir, 'invocations.jsonl');
  const previous = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\\n').filter(Boolean).length : 0;
  const steps = Array.isArray(scenario) ? scenario : scenario.sequence[Math.min(previous - scenario.offset, scenario.sequence.length - 1)];
  let stdin = '';
  process.stdin.on('data', (chunk) => (stdin += chunk));
  process.stdin.on('end', async () => {
    fs.appendFileSync(path.join(dir, 'invocations.jsonl'), JSON.stringify({ args, cwd: process.cwd(), stdin, pid: process.pid }) + '\\n');
    const write = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
    for (const step of steps) {
      if ('stdout' in step) await write(JSON.stringify(step.stdout) + '\\n');
      else if ('stderr' in step) process.stderr.write(step.stderr + '\\n');
      else if ('sleepMs' in step) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
      else if ('exit' in step) process.exit(step.exit);
      else if ('hang' in step) { setInterval(() => {}, 1000); return; }
      else if ('echo' in step) {
        const event = ${runtime === 'claude'}
          ? { type: 'assistant', message: { content: [{ type: 'text', text: 'ECHO:' + stdin.length }] } }
          : { type: 'item.completed', item: { id: 'e', type: 'agent_message', text: 'ECHO:' + stdin.length } };
        await write(JSON.stringify(event) + '\\n');
      }
    }
  });
}
`;

export type Fake = {
  path: string;
  setSteps: (steps: Step[]) => void;
  /** C4: the next invocations use these steps in order (the last one repeats). */
  setSequence: (sequence: Step[][]) => void;
  invocations: () => { args: string[]; cwd: string; stdin: string; pid: number }[];
};

export const createFake = (directory: string, runtime: AgentRuntime): Fake => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, runtime);
  writeFileSync(path, fakeSource(runtime));
  chmodSync(path, 0o755);
  const setSteps = (steps: Step[]) =>
    writeFileSync(join(directory, 'scenario.json'), JSON.stringify(steps));
  setSteps([]);
  const log = join(directory, 'invocations.jsonl');
  const count = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '').length
      : 0;
  return {
    path: realpathSync(path),
    setSteps,
    setSequence: (sequence) =>
      writeFileSync(
        join(directory, 'scenario.json'),
        JSON.stringify({ offset: count(), sequence }),
      ),
    invocations: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line))
        : [],
  };
};

export const reply: Record<AgentRuntime, (text: string, model?: string) => Step[]> = {
  claude: (text, model = 'claude-opus-5-5') => [
    { stdout: { type: 'system', subtype: 'init', session_id: 's', model, tools: [] } },
    { stdout: { type: 'assistant', message: { content: [{ type: 'text', text }] } } },
    { stdout: { type: 'result', subtype: 'success', is_error: false, result: text } },
  ],
  codex: (text) => [
    { stdout: { type: 'thread.started', thread_id: 't' } },
    { stdout: { type: 'item.completed', item: { id: 'i', type: 'agent_message', text } } },
    { stdout: { type: 'turn.completed', usage: {} } },
  ],
};

export type Fixture = {
  directory: string;
  db: DatabaseConnection['db'];
  connection: DatabaseConnection;
  repository: { root: string; commonDir: string };
  projectId: string;
  scratchRoot: string;
  fakes: Record<AgentRuntime, Fake>;
  logger: RecordingLogger;
  conversation: (runtime: AgentRuntime, options?: ConversationOptions) => string;
  send: (conversationId: string, content: string) => { turnId: string };
  service: (
    overrides?: Partial<Parameters<typeof createExecutionService>[0]>,
  ) => ReturnType<typeof createExecutionService>;
  waitForTurn: (turnId: string, statuses: string[]) => Promise<string>;
};

export type ConversationOptions = {
  modelId?: string | null;
  languageMode?: ConversationLanguageMode;
  contextMode?: ConversationContextMode;
};

export const withFixture = async (run: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-agent-manager conv ')));
  const databasePath = join(directory, 'data', 'database.sqlite');
  const connection = createDatabase({ path: databasePath });
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
      instructions: 'Project instructions are not sent in C2.',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    acceptConversationDisclosure(db, {
      input: { disclosureVersion: conversationDisclosure.version },
      now: Date.now() - 60_000,
    });
    const fakes = {
      claude: createFake(join(directory, 'bin', 'claude'), 'claude'),
      codex: createFake(join(directory, 'bin', 'codex'), 'codex'),
    };
    const logger = createRecordingLogger();
    const scratchRoot = join(directory, 'data', 'conversation-scratch');
    const scopeOf = (conversationId: string) => ({ projectId, conversationId });
    const fixture: Fixture = {
      directory,
      db,
      connection,
      repository,
      projectId,
      scratchRoot,
      fakes,
      logger,
      conversation: (runtime, options = {}) => {
        const id = randomUUID();
        createConversation(db, {
          id,
          input: {
            projectId,
            title: `Conversation ${id.slice(0, 6)}`,
            agentRuntime: runtime,
            modelId: options.modelId ?? null,
            languageMode: options.languageMode ?? 'pl_technical_en',
            contextMode: options.contextMode ?? 'general',
          },
          now: Date.now(),
        });
        return id;
      },
      send: (conversationId, content) => {
        const result = sendConversationMessage(db, {
          scope: scopeOf(conversationId),
          messageId: randomUUID(),
          turnId: randomUUID(),
          input: { requestId: randomUUID(), content },
          now: Date.now(),
        });
        return { turnId: result.turn.id };
      },
      service: (overrides = {}) =>
        createExecutionService({
          db,
          logger,
          worktreeRoot: join(directory, 'worktrees'),
          conversationScratchRoot: scratchRoot,
          databasePath,
          pollIntervalMs: 25,
          leaseTtlMs: 5_000,
          limits: { stopGraceMs: 300 },
          detectionOptions: {
            claude: { executablePath: fakes.claude.path },
            codex: { executablePath: fakes.codex.path },
          },
          ...overrides,
        }),
      waitForTurn: async (turnId, statuses) => {
        const deadline = Date.now() + 20_000;
        for (;;) {
          const status = findConversationTurn(db, turnId)?.status;
          if (status !== undefined && statuses.includes(status)) return status;
          if (Date.now() > deadline) {
            throw new Error(
              `Turn ${turnId} did not reach ${statuses.join('/')} (now ${status}).\n${logger.messages.join('\n')}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
    };
    await run(fixture);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

export const scope = (fixture: Fixture, conversationId: string) => ({
  projectId: fixture.projectId,
  conversationId,
});
