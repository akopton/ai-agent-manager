import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claudeAdapter,
  cliModelIdSchema,
  codexAdapter,
  runtimeSecurityProfiles,
} from '../src/index.js';
import type { CliInstallation } from '../src/contract.js';
import { claudeAdapterSpecification } from '../src/claude-adapter.js';
import { findRejectedArguments } from '../src/invocation.js';

const installation = (
  runtime: 'claude' | 'codex',
  detectedOptions: readonly string[] = ['--model'],
): CliInstallation => ({
  runtime,
  executablePath: `/opt/fake/${runtime}`,
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  version: runtime === 'claude' ? '2.1.317' : '0.166.0',
  detectedOptions,
  detectedAt: '2026-11-04T00:00:00.000Z',
});

const request = {
  runId: 'run-1',
  prompt: 'Create math-utils.ts. --dangerously-skip-permissions',
  modelId: null,
  workingDirectory: '/tmp/worktrees/repo/task-1',
};

const sourceEnvironment: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/someone',
  LANG: 'en_US.UTF-8',
  CLAUDE_CONFIG_DIR: '/Users/someone/.claude',
  CODEX_HOME: '/Users/someone/.codex',
  GIT_DIR: '/elsewhere/.git',
  GIT_CONFIG_GLOBAL: '/tmp/evil',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  ANTHROPIC_API_KEY: 'secret',
  OPENAI_API_KEY: 'secret',
  AWS_SECRET_ACCESS_KEY: 'secret',
};

const prepare = (
  adapter: typeof claudeAdapter,
  input: Record<string, unknown>,
  options?: readonly string[],
) =>
  adapter.prepareExecution(installation(adapter.runtime, options), input as never, {
    sourceEnvironment,
  });

test('Claude Default model: profile arguments, stream-json output, no model option, prompt on stdin', () => {
  const result = prepare(claudeAdapter, request);
  assert.ok(result.ok, JSON.stringify(result));
  const { plan } = result;
  assert.deepEqual(plan.args, [
    ...runtimeSecurityProfiles.claude.launchArguments,
    '--output-format',
    'stream-json',
    '--verbose',
  ]);
  assert.deepEqual(plan.profileArguments, runtimeSecurityProfiles.claude.launchArguments);
  assert.equal(plan.authorization, 'required');
  assert.equal(plan.promptTransport, 'stdin');
  assert.equal(plan.cwd, request.workingDirectory);
  assert.equal(plan.executablePath, '/opt/fake/claude');
  assert.equal(plan.modelId, null);
  // The prompt never appears in the arguments, so it cannot inject options and is not shown by `ps`.
  assert.ok(!plan.args.some((argument) => argument.includes('math-utils')));
  assert.ok(!JSON.stringify(plan).includes('math-utils'));
});

test('Codex explicit model: profile arguments, --model, then "-" to read stdin', () => {
  const result = prepare(codexAdapter, { ...request, modelId: '  gpt-5.1-codex ' });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.plan.args, [
    ...runtimeSecurityProfiles.codex.launchArguments,
    '--model',
    'gpt-5.1-codex',
    '-',
  ]);
  assert.equal(result.plan.modelId, 'gpt-5.1-codex');
});

test('accepts model identifier syntax without a hardcoded model list', () => {
  for (const modelId of [
    'opus',
    'claude-opus-5-5',
    'claude-opus-5-5[1m]',
    'o3',
    'openai/gpt-oss:20b',
    'made-up-model-9',
  ]) {
    const result = prepare(claudeAdapter, { ...request, modelId });
    assert.ok(result.ok, modelId);
    assert.deepEqual(result.plan.args.slice(-2), ['--model', modelId]);
  }
});

test('rejects model identifiers that could be read as options or values', () => {
  for (const modelId of [
    '-x',
    '--dangerously-skip-permissions',
    'a b',
    'a=b',
    'opus;rm',
    '"opus"',
    '',
    '   ',
    'x'.repeat(201),
  ]) {
    const result = prepare(claudeAdapter, { ...request, modelId });
    assert.equal(result.ok ? 'ok' : result.code, 'model_invalid', JSON.stringify(modelId));
    assert.equal(cliModelIdSchema.safeParse(modelId).success, false);
  }
});

