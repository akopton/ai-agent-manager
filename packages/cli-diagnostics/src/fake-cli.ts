import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentRuntime } from '@ai-agent-manager/core';
import { probeDirectoryName, type DiagnosticFixture } from './fixture.js';
import type { ProbeScenarioId } from './scenarios.js';

/** One step the fake CLI performs after reading the prompt from stdin. */
export type FakeStep =
  | { stdout: string }
  | { stdoutRaw: string }
  | { stderr: string }
  | { sleepMs: number }
  /** Writes `bytes` of filler lines to stdout as fast as possible. */
  | { floodStdoutBytes: number }
  /** Starts a long-running child in the same process group, tagged with `nonce`. */
  | { spawnGroupChild: { nonce: string } }
  /** Runs the probe helper like an agent's shell tool would, relaying a runtime-style tool event. */
  | { runProbe: ProbeScenarioId }
  | { exit: number }
  | { hang: true };

export const fakeVersionLines: Readonly<Record<AgentRuntime, string>> = {
  claude: '2.1.317 (Claude Code)',
  codex: 'codex-cli 0.166.0',
};

/** Minimal help listing exactly the options the adapters require or record. */
export const fakeHelpTexts: Readonly<Record<AgentRuntime, string>> = {
  claude: `Usage: claude [options] [command] [prompt]
Options:
  --model <model>                  Model for the current session
  --output-format <format>         "text", "json", or "stream-json"
  --permission-mode <mode>         Permission mode to use for the session
  --permission-prompts <target>    "host" or "none"
  -p, --print                      Print response and exit
  --restricted                     Restricted mode
  --strict-mcp-config              Only use MCP servers from --mcp-config
  --verbose                        Override verbose mode setting
`,
  codex: `Run Codex non-interactively
Usage: codex exec [OPTIONS] [PROMPT]
Options:
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
      --ignore-user-config
      --ignore-rules
      --json
`,
};

export type FakeCli = {
  runtime: AgentRuntime;
  name: string;
  executablePath: string;
  /** SHA-256 of the generated script; re-checked before every run. */
  sha256: string;
};

const fakeCliSource = (
  nodePath: string,
  fixtureId: string,
  runtime: AgentRuntime,
  helperPath: string,
): string => `#!${nodePath}
// AI Agent Manager diagnostics fake CLI (${runtime}) for fixture ${fixtureId}. Not a real agent.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const runtime = ${JSON.stringify(runtime)};
const helperPath = ${JSON.stringify(helperPath)};
const scenario = JSON.parse(fs.readFileSync(__filename + '.scenario.json', 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write(scenario.version + '\\n', () => process.exit(scenario.versionExitCode || 0));
} else if (args.includes('--help')) {
  process.stdout.write(scenario.help, () => process.exit(0));
} else {
  run();
}
function relayProbe(id, index) {
  const result = spawnSync(process.execPath, [helperPath, id], { encoding: 'utf8', timeout: 30000 });
  const command = 'node ${probeDirectoryName}/probe.cjs ' + id;
  const output = String(result.stdout || '');
  const failed = result.status !== 0;
  if (runtime === 'claude') {
    const toolId = 'toolu_fake_' + index;
    return [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: failed, content: output }] } },
    ];
  }
  const item = { id: 'item_fake_' + index, type: 'command_execution', command };
  return [
    { type: 'item.started', item: Object.assign({ status: 'in_progress' }, item) },
    { type: 'item.completed', item: Object.assign({ status: failed ? 'failed' : 'completed', exit_code: result.status, aggregated_output: output }, item) },
  ];
}
function run() {
  let stdin = '';
  process.stdin.on('data', (chunk) => (stdin += chunk));
  process.stdin.on('end', async () => {
    fs.writeFileSync(__filename + '.invocation.json', JSON.stringify({
      args,
      cwd: process.cwd(),
      envNames: Object.keys(process.env).sort(),
      stdinSha256: crypto.createHash('sha256').update(stdin).digest('hex'),
      stdinBytes: Buffer.byteLength(stdin),
    }));
    const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));
    let index = 0;
    for (const step of scenario.steps) {
      index += 1;
      if ('stdout' in step) await write(process.stdout, step.stdout + '\\n');
      else if ('stdoutRaw' in step) await write(process.stdout, step.stdoutRaw);
      else if ('stderr' in step) await write(process.stderr, step.stderr + '\\n');
      else if ('sleepMs' in step) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
      else if ('floodStdoutBytes' in step) {
        const line = 'x'.repeat(1023) + '\\n';
        for (let sent = 0; sent < step.floodStdoutBytes; sent += line.length) {
          if (!process.stdout.write(line)) await new Promise((resolve) => process.stdout.once('drain', resolve));
        }
      } else if ('spawnGroupChild' in step) {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'aam-fake-child-' + step.spawnGroupChild.nonce], { stdio: 'ignore' });
        fs.writeFileSync(__filename + '.child.pid', String(child.pid));
        child.unref();
      } else if ('runProbe' in step) {
        for (const event of relayProbe(step.runProbe, index)) await write(process.stdout, JSON.stringify(event) + '\\n');
      } else if ('exit' in step) process.exit(step.exit);
      else if ('hang' in step) setInterval(() => {}, 1000);
    }
  });
}
`;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export type FakeCliOptions = { name?: string; version?: string };

