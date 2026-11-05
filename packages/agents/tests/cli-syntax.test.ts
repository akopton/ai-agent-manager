import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeAdapter, codexAdapter, type CliInstallation } from '../src/index.js';
import { parseHelpOptions } from '../src/discovery.js';
import {
  claudeVersionLine,
  codexVersionLine,
  createFakeCli,
  withTemporaryDirectory,
} from './fixtures.js';

// Help output captured verbatim from the locally installed CLIs (`claude --help` of 2.1.317 and
// `codex exec --help` of 0.166.0). No agent was run to produce them.
const helpDirectory = fileURLToPath(new URL('./cli-help/', import.meta.url));
const claudeRealHelp = readFileSync(join(helpDirectory, 'claude-2.1.317-help.txt'), 'utf8');
const codexRealHelp = readFileSync(join(helpDirectory, 'codex-0.166.0-exec-help.txt'), 'utf8');

const request = {
  runId: 'run-1',
  prompt: 'Prompt text',
  modelId: null,
  workingDirectory: '/tmp/worktrees/repo/task-1',
};

const detectWithRealHelp = async (
  directory: string,
  runtime: 'claude' | 'codex',
): Promise<CliInstallation> => {
  const fake = createFakeCli(directory, runtime, {
    version: runtime === 'claude' ? claudeVersionLine : codexVersionLine,
    help: runtime === 'claude' ? claudeRealHelp : codexRealHelp,
    steps: [],
  });
  const adapter = runtime === 'claude' ? claudeAdapter : codexAdapter;
  const detection = await adapter.detect({ executablePath: fake.executablePath });
  assert.equal(detection.status, 'available', JSON.stringify(detection));
  if (detection.status !== 'available') throw new Error('unavailable');
  return detection.installation;
};

const planArgs = (installation: CliInstallation, modelId: string | null): readonly string[] => {
  const adapter = installation.runtime === 'claude' ? claudeAdapter : codexAdapter;
  const result = adapter.prepareExecution(installation, { ...request, modelId });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.plan.invocation.arguments, result.plan.args);
  return result.plan.args;
};

