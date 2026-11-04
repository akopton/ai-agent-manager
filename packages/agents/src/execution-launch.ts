import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import {
  assessControl,
  executionSecurityModeSchema,
  executionSecurityPolicySchema,
  requiredSecurityControls,
  securityControls,
  securityModeAuthorizationSchema,
  type ExecutableIdentity,
  type ExecutionSecurityMode,
  type SecurityModeAuthorization,
  type StrictExecutionAuthorization,
  type TrustedLocalExecutionAuthorization,
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
import { startSupervisedProcess, supervisorUsesProcessGroups } from './process-supervisor.js';
import { getAgentAdapter } from './registry.js';
import { classifyRunOutcome } from './run-outcome.js';
import { redeemTrustedLocalAuthorization } from './trusted-local-issuance.js';
import { isSupportedCliVersion } from './version-support.js';

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
  /**
   * The security mode the caller snapshotted for this run. It must equal `authorization.mode`; the
   * launch boundary never infers, selects or converts a mode.
   */
  securityMode: ExecutionSecurityMode;
  /**
   * Obtained immediately before this call from the gate for `securityMode`:
   * `authorizeAgentExecution` (Strict Isolated) or `authorizeTrustedLocalExecution` (Trusted
   * Local). Trusted Local authorizations must have been issued in this process for this exact
   * `request.runId` and `request.prompt`.
   */
  authorization: SecurityModeAuthorization;
  /** Receives every event in order. Must not throw: a throwing handler terminates the run. */
  emit: (event: AgentEvent) => void;
  /** In Trusted Local Mode limits may only be tightened; larger or non-finite values are refused. */
  limits?: Partial<ExecutionLimits>;
  /** Source of the allow-listed child environment; defaults to `process.env`. */
  sourceEnvironment?: NodeJS.ProcessEnv;
  /**
   * Strict Isolated Mode only. Trusted Local launches use the launch boundary's own clock for
   * freshness and refuse a caller-supplied clock.
   */
  now?: () => Date;
};

export type LaunchRejectionCode =
  | 'authorization_mismatch'
  /** `securityMode` and the authorization's mode differ, or the mode is missing or unknown. */
  | 'mode_mismatch'
  /** The launch would run as root, or the effective user is unknown (Trusted Local). */
  | 'elevated_privileges'
  /** A mandatory Trusted Local safeguard cannot be applied by this launch (limits, platform). */
  | 'safeguard_unavailable'
  | 'executable_changed'
  | InvocationErrorCode;

export type StartAgentExecutionResult =
  | { started: true; handle: AgentHandle }
  | { started: false; code: LaunchRejectionCode; message: string };

/**
 * Process facts with security relevance. Only tests replace them (`createAgentExecutionLauncher`);
 * the exported `startAgentExecution` uses the real clock, effective UID and platform.
 */
export type LaunchBoundaryDependencies = {
  /** Clock for Trusted Local freshness and timestamps. */
  now: () => Date;
  /** Effective user ID of this process; `undefined` when unknown. */
  effectiveUid: () => number | undefined;
  /** Whether stop and timeout can signal the CLI's process group. */
  processGroupsSupported: boolean;
};

/**
 * Authorization IDs that launched a process, for both modes. A copy or deserialized form of a used
 * authorization carries the same ID and is refused. Trusted Local authorizations are additionally
 * consumed from the issuance registry on their first launch attempt.
 */
const consumedAuthorizationIds = new Set<string>();

/** Tolerated clock skew for `checkedAt` in the future. */
const maxClockSkewMs = 5_000;

type Rejection = { code: LaunchRejectionCode; message: string };

const mismatch = (message: string): Rejection => ({ code: 'authorization_mismatch', message });

const sameArguments = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const isWithin = (parent: string, child: string): boolean => {
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
};

const checkFreshness = (checkedAtText: string, maxAgeMs: number, now: Date): Rejection | null => {
  const checkedAt = Date.parse(checkedAtText);
  const age = now.getTime() - checkedAt;
  if (!Number.isFinite(checkedAt) || age > maxAgeMs || age < -maxClockSkewMs) {
    return mismatch(
      `The authorization from ${checkedAtText} is stale; authorize immediately before launch.`,
    );
  }
  return null;
};

