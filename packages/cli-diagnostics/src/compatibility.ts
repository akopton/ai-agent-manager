import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { AgentAdapter, CliDetection } from '@ai-agent-manager/agents';
import type { AgentRuntime } from '@ai-agent-manager/core';
import { createFakeCli, readFakeChildPid, type FakeStep } from './fake-cli.js';
import { detectFake, promptDigest, runFakeCli, type FakeRunResult } from './fake-runner.js';
import { writeManifest, type DiagnosticFixture } from './fixture.js';
import { inspectTrackedProcess, terminateTrackedProcess } from './processes.js';
import {
  compatibilityCheckIds,
  type CompatibilityCheckId,
  type CompatibilityResult,
} from './report.js';

const result = (
  runtime: AgentRuntime,
  cliVersion: string | null,
  checkId: CompatibilityCheckId,
  verification: CompatibilityResult['verification'],
  passed: boolean | null,
  detail: string,
): CompatibilityResult => ({
  kind: 'compatibility',
  runtime,
  cliVersion,
  checkId,
  verification,
  status: passed === null ? 'not_run' : passed ? 'passed' : 'failed',
  detail: detail.slice(0, 2_000),
});

/** Checks that need a supervised run of the real CLI and are therefore not verified here. */
const runtimeOnlyChecks: readonly CompatibilityCheckId[] = compatibilityCheckIds.filter(
  (id) => !['cli_availability', 'version_support', 'required_options'].includes(id),
);

/**
 * Static compatibility from the real CLI's `--version` and help output (as collected by
 * `adapter.detect`). Everything that needs the CLI to run a prompt is reported `not_verified`.
 */
export const staticCompatibility = (
  runtime: AgentRuntime,
  detection: CliDetection,
): CompatibilityResult[] => {
  const version =
    detection.status === 'available' ? detection.installation.version : (detection.version ?? null);
  const level = 'static_inspection' as const;
  const results: CompatibilityResult[] = [];
  if (detection.status === 'available') {
    const { installation } = detection;
    results.push(
      result(runtime, version, 'cli_availability', level, true, 'Executable found and runnable.'),
      result(
        runtime,
        version,
        'version_support',
        level,
        true,
        `Version ${installation.version} is not older than the oldest assessed version.`,
      ),
      result(
        runtime,
        version,
        'required_options',
        level,
        true,
        `Help lists the required options; detected: ${installation.detectedOptions.join(', ')}.`,
      ),
    );
  } else {
    const failedCheck: CompatibilityCheckId =
      detection.reason === 'not_found' || detection.reason === 'not_executable'
        ? 'cli_availability'
        : detection.reason === 'options_missing' || detection.reason === 'help_failed'
          ? 'required_options'
          : 'version_support';
    results.push(
      result(
        runtime,
        version,
        failedCheck,
        level,
        false,
        `${detection.reason}: ${detection.message}`,
      ),
    );
  }
  for (const checkId of runtimeOnlyChecks) {
    results.push(
      result(
        runtime,
        version,
        checkId,
        'not_verified',
        null,
        'Requires a supervised real CLI run (operator approval, authentication and isolation); not performed.',
      ),
    );
  }
  return results;
};

const claudeEvents = {
  init: JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'fake-session',
    model: 'fake-model',
  }),
  message: JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Synthetic progress.' }] },
  }),
  success: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }),
  failure: JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'Synthetic provider failure.',
  }),
};

const codexEvents = {
  init: JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }),
  message: JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: 'Synthetic progress.' },
  }),
  success: JSON.stringify({ type: 'turn.completed', usage: {} }),
  failure: JSON.stringify({
    type: 'turn.failed',
    error: { message: 'Synthetic provider failure.' },
  }),
};

/** Runtime-shaped success output used by fake runs and probes. */
export const fakeEvents = (runtime: AgentRuntime) =>
  runtime === 'claude' ? claudeEvents : codexEvents;

export const successSteps = (runtime: AgentRuntime): FakeStep[] => {
  const events = fakeEvents(runtime);
  return [{ stdout: events.init }, { stdout: events.message }, { stdout: events.success }];
};

const outputFormatOption: Readonly<Record<AgentRuntime, readonly string[]>> = {
  claude: ['--output-format', 'stream-json'],
  codex: ['--json'],
};

const containsSequence = (args: readonly string[], sequence: readonly string[]): boolean =>
  args.some((_, index) => sequence.every((value, offset) => args[index + offset] === value));

/**
 * Runs every fake-CLI compatibility check for one runtime inside the fixture. Fake results show
 * that the adapter, parser and supervisor handle the modeled behavior; they are never reported as
 * real CLI compatibility.
 */