test('Claude Code: complete argument arrays, including profile arguments', async () => {
  await withTemporaryDirectory(async (directory) => {
    const installation = await detectWithRealHelp(directory, 'claude');
    assert.deepEqual(planArgs(installation, null), [
      '--print',
      '--restricted',
      '--strict-mcp-config',
      '--permission-prompts',
      'none',
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    assert.deepEqual(planArgs(installation, 'claude-opus-5-5[1m]'), [
      '--print',
      '--restricted',
      '--strict-mcp-config',
      '--permission-prompts',
      'none',
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus-5-5[1m]',
    ]);
  });
});

test('Codex: complete argument arrays, including profile arguments', async () => {
  await withTemporaryDirectory(async (directory) => {
    const installation = await detectWithRealHelp(directory, 'codex');
    assert.deepEqual(planArgs(installation, null), [
      'exec',
      '--sandbox',
      'workspace-write',
      '--ignore-user-config',
      '--ignore-rules',
      '--json',
      '-',
    ]);
    assert.deepEqual(planArgs(installation, 'gpt-5.1-codex'), [
      'exec',
      '--sandbox',
      'workspace-write',
      '--ignore-user-config',
      '--ignore-rules',
      '--json',
      '--model',
      'gpt-5.1-codex',
      '-',
    ]);
  });
});

test('every Claude Code option and value is supported by the installed help', async () => {
  const listed = parseHelpOptions(claudeRealHelp);
  await withTemporaryDirectory(async (directory) => {
    const installation = await detectWithRealHelp(directory, 'claude');
    for (const option of planArgs(installation, 'opus').filter((arg) => arg.startsWith('--'))) {
      assert.ok(listed.has(option), option);
    }
  });
  // Non-interactive mode, and the option values the plan uses.
  assert.match(claudeRealHelp, /-p, --print\s+Print response and exit/);
  assert.match(
    claudeRealHelp,
    /--output-format <format>\s+Output format \(only works with --print\)/,
  );
  assert.match(claudeRealHelp, /choices: "text", "json",\s+"stream-json"/);
  assert.match(claudeRealHelp, /--permission-prompts <target>/);
  assert.match(claudeRealHelp, /"none"\s+\(nobody: anything that would prompt is\s+denied/);
  // SEC-02e.4: the permission mode the profile selects is a listed choice.
  assert.match(claudeRealHelp, /--permission-mode <mode>\s+Permission mode to use for the session/);
  assert.match(claudeRealHelp, /choices: "acceptEdits", "auto",/);
  // The prompt is an optional positional; with --print and no positional it is read from stdin
  // ("Input must be provided either through stdin or as a prompt argument when using --print").
  assert.match(claudeRealHelp, /Usage: claude \[options\] \[command\] \[prompt\]/);
  assert.match(
    claudeRealHelp,
    /--input-format <format>\s+Input format \(only works with --print\):\s+"text" \(default\)/,
  );
  // --verbose is a plain flag, so it cannot consume the following argument.
  assert.match(claudeRealHelp, /\n {2}--verbose {2,}Override verbose mode/);
});

test('every Codex option and value is supported by the installed exec help', async () => {
  const listed = parseHelpOptions(codexRealHelp);
  await withTemporaryDirectory(async (directory) => {
    const installation = await detectWithRealHelp(directory, 'codex');
    const args = planArgs(installation, 'o3');
    assert.equal(args[0], 'exec', 'exec is the first argument: the non-interactive subcommand');
    for (const option of args.filter((arg) => arg.startsWith('--'))) {
      assert.ok(listed.has(option), option);
    }
  });
  assert.match(codexRealHelp, /^Run Codex non-interactively/);
  assert.match(codexRealHelp, /Usage: codex exec \[OPTIONS\] \[PROMPT\]/);
  assert.match(
    codexRealHelp,
    /\[possible values: read-only, workspace-write, danger-full-access\]/,
  );
  assert.match(codexRealHelp, /--json\s+Print events to stdout as JSONL/);
  // `-` as the prompt reads instructions from stdin.
  assert.match(
    codexRealHelp,
    /If not provided as an argument \(or if `-` is used\),\s+instructions are read from stdin/,
  );
});

test('each parser matches the output format its invocation requests', async () => {
  await withTemporaryDirectory(async (directory) => {
    const claude = await detectWithRealHelp(join(directory), 'claude');
    const claudeArgs = planArgs(claude, null);
    const format = claudeArgs[claudeArgs.indexOf('--output-format') + 1];
    assert.equal(format, 'stream-json');
    assert.ok(claudeArgs.includes('--verbose'), 'stream-json with --print requires --verbose');
    const claudeParser = claudeAdapter.createOutputParser({ explicitModel: false });
    claudeParser.parseLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
    assert.equal(claudeParser.outcome().status, 'succeeded');
  });
  await withTemporaryDirectory(async (directory) => {
    const codex = await detectWithRealHelp(directory, 'codex');
    assert.ok(planArgs(codex, null).includes('--json'), 'the JSONL parser requires --json');
    const codexParser = codexAdapter.createOutputParser({ explicitModel: false });
    codexParser.parseLine(JSON.stringify({ type: 'turn.completed', usage: {} }));
    assert.equal(codexParser.outcome().status, 'succeeded');
  });
});

test('reads complete help output from a CLI that exits without flushing stdout', async () => {
  // Claude Code 2.1.317 truncates --help written to a pipe; probes write stdout to a file instead.
  const padding = Array.from({ length: 3_000 }, (_, index) => `  --padding-${index}   filler text`);
  const help = [claudeRealHelp, ...padding, '  --last-listed-option   at the very end'].join('\n');
  assert.ok(help.length > 64 * 1024);
  await withTemporaryDirectory(async (directory) => {
    const fake = createFakeCli(directory, 'claude', {
      version: claudeVersionLine,
      help,
      helpExitWithoutFlush: true,
      steps: [],
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const detection = await claudeAdapter.detect({ executablePath: fake.executablePath });
      assert.equal(detection.status, 'available', JSON.stringify(detection));
    }
  });
  assert.ok(parseHelpOptions(help).has('--last-listed-option'));
});