/**
 * Strict Isolated Mode: checks the authorization against the trusted adapter profile and the
 * detected installation. Unchanged from before SEC-02c, apart from ID-based single use, which is
 * now consumed when these checks pass rather than immediately before `spawn`.
 */
const checkStrictAuthorization = (
  input: StartAgentExecutionInput,
  authorization: StrictExecutionAuthorization,
  limits: ExecutionLimits,
  now: Date,
): Rejection | null => {
  const { adapter, installation, request } = input;
  if (consumedAuthorizationIds.has(authorization.authorizationId)) {
    return mismatch('This authorization was already used; authorize again for every launch.');
  }
  if (authorization.runtime !== adapter.runtime || installation.runtime !== adapter.runtime) {
    return mismatch(
      `Runtime mismatch: adapter ${adapter.runtime}, installation ${installation.runtime}, authorization ${authorization.runtime}.`,
    );
  }
  if (
    authorization.runtimeVersion === null ||
    authorization.runtimeVersion !== installation.version
  ) {
    return mismatch(
      `The authorization was issued for CLI version ${authorization.runtimeVersion ?? 'unknown'}, but the installation is ${installation.version}.`,
    );
  }
  const profile = adapter.securityProfile;
  if (
    authorization.launchProfileId !== profile.id ||
    !sameArguments(authorization.launchArguments, profile.launchArguments)
  ) {
    return mismatch(`The authorization does not match launch profile "${profile.id}".`);
  }
  const policy = executionSecurityPolicySchema.safeParse(authorization.policy);
  if (!policy.success) {
    return mismatch('The authorization carries an invalid security policy.');
  }
  for (const control of requiredSecurityControls(policy.data)) {
    const authorized = authorization.controls.some(
      (entry) => entry.control === control && entry.status === 'enforced',
    );
    // Defense in depth: the trusted profile itself must enforce the control for this version.
    const assessment = assessControl(profile, control, installation.version);
    if (!authorized || assessment.status !== 'enforced') {
      return mismatch(`Required control "${control}" is not enforced (${assessment.status}).`);
    }
  }
  const stale = checkFreshness(authorization.checkedAt, limits.maxAuthorizationAgeMs, now);
  if (stale !== null) {
    return stale;
  }
  if (request.workingDirectory !== authorization.workspace.workingDirectory) {
    return mismatch('The working directory differs from the authorized workspace.');
  }
  return null;
};

/** Trusted Local limits may only be tightened: finite, positive and at most the default. */
const checkTrustedLocalLimits = (limits: ExecutionLimits): Rejection | null => {
  for (const name of Object.keys(defaultExecutionLimits) as (keyof ExecutionLimits)[]) {
    const value = limits[name];
    if (!Number.isFinite(value) || value <= 0 || value > defaultExecutionLimits[name]) {
      return {
        code: 'safeguard_unavailable',
        message: `Execution limit ${name} must be positive and at most ${defaultExecutionLimits[name]} in Trusted Local Mode.`,
      };
    }
  }
  return null;
};

/**
 * Trusted Local Mode. The authorization is first redeemed from the issuance registry, which
 * establishes that the orchestrator's Trusted Local gate issued exactly this object for exactly
 * this run and prompt, and consumes it. Everything the launch boundary can re-check locally is
 * then re-checked; nothing caller-supplied can add a privilege.
 */
