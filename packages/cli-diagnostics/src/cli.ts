import { writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { parseArgs } from 'node:util';
import { getAgentAdapter } from '@ai-agent-manager/agents';
import { agentRuntimes, agentRuntimeSchema, type AgentRuntime } from '@ai-agent-manager/core';
import { fakeCompatibility, staticCompatibility } from './compatibility.js';
import { createFakeCli } from './fake-cli.js';
import {
  cleanupFixture,
  createDiagnosticFixture,
  manualCleanupInstructions,
  readManifest,
  withDiagnosticFixture,
  writeManifest,
} from './fixture.js';
import { startLoopbackEndpoint } from './evidence.js';
import { endpointHitsFile, evaluateRealProbe, prepareRealProbe, runFakeProbe } from './probes.js';
import { replayCapturedOutput, type ReplayTermination } from './replay.js';
import { createReport, writeReport, type CompatibilityResult, type ProbeResult } from './report.js';
import { probeScenarioIdSchema, probeScenarioIds, probeScenarios } from './scenarios.js';

const usage = `AI Agent Manager CLI diagnostics (development tooling; never authorizes production runs)

Usage: pnpm --filter @ai-agent-manager/cli-diagnostics diagnostics <command> [options]

Commands:
  scenarios                       Print the security probe scenario catalog (JSON).
  static [--runtime r]            Inspect installed CLIs with --version/--help only; print a report.
  self-test [--runtime r]         Fake-CLI compatibility checks and probes in a disposable fixture.
  prepare --runtime r --scenario s [--parent dir]
                                  Create a preserved fixture and operator instructions for a future
                                  supervised real run. Starts no agent; the probe is reported blocked.
  serve-endpoint --manifest m     Run the loopback endpoint for a prepared network probe (Ctrl+C).
  evaluate --manifest m --runtime r --scenario s --cli-version v --isolation text [--events f]
           [--operator-stopped-run]
                                  Collect evidence after an operator-performed real run.
  replay --runtime r --events f (--exit-code n | --signal SIG) [--stopped] [--explicit-model]
         [--max-stdout-bytes n]
                                  Offline: parse captured CLI stdout with the production parser
                                  and outcome classifier. Starts no process.
  cleanup --manifest m [--include-results]
                                  Remove a fixture after ownership checks.
`;

const parseRuntimes = (value: string | undefined): AgentRuntime[] =>
  value === undefined ? [...agentRuntimes] : [agentRuntimeSchema.parse(value)];

const required = (value: string | undefined, name: string): string => {
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required.`);
  return value;
};

const parseInteger = (value: string, name: string): number => {
  if (!/^\d{1,12}$/.test(value)) throw new Error(`--${name} must be a non-negative integer.`);
  return Number(value);
};

/** Parses how the captured process ended. Exactly one of --exit-code and --signal is required. */
const parseTermination = (values: {
  'exit-code'?: string;
  signal?: string;
  stopped?: boolean;
}): ReplayTermination => {
  const exitCode =
    values['exit-code'] === undefined ? null : parseInteger(values['exit-code'], 'exit-code');
  if (exitCode !== null && exitCode > 255) throw new Error('--exit-code must be 0-255.');
  let signal: NodeJS.Signals | null = null;
  if (values.signal !== undefined) {
    const name = values.signal;
    if (!Object.hasOwn(constants.signals, name)) {
      throw new Error(`--signal must be a signal name such as SIGTERM.`);
    }
    signal = name as NodeJS.Signals;
  }
  if ((exitCode === null) === (signal === null)) {
    throw new Error('Give exactly one of --exit-code and --signal.');
  }
  if (values.stopped === true) return { kind: 'stop_requested', exitCode, signal };
  if (exitCode !== null) return { kind: 'exited', exitCode };
  if (signal !== null) return { kind: 'signaled', signal };
  throw new Error('Give exactly one of --exit-code and --signal.');
};

const summarize = (compatibility: CompatibilityResult[], probes: ProbeResult[]): string => {
  const lines = compatibility
    .filter((entry) => entry.status !== 'not_run')
    .map((entry) => `  ${entry.runtime} ${entry.checkId} [${entry.verification}] ${entry.status}`);
  for (const probe of probes) {
    lines.push(
      `  ${probe.runtime} probe ${probe.scenarioId} [${probe.testType}/${probe.status}] attempt=${probe.attempt} outcome=${probe.outcome} verdict=${probe.verdict}`,
    );
  }
  return lines.join('\n');
};

const main = async (): Promise<number> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      runtime: { type: 'string' },
      scenario: { type: 'string' },
      manifest: { type: 'string' },
      events: { type: 'string' },
      'cli-version': { type: 'string' },
      isolation: { type: 'string' },
      'include-results': { type: 'boolean' },
      'operator-stopped-run': { type: 'boolean' },
      parent: { type: 'string' },
      'exit-code': { type: 'string' },
      signal: { type: 'string' },
      stopped: { type: 'boolean' },
      'explicit-model': { type: 'boolean' },
      'max-stdout-bytes': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (command === undefined || values.help === true) {
    process.stdout.write(usage);
    return command === undefined && values.help !== true ? 1 : 0;
  }

  switch (command) {
    case 'scenarios':
      process.stdout.write(`${JSON.stringify(Object.values(probeScenarios), null, 2)}\n`);
      return 0;

    case 'static': {
      const compatibility: CompatibilityResult[] = [];
      for (const runtime of parseRuntimes(values.runtime)) {
        // Discovery runs only `--version` and the help command, with an allow-listed environment.
        const detection = await getAgentAdapter(runtime).detect();
        compatibility.push(...staticCompatibility(runtime, detection));
      }
      process.stdout.write(
        `${JSON.stringify(createReport({ fixtureId: null, compatibility }), null, 2)}\n`,
      );
      return 0;
    }

    case 'self-test': {
      const runtimes = parseRuntimes(values.runtime);
      return withDiagnosticFixture(
        async (fixture) => {
          const compatibility: CompatibilityResult[] = [];
          const probes: ProbeResult[] = [];
          for (const runtime of runtimes) {
            const adapter = getAgentAdapter(runtime);
            compatibility.push(...(await fakeCompatibility(fixture, adapter)));
            const fake = await createFakeCli(fixture, runtime, { name: `${runtime}-probe` });
            for (const scenario of probeScenarioIds) {
              probes.push(await runFakeProbe(fixture, adapter, fake, scenario, 'attempt'));
            }
            probes.push(
              await runFakeProbe(fixture, adapter, fake, 'write_outside_worktree', 'refuse'),
            );
          }
          const report = createReport({
            fixtureId: fixture.manifest.fixtureId,
            compatibility,
            probes,
          });
          const path = await writeReport(fixture.manifest.resultsDirectory, 'self-test', report);
          process.stdout.write(`${summarize(compatibility, probes)}\nReport: ${path}\n`);
          const failed = compatibility.filter((entry) => entry.status === 'failed');
          return failed.length === 0 ? 0 : 1;
        },
        { keepResults: true },
      );
    }

    case 'prepare': {
      const runtime = agentRuntimeSchema.parse(required(values.runtime, 'runtime'));
      const scenario = probeScenarioIdSchema.parse(required(values.scenario, 'scenario'));
      const adapter = getAgentAdapter(runtime);
      const fixture = await createDiagnosticFixture(
        values.parent === undefined ? {} : { parentDirectory: values.parent },
      );
      fixture.manifest.preserved = true;
      await writeManifest(fixture);
      const detection = await adapter.detect();
      const probe = await prepareRealProbe(fixture, adapter, scenario, detection);
      const path = await writeReport(
        fixture.manifest.resultsDirectory,
        `prepare-${runtime}-${scenario.replaceAll('_', '-')}`,
        createReport({
          fixtureId: fixture.manifest.fixtureId,
          compatibility: staticCompatibility(runtime, detection),
          probes: [probe],
        }),
      );
      process.stdout.write(
        [
          `Prepared (blocked, nothing was run): ${probe.blockers.join('\n  ')}`,
          `Operator instructions: ${fixture.manifest.paths.operator}`,
          `Manifest: ${fixture.manifestPath}`,
          `Report: ${path}`,
          manualCleanupInstructions(fixture),
          '',
        ].join('\n'),
      );
      return 0;
    }

    case 'serve-endpoint': {
      const fixture = await readManifest(required(values.manifest, 'manifest'));
      const endpoint = await startLoopbackEndpoint(fixture.manifest);
      const hitsFile = endpointHitsFile(fixture);
      const record = async () =>
        writeFile(hitsFile, JSON.stringify({ port: endpoint.port, hits: endpoint.hits() }), {
          mode: 0o600,
        });
      await record();
      process.stdout.write(`Loopback endpoint on 127.0.0.1:${endpoint.port}. Ctrl+C to stop.\n`);
      const timer = setInterval(() => void record(), 500);
      await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
      clearInterval(timer);
      await record();
      await endpoint.close();
      return 0;
    }

    case 'evaluate': {
      const fixture = await readManifest(required(values.manifest, 'manifest'));
      const runtime = agentRuntimeSchema.parse(required(values.runtime, 'runtime'));
      const scenario = probeScenarioIdSchema.parse(required(values.scenario, 'scenario'));
      const probe = await evaluateRealProbe(fixture, runtime, scenario, {
        cliVersion: required(values['cli-version'], 'cli-version'),
        isolation: required(values.isolation, 'isolation'),
        ...(values.events === undefined ? {} : { eventsFile: values.events }),
        operatorStoppedRun: values['operator-stopped-run'] === true,
      });
      const path = await writeReport(
        fixture.manifest.resultsDirectory,
        `evaluate-${runtime}-${scenario.replaceAll('_', '-')}-${Date.now()}`,
        createReport({ fixtureId: fixture.manifest.fixtureId, probes: [probe] }),
      );
      process.stdout.write(`${summarize([], [probe])}\nReport: ${path}\n`);
      return 0;
    }

    case 'replay': {
      const runtime = agentRuntimeSchema.parse(required(values.runtime, 'runtime'));
      const result = await replayCapturedOutput({
        adapter: getAgentAdapter(runtime),
        eventsFile: required(values.events, 'events'),
        termination: parseTermination(values),
        explicitModel: values['explicit-model'] === true,
        ...(values['max-stdout-bytes'] === undefined
          ? {}
          : { maxStdoutBytes: parseInteger(values['max-stdout-bytes'], 'max-stdout-bytes') }),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    case 'cleanup': {
      const fixture = await readManifest(required(values.manifest, 'manifest'));
      const result = await cleanupFixture(fixture, {
        includeResults: values['include-results'] === true,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === 'removed' ? 0 : 1;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n${usage}`);
      return 1;
  }
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
