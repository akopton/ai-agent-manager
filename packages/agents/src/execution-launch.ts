import { realpath, stat } from 'node:fs/promises';
import {
  assessControl,
  executionSecurityPolicySchema,
  requiredSecurityControls,
  type ExecutableIdentity,
  type ExecutionAuthorization,
} from '@ai-agent-manager/core';
import type {
  AgentAdapter,
  AgentEvent,
  AgentExecutionRequest,
  AgentHandle,
  AgentLifecycleEvent,
  AgentOutputEvent,
  AgentRunResult,
  CliInstallation,
  InvocationErrorCode,
} from './contract.js';
import { fingerprintExecutable } from './discovery.js';
import { digestEnvironment } from './environment.js';
import { shortText } from './output-parsing.js';
import { startSupervisedProcess } from './process-supervisor.js';
import { classifyRunOutcome } from './run-outcome.js';

export type ExecutionLimits = {
  /** SIGTERM → SIGKILL grace period. Default 10 s (as in the PoC). */
  stopGraceMs: number;
  /** Total stdout before the run is terminated. Default 32 MiB. */
  maxStdoutBytes: number;
  /** Per-line limit for stdout and stderr; longer lines are truncated. Default 1 MiB. */
  maxLineBytes: number;
  /** Stderr text delivered as events; the rest is counted but not delivered. Default 256 KiB. */
  maxStderrEventBytes: number;
  /** An authorization older than this is refused. Default 60 s. */
  maxAuthorizationAgeMs: number;
};

export const defaultExecutionLimits: Readonly<ExecutionLimits> = Object.freeze({
  stopGraceMs: 10_000,
  maxStdoutBytes: 32 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxStderrEventBytes: 256 * 1024,
  maxAuthorizationAgeMs: 60_000,
});

export type StartAgentExecutionInput = {
  adapter: AgentAdapter;
  /** From `adapter.detect()`; its version must equal `authorization.runtimeVersion`. */
  installation: CliInstallation;
  request: AgentExecutionRequest;
  /** From the orchestrator's `authorizeAgentExecution`, obtained immediately before this call. */
  authorization: ExecutionAuthorization;
  /** Receives every event in order. Must not throw: a throwing handler terminates the run. */
  emit: (event: AgentEvent) => void;
  limits?: Partial<ExecutionLimits>;
  /** Source of the allow-listed child environment; defaults to `process.env`. */
  sourceEnvironment?: NodeJS.ProcessEnv;
  now?: () => Date;
};

export type LaunchRejectionCode =
  'authorization_mismatch' | 'executable_changed' | InvocationErrorCode;

export type StartAgentExecutionResult =
  | { started: true; handle: AgentHandle }
  | { started: false; code: LaunchRejectionCode; message: string };

/** Authorizations are single use, so a cached authorization cannot launch a second run. */
const consumedAuthorizations = new WeakSet<object>();

const sameArguments = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Checks the authorization against the trusted adapter profile and the detected installation. */
const checkAuthorization = (
  input: StartAgentExecutionInput,
  limits: ExecutionLimits,
  now: Date,
): string | null => {
  const { adapter, installation, authorization, request } = input;
  if (consumedAuthorizations.has(authorization)) {
    return 'This authorization was already used; authorize again for every launch.';
  }
  if (authorization.runtime !== adapter.runtime || installation.runtime !== adapter.runtime) {
    return `Runtime mismatch: adapter ${adapter.runtime}, installation ${installation.runtime}, authorization ${authorization.runtime}.`;
  }
  if (
    authorization.runtimeVersion === null ||
    authorization.runtimeVersion !== installation.version
  ) {
    return `The authorization was issued for CLI version ${authorization.runtimeVersion ?? 'unknown'}, but the installation is ${installation.version}.`;
  }
  const profile = adapter.securityProfile;
  if (
    authorization.launchProfileId !== profile.id ||
    !sameArguments(authorization.launchArguments, profile.launchArguments)
  ) {
    return `The authorization does not match launch profile "${profile.id}".`;
  }
  const policy = executionSecurityPolicySchema.safeParse(authorization.policy);
  if (!policy.success) {
    return 'The authorization carries an invalid security policy.';
  }
  for (const control of requiredSecurityControls(policy.data)) {
    const authorized = authorization.controls.some(
      (entry) => entry.control === control && entry.status === 'enforced',
    );
    // Defense in depth: the trusted profile itself must enforce the control for this version.
    const assessment = assessControl(profile, control, installation.version);
    if (!authorized || assessment.status !== 'enforced') {
      return `Required control "${control}" is not enforced (${assessment.status}).`;
    }
  }
  const checkedAt = Date.parse(authorization.checkedAt);
  const age = now.getTime() - checkedAt;
  if (!Number.isFinite(checkedAt) || age > limits.maxAuthorizationAgeMs || age < -5_000) {
    return `The authorization from ${authorization.checkedAt} is stale; authorize immediately before launch.`;
  }
  if (request.workingDirectory !== authorization.workspace.workingDirectory) {
    return 'The working directory differs from the authorized workspace.';
  }
  return null;
};