export const fakeCompatibility = async (
  fixture: DiagnosticFixture,
  adapter: AgentAdapter,
): Promise<CompatibilityResult[]> => {
  const runtime = adapter.runtime;
  const level = 'fake_cli' as const;
  const fake = await createFakeCli(fixture, runtime);
  const events = fakeEvents(runtime);
  const results: CompatibilityResult[] = [];
  const add = (checkId: CompatibilityCheckId, passed: boolean, detail: string, version: string) =>
    results.push(result(runtime, version, checkId, level, passed, detail));
  const run = (steps: FakeStep[], extra: Partial<Parameters<typeof runFakeCli>[0]> = {}) =>
    runFakeCli({ fixture, adapter, fake, steps, ...extra });

  // Availability and version handling, through the real discovery code.
  const available = await detectFake(fixture, adapter, fake);
  const version = available.status === 'available' ? available.installation.version : 'fake';
  add(
    'cli_availability',
    available.status === 'available',
    `Fake detection: ${available.status}.`,
    version,
  );
  const missingDirectory = join(fixture.manifest.paths.fakeBin, 'empty-search-path');
  await mkdir(missingDirectory, { recursive: true });
  const missing = await adapter.detect({ searchPath: [missingDirectory] });
  const old = await createFakeCli(fixture, runtime, {
    name: `${runtime}-old`,
    version: runtime === 'claude' ? '2.0.0 (Claude Code)' : 'codex-cli 0.100.0',
  });
  const oldDetection = await detectFake(fixture, adapter, old);
  add(
    'version_support',
    missing.status === 'unavailable' &&
      missing.reason === 'not_found' &&
      oldDetection.status === 'unavailable' &&
      oldDetection.reason === 'version_unsupported',
    `Missing CLI → ${missing.status === 'unavailable' ? missing.reason : 'available'}; old version → ${oldDetection.status === 'unavailable' ? oldDetection.reason : 'available'}.`,
    version,
  );

  const prompt = `Synthetic prompt ${randomBytes(8).toString('hex')}`;
  const success = await run(successSteps(runtime), { prompt });
  const args = success.invocation?.args ?? [];
  add(
    'prompt_via_stdin',
    success.invocation?.stdinSha256 === promptDigest(prompt) && !args.includes(prompt),
    'The fake CLI received the prompt on stdin (compared by hash) and not as an argument.',
    version,
  );
  add(
    'structured_output_format',
    containsSequence(args, outputFormatOption[runtime]) &&
      args.length === success.preparedArgs.length &&
      args.every((value, index) => value === success.preparedArgs[index]),
    `Prepared arguments include ${outputFormatOption[runtime].join(' ')} and reached the CLI unchanged.`,
    version,
  );
  add(
    'provider_event_parsing',
    (success.eventCounts.message ?? 0) > 0 && success.sessionId !== undefined,
    `Parsed event counts: ${JSON.stringify(success.eventCounts)}.`,
    version,
  );
  add('terminal_success', success.outcome.status === 'completed', describe(success), version);

  const failure = await run([{ stdout: events.init }, { stdout: events.failure }, { exit: 1 }]);
  add(
    'terminal_failure',
    failure.outcome.status === 'failed' && failure.outcome.code === 'provider_error',
    describe(failure),
    version,
  );

  const malformed = await run([
    { stdout: '{not json' },
    { stdout: '[1,2,3]' },
    { stdout: JSON.stringify({ type: 'unknown.synthetic' }) },
    { stdout: events.success },
  ]);
  add(
    'malformed_output',
    malformed.diagnosticCodes.includes('malformed_output') &&
      malformed.diagnosticCodes.includes('unrecognized_event'),
    `Diagnostics: ${malformed.diagnosticCodes.join(', ') || 'none'}; ${describe(malformed)}`,
    version,
  );
  const incomplete = await run([
    { stdout: events.init },
    { stdoutRaw: '{"type":"assist' },
    { exit: 0 },
  ]);
  add(
    'incomplete_output',
    incomplete.outcome.status === 'failed' && incomplete.outcome.code === 'incomplete_output',
    describe(incomplete),
    version,
  );

  const stopped = await run([{ stdout: events.init }, { hang: true }], {
    stopWhen: async () => true,
  });
  add(
    'stop_semantics',
    stopped.outcome.status === 'stopped',
    `${describe(stopped)} Outcome classification only: "stopped" says the stop was requested and the main process ended, not that every descendant ended.`,
    version,
  );

  const timedOut = await run([{ hang: true }], { timeoutMs: 300 });
  add(
    'timeout',
    timedOut.outcome.status === 'failed' && timedOut.outcome.code === 'timeout',
    describe(timedOut),
    version,
  );

  const flooded = await run([{ floodStdoutBytes: 512 * 1024 }, { hang: true }], {
    maxStdoutBytes: 64 * 1024,
  });
  add(
    'output_limit',
    flooded.outcome.status === 'failed' && flooded.outcome.code === 'output_limit_exceeded',
    describe(flooded),
    version,
  );

  const nonce = randomBytes(16).toString('hex');
  const lingering = await run([{ spawnGroupChild: { nonce } }, ...successSteps(runtime)]);
  const childPid = await readFakeChildPid(fake);
  if (childPid !== null) {
    fixture.manifest.trackedProcesses.push({ pid: childPid, nonce, kind: 'fake_group_child' });
    await writeManifest(fixture);
  }
  const childState =
    childPid === null
      ? 'not_started'
      : await inspectTrackedProcess({ pid: childPid, nonce, kind: 'fake_group_child' });
  if (childPid !== null && childState === 'running') {
    await terminateTrackedProcess({ pid: childPid, nonce, kind: 'fake_group_child' });
  }
  add(
    'process_group_cleanup',
    childPid !== null && lingering.lingeringProcesses === 'terminated' && childState === 'gone',
    `Supervisor process-group report: ${lingering.lingeringProcesses}; same-group child after exit: ${childState}. This covers the process group only: descendants that start their own session or group are not reached (see the stop_with_subprocesses probe).`,
    version,
  );

  for (const checkId of compatibilityCheckIds) {
    results.push(
      result(
        runtime,
        null,
        checkId,
        'not_verified',
        null,
        'Real CLI behavior for this check requires a supervised real run; not performed.',
      ),
    );
  }
  return results;
};

const describe = (run: FakeRunResult): string =>
  run.outcome.status === 'failed'
    ? `Outcome failed/${run.outcome.code}: ${run.outcome.message}`
    : `Outcome ${run.outcome.status}.`;