const checkTrustedLocalAuthorization = (
  input: StartAgentExecutionInput,
  authorization: TrustedLocalExecutionAuthorization,
  limits: ExecutionLimits,
  dependencies: LaunchBoundaryDependencies,
): Rejection | null => {
  const { adapter, installation, request } = input;
  const redemption = redeemTrustedLocalAuthorization(authorization, {
    runId: request.runId,
    prompt: request.prompt,
  });
  if (!redemption.ok) {
    return mismatch(redemption.message);
  }
  if (consumedAuthorizationIds.has(authorization.authorizationId)) {
    return mismatch('This authorization was already used; authorize again for every launch.');
  }
  if (input.now !== undefined) {
    return mismatch('Trusted Local launches use the launch boundary clock; `now` is not accepted.');
  }
  const limitProblem = checkTrustedLocalLimits(limits);
  if (limitProblem !== null) {
    return limitProblem;
  }
  if (!dependencies.processGroupsSupported) {
    return {
      code: 'safeguard_unavailable',
      message: 'Process-group stop is not available on this platform.',
    };
  }
  if (authorization.safeguards.includes('post_run_git_integrity_check')) {
    return {
      code: 'safeguard_unavailable',
      message: 'The post-run Git integrity check is not implemented yet (SEC-02d).',
    };
  }
  const uid = dependencies.effectiveUid();
  if (uid === undefined || uid === 0) {
    return {
      code: 'elevated_privileges',
      message:
        uid === 0
          ? 'Agents must not run as root.'
          : 'The effective user could not be determined, so a non-elevated launch cannot be confirmed.',
    };
  }
  const runtime = authorization.runtime;
  // The gate prepared the invocation with the shipped adapter; nothing else may launch it.
  if (adapter !== getAgentAdapter(runtime) || installation.runtime !== runtime) {
    return mismatch(`The adapter or installation is not the shipped ${runtime} adapter.`);
  }
  if (
    authorization.runtimeVersion !== installation.version ||
    !isSupportedCliVersion(runtime, installation.version)
  ) {
    return mismatch(
      `The authorization was issued for ${runtime} ${authorization.runtimeVersion}, but the installation is ${installation.version}, or that version is unsupported.`,
    );
  }
  const profile = adapter.securityProfile;
  if (
    authorization.launchProfileId !== profile.id ||
    !sameArguments(authorization.launchArguments, profile.launchArguments)
  ) {
    return mismatch(`The authorization does not match launch profile "${profile.id}".`);
  }
  // Honest reporting: the assessments must be exactly what the shipped profile yields.
  const assessments = securityControls.map((control) =>
    assessControl(profile, control, installation.version),
  );
  const reported = authorization.controlAssessments;
  if (
    reported.length !== assessments.length ||
    assessments.some((expected, index) => {
      const actual = reported[index];
      return (
        actual === undefined ||
        actual.control !== expected.control ||
        actual.status !== expected.status ||
        actual.mechanism !== expected.mechanism ||
        actual.notes !== expected.notes
      );
    })
  ) {
    return mismatch('The control assessments differ from the shipped launch profile.');
  }
  const now = dependencies.now();
  const acceptedAt = Date.parse(authorization.policy.acceptance.acceptedAt);
  if (
    !Number.isFinite(acceptedAt) ||
    acceptedAt > Date.parse(authorization.checkedAt) ||
    acceptedAt > now.getTime()
  ) {
    return mismatch('The operator acceptance is later than the authorization.');
  }
  const stale = checkFreshness(authorization.checkedAt, limits.maxAuthorizationAgeMs, now);
  if (stale !== null) {
    return stale;
  }
  if (request.timeoutMs !== undefined && request.timeoutMs !== authorization.policy.timeoutMs) {
    return mismatch(
      `The request timeout differs from the authorized timeout of ${authorization.policy.timeoutMs} ms.`,
    );
  }
  const { workspace } = authorization;
  if (
    request.workingDirectory !== workspace.workingDirectory ||
    !isWithin(workspace.worktreePath, workspace.workingDirectory)
  ) {
    return mismatch('The working directory differs from the authorized worktree.');
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

type ModeCheck = {
  problem: Rejection | null;
  /** Clock for freshness (Strict) and event timestamps. */
  clock: () => Date;
  /** The wall-clock limit actually applied to the process. */
  timeoutMs: number | undefined;
};

/**
 * Creates the launch boundary with explicit process facts. Exported for tests only through this
 * module; the package entry point exports `startAgentExecution`, which uses the real ones.
 *
 * @internal
 */
export const createAgentExecutionLauncher =
  (dependencies: LaunchBoundaryDependencies) =>
  async (input: StartAgentExecutionInput): Promise<StartAgentExecutionResult> => {
    const limits: ExecutionLimits = { ...defaultExecutionLimits, ...input.limits };
    const { adapter, installation } = input;
    const reject = (code: LaunchRejectionCode, message: string): StartAgentExecutionResult => ({
      started: false,
      code,
      message,
    });

    // Full contract validation first: a malformed or mixed-mode object (for example a Trusted
    // Local authorization with strict `controls`) never reaches a mode-specific check.
    const parsed = securityModeAuthorizationSchema.safeParse(input.authorization);
    if (!parsed.success) {
      return reject(
        'authorization_mismatch',
        'The authorization is malformed or mixes security modes; authorize again.',
      );
    }
    const authorization = parsed.data;
    const requestedMode = executionSecurityModeSchema.safeParse(input.securityMode);
    if (!requestedMode.success || requestedMode.data !== authorization.mode) {
      return reject(
        'mode_mismatch',
        `The launch requested security mode ${JSON.stringify(input.securityMode ?? null)}, but the authorization is for "${authorization.mode}". Modes are never converted.`,
      );
    }

    const checkMode = (): ModeCheck => {
      switch (authorization.mode) {
        case 'strict_isolated': {
          const clock = input.now ?? dependencies.now;
          return {
            problem: checkStrictAuthorization(input, authorization, limits, clock()),
            clock,
            timeoutMs: input.request.timeoutMs,
          };
        }
        case 'trusted_local':
          return {
            problem: checkTrustedLocalAuthorization(input, authorization, limits, dependencies),
            clock: dependencies.now,
            timeoutMs: authorization.policy.timeoutMs,
          };
        default: {
          const unknown: never = authorization;
          return {
            problem: mismatch(`Unknown security mode in ${JSON.stringify(unknown)}.`),
            clock: dependencies.now,
            timeoutMs: undefined,
          };
        }
      }
    };
    const { problem, clock, timeoutMs } = checkMode();
    if (problem !== null) {
      return reject(problem.code, problem.message);
    }
    // Consumed synchronously, before the first `await`, so concurrent launches of the same
    // authorization cannot both pass. A launch refused by a later check still uses it up.
    consumedAuthorizationIds.add(authorization.authorizationId);
    const securityMode = authorization.mode;
    const request: AgentExecutionRequest = {
      ...input.request,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
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
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        stopGraceMs: limits.stopGraceMs,
        maxStdoutBytes: limits.maxStdoutBytes,
        maxLineBytes: limits.maxLineBytes,
      },
      {
        onStarted: (pid, processGroupId) =>
          deliver({
            type: 'started',
            pid,
            processGroupId,
            securityMode,
            processContainment: 'process_group_only',
          }),
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
        timeoutMs,
        explicitModel: request.modelId !== null,
      });
      const result: AgentRunResult = Object.freeze({
        ...outcome,
        runId: request.runId,
        runtime: adapter.runtime,
        securityMode,
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

/**
 * The only way to launch an agent CLI. It requires an explicit `securityMode` and an
 * authorization for exactly that mode, validated against the full SEC-02a contract, then checked
 * per mode (exhaustive switch; no fallback between modes):
 *
 * - **Strict Isolated:** the authorization matches the trusted adapter profile, the detected
 *   installation and the request, and every required control is enforced by the authorization
 *   **and** the shipped profile. With the shipped (unverified) profiles every strict launch is
 *   refused. That is intended.
 * - **Trusted Local:** the authorization was issued by the Trusted Local gate in this process for
 *   this run and prompt and is redeemed exactly once; the shipped adapter, a supported CLI version,
 *   honest control assessments, a non-root effective user, the authorized timeout, non-widened
 *   output limits and process-group stop all apply. It never claims that a control is enforced.
 *
 * In both modes the authorization must be fresh and unused, the prepared arguments must pass the
 * deny lists and equal the authorized ones, the environment digest and canonical working
 * directory must match, and the executable must be unchanged since discovery. Then it spawns
 * exactly the prepared argument array in the authorized working directory with an allow-listed
 * environment. Events and results report `securityMode` and `processContainment:
 * 'process_group_only'`.
 */
export const startAgentExecution = createAgentExecutionLauncher({
  now: () => new Date(),
  effectiveUid: () => process.geteuid?.(),
  processGroupsSupported: supervisorUsesProcessGroups,
});
