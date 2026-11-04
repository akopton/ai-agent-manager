import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  AgentAdapter,
  AgentOutputEvent,
  AgentRunOutcome,
  CliDetection,
  CliInstallation,
  LingeringProcessState,
} from '@ai-agent-manager/agents';
import { classifyRunOutcome, startSupervisedProcess } from '@ai-agent-manager/agents/diagnostics';
import type { DiagnosticFixture } from './fixture.js';
import {
  readFakeInvocation,
  setFakeScenario,
  verifyFakeCli,
  type FakeCli,
  type FakeInvocation,
  type FakeStep,
} from './fake-cli.js';
import { createToolEventScanner, type ToolEventScan } from './tool-events.js';

export type FakeRunInput = {
  fixture: DiagnosticFixture;
  adapter: AgentAdapter;
  fake: FakeCli;
  steps: FakeStep[];
  prompt?: string;
  modelId?: string | null;
  timeoutMs?: number;
  stopGraceMs?: number;
  maxStdoutBytes?: number;
  maxLineBytes?: number;
  /** Polled every 25 ms; once it returns true the run is stopped (`requested`). */
  stopWhen?: () => Promise<boolean>;
  /** Strings identifying a probe target in tool events. */
  toolEventNeedles?: readonly string[];
};

export type FakeRunResult = {
  installation: CliInstallation;
  /** The adapter's prepared arguments: exactly what production would pass. */
  preparedArgs: readonly string[];
  outcome: AgentRunOutcome;
  lingeringProcesses: LingeringProcessState;
  eventCounts: Record<string, number>;
  diagnosticCodes: string[];
  sessionId?: string;
  reportedModelId?: string;
  canaryObserved: boolean;
  toolEvents: ToolEventScan;
  invocation: FakeInvocation | null;
  stdoutBytes: number;
};

/** A minimal synthetic environment: no user credentials, `HOME` inside the fixture. */
export const fakeSourceEnvironment = (fixture: DiagnosticFixture): NodeJS.ProcessEnv => ({
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: fixture.manifest.paths.home,
  TMPDIR: fixture.manifest.paths.home,
  LANG: 'C',
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Detects a fake CLI through the real adapter discovery (`--version` and help only). */
export const detectFake = async (
  fixture: DiagnosticFixture,
  adapter: AgentAdapter,
  fake: FakeCli,
): Promise<CliDetection> => {
  await verifyFakeCli(fixture, fake);
  return adapter.detect({
    executablePath: fake.executablePath,
    sourceEnvironment: fakeSourceEnvironment(fixture),
    probeDirectory: fixture.manifest.paths.home,
    timeoutMs: 10_000,
  });
};

/**
 * Runs a harness-generated fake CLI through the production adapter pieces: discovery, prepared
 * arguments, allow-listed environment, the process supervisor, the output parser and the outcome
 * classifier. It is **not** `startAgentExecution` and needs no authorization because it refuses any
 * executable that is not this fixture's verified fake CLI.
 */
export const runFakeCli = async (input: FakeRunInput): Promise<FakeRunResult> => {
  const { fixture, adapter, fake } = input;
  await setFakeScenario(fixture, fake, { steps: input.steps });
  const detection = await detectFake(fixture, adapter, fake);
  if (detection.status !== 'available') {
    throw new Error(`The fake CLI was not detected: ${detection.reason}: ${detection.message}`);
  }
  const { installation } = detection;
  const prompt = input.prompt ?? 'Synthetic diagnostics prompt.';
  const modelId = input.modelId ?? null;
  const sourceEnvironment = fakeSourceEnvironment(fixture);
  const preparation = adapter.prepareExecution(
    installation,
    {
      runId: 'diagnostics',
      prompt,
      modelId,
      workingDirectory: fixture.manifest.paths.assignedWorktree,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
    { sourceEnvironment },
  );
  if (!preparation.ok) {
    throw new Error(`The adapter refused to prepare the run: ${preparation.code}`);
  }
  const { plan } = preparation;
  // Re-verify immediately before spawning; the plan must point at the verified fake.
  await verifyFakeCli(fixture, fake);
  if (plan.executablePath !== fake.executablePath) {
    throw new Error('The prepared executable is not the verified fake CLI.');
  }

  const parser = adapter.createOutputParser({ explicitModel: modelId !== null });
  const scanner = createToolEventScanner(adapter.runtime, input.toolEventNeedles ?? []);
  const eventCounts: Record<string, number> = {};
  const diagnosticCodes = new Set<string>();
  let sessionId: string | undefined;
  let reportedModelId: string | undefined;
  let canaryObserved = false;
  let lastStderrLine: string | null = null;
  const token = fixture.manifest.canaryToken;
  const count = (event: AgentOutputEvent): void => {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    if (event.type === 'diagnostic') diagnosticCodes.add(event.code);
    if (event.type === 'metadata') {
      sessionId = event.sessionId ?? sessionId;
      reportedModelId = event.reportedModelId ?? reportedModelId;
    }
  };

  const supervised = startSupervisedProcess(
    {
      executablePath: plan.executablePath,
      args: plan.args,
      cwd: plan.cwd,
      env: adapter.buildEnvironment(sourceEnvironment),
      stdin: prompt,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      stopGraceMs: input.stopGraceMs ?? 500,
      maxStdoutBytes: input.maxStdoutBytes ?? 8 * 1024 * 1024,
      maxLineBytes: input.maxLineBytes ?? 1024 * 1024,
    },
    {
      onStarted: () => undefined,
      onStdoutLine: (line) => {
        if (line.text.includes(token)) canaryObserved = true;
        if (line.truncated) {
          diagnosticCodes.add('line_truncated');
          return;
        }
        scanner.push(line.text);
        for (const event of parser.parseLine(line.text)) count(event);
      },
      onStderrLine: (line) => {
        if (line.text.includes(token)) canaryObserved = true;
        if (line.text.trim() !== '') lastStderrLine = line.text.slice(0, 500);
      },
      onTerminating: () => undefined,
    },
  );

  let finished = false;
  const stopper = (async () => {
    if (input.stopWhen === undefined) return;
    const deadline = Date.now() + (input.timeoutMs ?? 30_000);
    while (!finished && Date.now() < deadline) {
      if (await input.stopWhen()) {
        supervised.terminate('requested');
        return;
      }
      await delay(25);
    }
  })();
  const exit = await supervised.exited;
  finished = true;
  await stopper;

  return {
    installation,
    preparedArgs: plan.args,
    outcome: classifyRunOutcome(exit, parser, lastStderrLine, {
      timeoutMs: input.timeoutMs,
      explicitModel: modelId !== null,
    }),
    lingeringProcesses: exit.lingeringProcesses,
    eventCounts,
    diagnosticCodes: [...diagnosticCodes].sort(),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(reportedModelId === undefined ? {} : { reportedModelId }),
    canaryObserved,
    toolEvents: scanner.result(),
    invocation: await readFakeInvocation(fake),
    stdoutBytes: exit.stdoutBytes,
  };
};

export const promptDigest = (prompt: string): string =>
  createHash('sha256').update(prompt).digest('hex');