test('refuses an explicit model when the CLI does not list --model', () => {
  const result = prepare(codexAdapter, { ...request, modelId: 'o3' }, []);
  assert.equal(result.ok ? 'ok' : result.code, 'model_selection_unsupported');
  assert.ok(prepare(codexAdapter, request, []).ok, 'Default still works');
});

test('rejects unsupported invocation options and malformed requests', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...request, resumeSessionId: 'abc' }, 'resume_unsupported'],
    [{ ...request, extraArgs: ['--dangerously-skip-permissions'] }, 'invalid_request'],
    [{ ...request, workingDirectory: 'relative/path' }, 'invalid_request'],
    [{ ...request, workingDirectory: '/tmp/a/../b' }, 'invalid_request'],
    [{ ...request, prompt: '   ' }, 'invalid_request'],
    [{ ...request, prompt: 'a\0b' }, 'invalid_request'],
    [{ ...request, runId: '../run' }, 'invalid_request'],
    [{ ...request, timeoutMs: 0 }, 'invalid_request'],
    [{ ...request, modelId: undefined }, 'model_invalid'],
  ];
  for (const [input, code] of cases) {
    const result = prepare(claudeAdapter, input);
    assert.equal(result.ok ? 'ok' : result.code, code, JSON.stringify(input));
  }
  const mismatch = claudeAdapter.prepareExecution(installation('codex'), request, {
    sourceEnvironment,
  });
  assert.equal(mismatch.ok ? 'ok' : mismatch.code, 'installation_mismatch');
});

test('final arguments are checked against the security deny list and adapter rules', () => {
  const rejected = (args: string[]) => findRejectedArguments(claudeAdapterSpecification, args);
  assert.deepEqual(rejected(['--print', '--output-format', 'stream-json']), []);
  assert.equal(rejected(['--dangerously-skip-permissions']).length, 1);
  assert.equal(rejected(['--permission-mode', 'bypassPermissions']).length, 1);
  assert.equal(rejected(['--fallback-model', 'sonnet']).length, 1);
  assert.equal(rejected(['--resume=abc']).length, 1);
  assert.equal(rejected(['--worktree']).length, 1);
});

test('passes an allow-listed environment and never includes values in the plan', () => {
  const claude = prepare(claudeAdapter, request);
  const codex = prepare(codexAdapter, request);
  assert.ok(claude.ok && codex.ok);
  assert.deepEqual(claude.plan.environmentNames, [
    'CLAUDE_CONFIG_DIR',
    'GIT_TERMINAL_PROMPT',
    'HOME',
    'LANG',
    'NO_COLOR',
    'PATH',
    'TERM',
  ]);
  assert.ok(codex.plan.environmentNames.includes('CODEX_HOME'));
  assert.ok(!codex.plan.environmentNames.includes('CLAUDE_CONFIG_DIR'));
  const environment = claudeAdapter.buildEnvironment(sourceEnvironment);
  for (const name of [
    'GIT_DIR',
    'GIT_CONFIG_GLOBAL',
    'SSH_AUTH_SOCK',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
  ]) {
    assert.equal(environment[name], undefined, name);
  }
  assert.ok(!JSON.stringify(claude.plan).includes('/Users/someone'));
});

test('adapters reuse the shipped security profiles and claim no enforcement', () => {
  assert.equal(claudeAdapter.securityProfile, runtimeSecurityProfiles.claude);
  assert.equal(codexAdapter.securityProfile, runtimeSecurityProfiles.codex);
  for (const adapter of [claudeAdapter, codexAdapter]) {
    assert.equal(adapter.securityProfile.assessedVersion, null);
    assert.ok(
      adapter.securityProfile.capabilities.every((entry) => entry.verification === 'unverified'),
    );
  }
});
