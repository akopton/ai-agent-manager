import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultExecutionSecurityPolicy,
  requiredSecurityControls,
  runtimeSecurityProfileSchema,
  securityControls,
  type ExecutionAuthorization,
  type RuntimeSecurityProfile,
} from '@ai-agent-manager/core';
import type { AgentAdapter, AgentEvent, CliInstallation } from '../src/contract.js';

export const claudeVersionLine = '2.1.317 (Claude Code)';
export const codexVersionLine = 'codex-cli 0.166.0';

export const claudeHelp = `Usage: claude [options] [command] [prompt]
Options:
  --add-dir <directories...>   Additional directories
  --model <model>              Model for the current session
  --output-format <format>     "text", "json", or "stream-json"
  --permission-prompts <target>  "host" or "none"
  -p, --print                  Print response and exit
  --restricted                 Restricted mode
  -r, --resume [value]         Resume a conversation
  --strict-mcp-config          Only use MCP servers from --mcp-config
  --verbose                    Override verbose mode setting
`;

export const codexExecHelp = `Run Codex non-interactively
Usage: codex exec [OPTIONS] [PROMPT]
Options:
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
      --ignore-user-config
      --ignore-rules
      --json
`;

/** One step the fake CLI performs after reading stdin. */
export type FakeStep =
  | { stdout: string }
  | { stdoutRaw: string }
  | { stderr: string }
  | { sleepMs: number }
  /** Starts a long-running child in the same process group (inheriting stdio) and records its PID. */
  | { spawnLingeringChild: true }
  /** Starts a tagged child in its own session (escapes the process group) and records its PID. */
  | { spawnDetachedChild: string }
  | { exit: number }
  | { killSelf: 'SIGTERM' | 'SIGKILL' }
  /** Waits until killed. */
  | { hang: true };

export type FakeScenario = {
  version: string;
  versionExitCode?: number;
  help: string;
  helpExitCode?: number;
  /** Like Claude Code 2.1.317: call process.exit() right after writing help, without waiting. */
  helpExitWithoutFlush?: boolean;
  /** `exit` exits with this code on SIGTERM; `ignore` ignores SIGTERM; default: Node default. */
  onSigterm?: { exit: number } | 'ignore';
  steps: FakeStep[];
};

// Plain CommonJS script; the scenario lives next to it because the child environment is
// allow-listed and cannot carry test configuration.
const fakeCliSource = (nodePath: string): string => `#!${nodePath}
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dir = __dirname;
const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const args = process.argv.slice(2);
// Exit only after the write completes; process.exit() can truncate output written to a pipe.
if (args[0] === '--version') {
  process.stdout.write(scenario.version + '\\n', () => process.exit(scenario.versionExitCode ?? 0));
} else if (args.includes('--help') && scenario.helpExitWithoutFlush) {
  process.stdout.write(scenario.help);
  process.exit(scenario.helpExitCode ?? 0);
} else if (args.includes('--help')) {
  process.stdout.write(scenario.help, () => process.exit(scenario.helpExitCode ?? 0));
} else {
  run();
}
function run() {
if (scenario.onSigterm === 'ignore') process.on('SIGTERM', () => {});
else if (scenario.onSigterm) process.on('SIGTERM', () => process.exit(scenario.onSigterm.exit));
let stdin = '';
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', async () => {
  fs.writeFileSync(path.join(dir, 'invocation.json'), JSON.stringify({
    args, cwd: process.cwd(), envNames: Object.keys(process.env).sort(), env: process.env, stdin,
  }));
  const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));
  for (const step of scenario.steps) {
    if ('stdout' in step) await write(process.stdout, step.stdout + '\\n');
    else if ('stdoutRaw' in step) await write(process.stdout, step.stdoutRaw);
    else if ('stderr' in step) await write(process.stderr, step.stderr + '\\n');
    else if ('sleepMs' in step) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
    else if ('spawnLingeringChild' in step) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      fs.writeFileSync(path.join(dir, 'child.pid'), String(child.pid));
      child.unref();
    } else if ('spawnDetachedChild' in step) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', step.spawnDetachedChild], { detached: true, stdio: 'ignore' });
      fs.writeFileSync(path.join(dir, 'detached.pid'), String(child.pid));
      child.unref();
    } else if ('exit' in step) process.exit(step.exit);
    else if ('killSelf' in step) process.kill(process.pid, step.killSelf);
    else if ('hang' in step) setInterval(() => {}, 1000);
  }
});
}
`;