/** Writes a fake CLI into the fixture's `fake-bin` directory. */
export const createFakeCli = async (
  fixture: DiagnosticFixture,
  runtime: AgentRuntime,
  options: FakeCliOptions = {},
): Promise<FakeCli> => {
  const name = options.name ?? runtime;
  if (!/^[a-z0-9-]+$/.test(name))
    throw new Error('Fake CLI names use lowercase letters and digits.');
  const { paths, fixtureId } = fixture.manifest;
  const executablePath = join(paths.fakeBin, name);
  const source = fakeCliSource(
    process.execPath,
    fixtureId,
    runtime,
    join(paths.probe, 'probe.cjs'),
  );
  await writeFile(executablePath, source, { flag: 'wx', mode: 0o700 });
  fixture.manifest.createdPaths.push(executablePath);
  const fake: FakeCli = { runtime, name, executablePath, sha256: sha256(source) };
  await setFakeScenario(fixture, fake, {
    steps: [],
    ...(options.version === undefined ? {} : { version: options.version }),
  });
  return fake;
};

/** Writes the fake's scenario. Verifies the fake first, so nothing is written next to other files. */
export const setFakeScenario = async (
  fixture: DiagnosticFixture,
  fake: FakeCli,
  scenario: { steps: FakeStep[]; version?: string; versionExitCode?: number },
): Promise<void> => {
  await verifyFakeCli(fixture, fake);
  // Records from a previous run must not be mistaken for this run's.
  for (const suffix of ['.invocation.json', '.child.pid']) {
    await rm(`${fake.executablePath}${suffix}`, { force: true });
  }
  await writeFile(
    `${fake.executablePath}.scenario.json`,
    JSON.stringify({
      version: scenario.version ?? fakeVersionLines[fake.runtime],
      versionExitCode: scenario.versionExitCode ?? 0,
      help: fakeHelpTexts[fake.runtime],
      steps: scenario.steps,
    }),
    { mode: 0o600 },
  );
};

/**
 * Proves an executable is a harness-generated fake CLI of this fixture: directly inside its
 * `fake-bin`, a canonical regular file, and byte-identical to what the harness wrote. The fake
 * runner refuses everything else, so it can never launch a real agent CLI.
 */
export const verifyFakeCli = async (fixture: DiagnosticFixture, fake: FakeCli): Promise<void> => {
  const { executablePath } = fake;
  if (dirname(executablePath) !== fixture.manifest.paths.fakeBin) {
    throw new Error(`${executablePath} is not inside the fixture's fake-bin directory.`);
  }
  const stats = await lstat(executablePath);
  if (!stats.isFile() || (await realpath(executablePath)) !== executablePath) {
    throw new Error(`${executablePath} is not a canonical regular file.`);
  }
  const content = await readFile(executablePath, 'utf8');
  if (
    sha256(content) !== fake.sha256 ||
    !content.includes(`fixture ${fixture.manifest.fixtureId}. Not a real agent.`)
  ) {
    throw new Error(`${executablePath} is not the fake CLI generated by this harness.`);
  }
};

export const fakeInvocationSchema = z
  .object({
    args: z.array(z.string()),
    cwd: z.string(),
    envNames: z.array(z.string()),
    stdinSha256: z.string(),
    stdinBytes: z.number(),
  })
  .strict();

export type FakeInvocation = z.infer<typeof fakeInvocationSchema>;

export const readFakeInvocation = async (fake: FakeCli): Promise<FakeInvocation | null> =>
  readFile(`${fake.executablePath}.invocation.json`, 'utf8').then(
    (text) => fakeInvocationSchema.parse(JSON.parse(text)),
    () => null,
  );

export const readFakeChildPid = async (fake: FakeCli): Promise<number | null> =>
  readFile(`${fake.executablePath}.child.pid`, 'utf8').then(
    (text) => Number(text),
    () => null,
  );