type RunState = {
  sequence: number;
  sessionId?: string;
  reportedModelId?: string;
  stderrEventBytes: number;
  stderrTruncationReported: boolean;
  lastStderrLine: string | null;
};

/**
 * The only way to launch an agent CLI. Refuses unless the `ExecutionAuthorization` matches the
 * trusted adapter profile, the detected installation, and the request; every required control is
 * enforced (by the authorization **and** the shipped profile); the authorization is fresh and
 * unused; the prepared arguments pass the deny lists; the working directory is canonical; and the
 * executable is unchanged since discovery. Then it spawns exactly the prepared argument array in
 * the authorized working directory with an allow-listed environment.
 *
 * With the shipped (unverified) profiles every launch is refused. That is intended.
 */
export const startAgentExecution = async (
  input: StartAgentExecutionInput,
): Promise<StartAgentExecutionResult> => {
  const limits: ExecutionLimits = { ...defaultExecutionLimits, ...input.limits };
  const clock = input.now ?? (() => new Date());
  const { adapter, installation, request, authorization } = input;
  const reject = (code: LaunchRejectionCode, message: string): StartAgentExecutionResult => ({
    started: false,
    code,
    message,
  });

  const authorizationProblem = checkAuthorization(input, limits, clock());
  if (authorizationProblem !== null) {
    return reject('authorization_mismatch', authorizationProblem);
  }
  const sourceEnvironment = input.sourceEnvironment ?? process.env;
  const preparation = adapter.prepareExecution(installation, request, { sourceEnvironment });
  if (!preparation.ok) {
    return reject(preparation.code, preparation.message);
  }
  const { plan } = preparation;
  const environment = adapter.buildEnvironment(sourceEnvironment);
  const authorized = authorization.invocation;
  const expected = installation.fingerprint;
  // The authorization must cover exactly this launch: the discovered binary, every argument, and
  // the environment that will be passed. Any difference means something changed after the gate.
  const sameExecutable = (identity: ExecutableIdentity): boolean =>
    identity.path === installation.executablePath &&
    identity.dev === expected.dev &&
    identity.ino === expected.ino &&
    identity.size === expected.size &&
    identity.mtimeMs === expected.mtimeMs;
  if (
    !sameExecutable(authorized.executable) ||
    !sameExecutable(plan.invocation.executable) ||
    plan.executablePath !== installation.executablePath
  ) {
    return reject(
      'authorization_mismatch',
      'The authorized executable is not the detected installation.',
    );
  }
  if (
    !sameArguments(authorized.arguments, plan.args) ||
    !sameArguments(
      plan.args.slice(0, authorization.launchArguments.length),
      authorization.launchArguments,
    )
  ) {
    return reject(
      'authorization_mismatch',
      'The prepared arguments differ from the authorized arguments.',
    );
  }
  if (
    authorized.environmentDigest !== digestEnvironment(environment) ||
    !sameArguments(plan.environmentNames, Object.keys(environment).sort())
  ) {
    return reject(
      'authorization_mismatch',
      'The child environment differs from the authorized environment.',
    );
  }
  if (plan.cwd !== authorization.workspace.workingDirectory) {
    return reject('authorization_mismatch', 'The prepared working directory is not authorized.');
  }
  const cwdStats = await stat(plan.cwd).catch(() => null);
  const canonicalCwd = await realpath(plan.cwd).catch(() => null);
  if (cwdStats === null || !cwdStats.isDirectory() || canonicalCwd !== plan.cwd) {
    return reject('authorization_mismatch', 'The working directory is missing or not canonical.');
  }
  const canonicalExecutable = await realpath(plan.executablePath).catch(() => null);
  const fingerprint = await fingerprintExecutable(plan.executablePath).catch(() => null);
  if (
    canonicalExecutable !== plan.executablePath ||
    fingerprint === null ||
    fingerprint.dev !== expected.dev ||
    fingerprint.ino !== expected.ino ||
    fingerprint.size !== expected.size ||
    fingerprint.mtimeMs !== expected.mtimeMs
  ) {
    return reject(
      'executable_changed',
      'The CLI executable changed after discovery; detect it again.',
    );
  }
  consumedAuthorizations.add(authorization);

  const parser = adapter.createOutputParser({ explicitModel: plan.modelId !== null });
  const startedAt = clock().toISOString();
  const state: RunState = {
    sequence: 0,
    stderrEventBytes: 0,
    stderrTruncationReported: false,
    lastStderrLine: null,
  };

  const deliver = (event: AgentOutputEvent | AgentLifecycleEvent): void => {
    state.sequence += 1;
    input.emit({
      runId: request.runId,
      runtime: adapter.runtime,
      sequence: state.sequence,
      timestamp: clock().toISOString(),
      ...event,
    });
  };
  const deliverOutput = (event: AgentOutputEvent): void => {
    if (event.type === 'metadata') {
      if (event.sessionId !== undefined) state.sessionId = event.sessionId;
      if (event.reportedModelId !== undefined) state.reportedModelId = event.reportedModelId;
    }
    deliver(event);
  };

  const supervised = startSupervisedProcess(
    {
      executablePath: plan.executablePath,
      args: plan.args,
      cwd: plan.cwd,
      env: environment,
      stdin: request.prompt,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      stopGraceMs: limits.stopGraceMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxLineBytes: limits.maxLineBytes,
    },
    {
      onStarted: (pid, processGroupId) => deliver({ type: 'started', pid, processGroupId }),
      onStdoutLine: (line) => {
        if (line.truncated) {
          deliver({
            type: 'diagnostic',
            code: 'line_truncated',
            message: `A stdout line exceeded ${limits.maxLineBytes} bytes and was discarded.`,
          });
          return;
        }
        for (const event of parser.parseLine(line.text)) deliverOutput(event);
      },
      onStderrLine: (line) => {
        if (line.text.trim() !== '') {
          state.lastStderrLine = shortText(line.text, 500);
        }
        const bytes = Buffer.byteLength(line.text);
        if (state.stderrEventBytes + bytes > limits.maxStderrEventBytes) {
          if (!state.stderrTruncationReported) {
            state.stderrTruncationReported = true;
            deliver({
              type: 'diagnostic',
              code: 'stderr_truncated',
              message: `Stderr exceeded ${limits.maxStderrEventBytes} bytes; further stderr is not delivered.`,
            });
          }
          return;
        }
        state.stderrEventBytes += bytes;
        deliver({ type: 'stderr', text: line.text, truncated: line.truncated });
      },
      onTerminating: (reason) => deliver({ type: 'stopping', reason }),
    },
  );

  const completed = supervised.exited.then((exit): AgentRunResult => {
    const outcome = classifyRunOutcome(exit, parser, state.lastStderrLine, {
      timeoutMs: request.timeoutMs,
      explicitModel: request.modelId !== null,
    });
    const result: AgentRunResult = Object.freeze({
      ...outcome,
      runId: request.runId,
      runtime: adapter.runtime,
      pid: exit.pid,
      startedAt,
      endedAt: clock().toISOString(),
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
      ...(state.reportedModelId === undefined ? {} : { reportedModelId: state.reportedModelId }),
      stdoutBytes: exit.stdoutBytes,
      stderrBytes: exit.stderrBytes,
      lingeringProcesses: exit.lingeringProcesses,
      processContainment: 'process_group_only',
    });
    try {
      if (exit.lingeringProcesses !== 'none') {
        deliver({
          type: 'diagnostic',
          code: 'lingering_processes',
          message:
            exit.lingeringProcesses === 'terminated'
              ? 'Processes left in the process group after the CLI exited were terminated.'
              : 'Processes in the process group could not be confirmed terminated.',
        });
      }
      deliver({ type: outcome.status, result });
    } catch {
      // The run is over; the result is still available through `completed`.
    }
    return result;
  });

  return {
    started: true,
    handle: {
      runId: request.runId,
      pid: supervised.pid,
      stop: () => {
        supervised.terminate('requested');
        return completed;
      },
      completed,
    },
  };
};