export type FakeCli = {
  directory: string;
  executablePath: string;
  setScenario: (scenario: FakeScenario) => void;
  invocation: () => {
    args: string[];
    cwd: string;
    envNames: string[];
    env: Record<string, string>;
    stdin: string;
  };
  lingeringChildPid: () => number;
  detachedChildPid: () => number;
};

export const createFakeCli = (
  directory: string,
  name: 'claude' | 'codex',
  scenario: FakeScenario,
): FakeCli => {
  const executablePath = join(directory, name);
  writeFileSync(executablePath, fakeCliSource(process.execPath));
  chmodSync(executablePath, 0o755);
  const setScenario = (next: FakeScenario): void =>
    writeFileSync(join(directory, 'scenario.json'), JSON.stringify(next));
  setScenario(scenario);
  return {
    directory,
    executablePath: realpathSync(executablePath),
    setScenario,
    invocation: () => JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8')),
    lingeringChildPid: () => Number(readFileSync(join(directory, 'child.pid'), 'utf8')),
    detachedChildPid: () => Number(readFileSync(join(directory, 'detached.pid'), 'utf8')),
  };
};

export const withTemporaryDirectory = async (
  run: (directory: string) => Promise<void>,
): Promise<void> => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-agent-manager agents ')));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** A test-only profile that claims verified enforcement, to exercise the launch path. */
export const verifiedTestProfile = (
  profile: RuntimeSecurityProfile,
  version: string,
): RuntimeSecurityProfile =>
  runtimeSecurityProfileSchema.parse({
    ...profile,
    id: `${profile.id}-test-verified`,
    assessedVersion: version,
    capabilities: securityControls.map((control) => ({
      control,
      mechanism: 'os_sandbox',
      coversSubprocesses: true,
      verification: 'verified',
      evidence: 'test fixture only',
      notes: 'Test-only claim; never shipped.',
    })),
  });

export type InvocationInput = { modelId?: string | null; sourceEnvironment?: NodeJS.ProcessEnv };

/**
 * A hand-built authorization as the gate would issue it for the adapter's own prepared
 * invocation. Tests only: the gate never authorizes the shipped, unverified profiles.
 */
export const authorizationFor = (
  adapter: AgentAdapter,
  installation: CliInstallation,
  workingDirectory: string,
  overrides: Partial<ExecutionAuthorization> = {},
  { modelId = null, sourceEnvironment = process.env }: InvocationInput = {},
): ExecutionAuthorization => {
  const preparation = adapter.prepareExecution(
    installation,
    { runId: 'fixture', prompt: 'fixture', modelId, workingDirectory },
    { sourceEnvironment },
  );
  if (!preparation.ok) {
    throw new Error(`fixture invocation could not be prepared: ${preparation.message}`);
  }
  return {
    runtime: adapter.runtime,
    runtimeVersion: installation.version,
    launchProfileId: adapter.securityProfile.id,
    launchArguments: [...adapter.securityProfile.launchArguments],
    invocation: preparation.plan.invocation,
    workspace: {
      repositoryRoot: workingDirectory,
      commonDir: join(workingDirectory, '.git'),
      worktreePath: workingDirectory,
      workingDirectory,
      branch: 'agent/task-1',
      baseCommit: 'a'.repeat(40),
    },
    policy: defaultExecutionSecurityPolicy,
    controls: requiredSecurityControls(defaultExecutionSecurityPolicy).map((control) => ({
      control,
      status: 'enforced' as const,
      mechanism: 'os_sandbox' as const,
    })),
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
};

export const collectEvents = () => {
  const events: AgentEvent[] = [];
  return { events, emit: (event: AgentEvent) => void events.push(event) };
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
