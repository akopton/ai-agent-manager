import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import {
  assessControl,
  conversationTurnAuthorizationSchema,
  securityControls,
  type AuthorizedInvocation,
  type ConversationTurnAuthorization,
  type ExecutableIdentity,
} from '@ai-agent-manager/core';
import type { AgentEvent, AgentHandle, CliInstallation } from './contract.js';
import {
  conversationInvocationShape,
  getConversationSecurityProfile,
} from './conversation-profiles.js';
import { redeemConversationAuthorization } from './conversation-issuance.js';
import { fingerprintExecutable } from './discovery.js';
import { digestEnvironment } from './environment.js';
import { defaultExecutionLimits, type ExecutionLimits } from './execution-launch.js';
import { maxPromptBytes } from './invocation.js';
import { cliModelIdSchema } from './model-selection.js';
import { supervisorUsesProcessGroups } from './process-supervisor.js';
import { getAgentAdapter } from './registry.js';
import { findUnsafeLaunchArguments } from './security-profiles.js';
import { startSupervisedRun } from './supervised-run.js';
import { isSupportedCliVersion } from './version-support.js';

// Conversation Mode launch boundary (C2). A conversation turn runs the CLI with the conversation
// profile in a scratch directory, never in a worktree. It requires a `ConversationTurnAuthorization`
// issued by the conversation gate in this process; `startAgentExecution` rejects that type, and
// this boundary rejects execution authorizations.

/** One conversation turn as the worker requests it. Untrusted until validated. */
export type ConversationTurnRequest = {
  /** The turn's UUID; attached to every event as `runId`. */
  turnId: string;
  /** The composed prompt; written to stdin, never logged or emitted. */
  prompt: string;
  /** `null` = Default (no `--model`). */
  modelId: string | null;
  /** Canonical, absolute scratch directory; the process `cwd`. */
  scratchDirectory: string;
};

const requestSchema = z
  .object({
    turnId: z.uuid(),
    prompt: z
      .string()
      .refine((value) => value.trim().length > 0, 'must not be empty')
      .refine((value) => Buffer.byteLength(value, 'utf8') <= maxPromptBytes, 'is too large')
      .refine((value) => !value.includes('\0'), 'must not contain NUL characters'),
    modelId: cliModelIdSchema,
    scratchDirectory: z
      .string()
      .refine(
        (value) => !value.includes('\0') && isAbsolute(value) && normalize(value) === value,
        'must be an absolute, normalized path',
      ),
  })
  .strict();

export type ConversationPreparationErrorCode =
  | 'invalid_request'
  | 'model_invalid'
  | 'model_selection_unsupported'
  | 'conversation_profile_unsupported'
  | 'unsafe_arguments'
  | 'installation_mismatch';

/** A prepared conversation invocation. Not authorized and not executable by itself. */
export type ConversationInvocationPlan = {
  runtime: CliInstallation['runtime'];
  executablePath: string;
  args: readonly string[];
  profileArguments: readonly string[];
  launchProfileId: string;
  cwd: string;
  modelId: string | null;
  environmentNames: readonly string[];
  invocation: AuthorizedInvocation;
};

export type ConversationPreparation =
  | { ok: true; plan: ConversationInvocationPlan }
  | { ok: false; code: ConversationPreparationErrorCode; message: string };

/** Problems with a conversation argument list: the security deny list plus conversation rules. */
export const findRejectedConversationArguments = (
  runtime: CliInstallation['runtime'],
  args: readonly string[],
): string[] => {
  const problems = findUnsafeLaunchArguments(runtime, args);
  const { forbiddenOptions } = conversationInvocationShape[runtime];
  for (const argument of args) {
    const name = argument.startsWith('--') ? argument.split('=', 1)[0] : argument;
    if (name !== undefined && forbiddenOptions.includes(name)) {
      problems.push(`${name}: not allowed in a conversation turn`);
    }
  }
  return problems;
};

/**
 * Prepares the exact conversation invocation: the conversation profile's arguments, the output
 * options, an optional `--model`, and the runtime's trailing arguments. The environment is the
 * adapter's allow list.
 */
export const prepareConversationTurn = (
  installation: CliInstallation,
  request: ConversationTurnRequest,
  options: { sourceEnvironment?: NodeJS.ProcessEnv } = {},
): ConversationPreparation => {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') ?? '';
    return {
      ok: false,
      code: field === 'modelId' ? 'model_invalid' : 'invalid_request',
      message: `${field || 'request'}: ${issue?.message ?? 'invalid'}`,
    };
  }
  const valid = parsed.data;
  const runtime = installation.runtime;
  const adapter = getAgentAdapter(runtime);
  const profile = getConversationSecurityProfile(runtime);
  const shape = conversationInvocationShape[runtime];
  if (profile.runtime !== runtime || adapter.runtime !== runtime) {
    return {
      ok: false,
      code: 'installation_mismatch',
      message: `No conversation profile for ${runtime}.`,
    };
  }
  const missing = shape.requiredOptions.filter(
    (option) => !installation.detectedOptions.includes(option),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'conversation_profile_unsupported',
      message: `${runtime} ${installation.version} does not list ${missing.join(', ')}, which the conversation profile needs. Update the CLI.`,
    };
  }
  if (valid.modelId !== null && !installation.detectedOptions.includes('--model')) {
    return {
      ok: false,
      code: 'model_selection_unsupported',
      message: `${runtime} ${installation.version} does not list --model; only the Default model can be used.`,
    };
  }
  const args = [
    ...profile.launchArguments,
    ...shape.outputArguments,
    ...(valid.modelId === null ? [] : ['--model', valid.modelId]),
    ...shape.trailingArguments,
  ];
  const problems = findRejectedConversationArguments(runtime, args);
  if (problems.length > 0) {
    return { ok: false, code: 'unsafe_arguments', message: problems.join('; ') };
  }
  const environment = adapter.buildEnvironment(options.sourceEnvironment ?? process.env);
  return {
    ok: true,
    plan: Object.freeze({
      runtime,
      executablePath: installation.executablePath,
      args: Object.freeze(args),
      profileArguments: Object.freeze([...profile.launchArguments]),
      launchProfileId: profile.id,
      cwd: valid.scratchDirectory,
      modelId: valid.modelId,
      environmentNames: Object.freeze(Object.keys(environment).sort()),
      invocation: Object.freeze({
        executable: Object.freeze({
          path: installation.executablePath,
          ...installation.fingerprint,
        }),
        arguments: Object.freeze([...args]),
        environmentDigest: digestEnvironment(environment),
      }),
    }),
  };
};

export type StartConversationTurnInput = {
  installation: CliInstallation;
  request: ConversationTurnRequest;
  /** From `authorizeConversationTurn`, immediately before this call, in this process. */
  authorization: ConversationTurnAuthorization;
  /** Receives every event in order. Must not throw: a throwing handler terminates the turn. */
  emit: (event: AgentEvent) => void;
  /** Limits may only be tightened. */
  limits?: Partial<ExecutionLimits>;
  sourceEnvironment?: NodeJS.ProcessEnv;
};

export type ConversationLaunchRejectionCode =
  | 'authorization_mismatch'
  | 'elevated_privileges'
  | 'safeguard_unavailable'
  | 'executable_changed'
  | ConversationPreparationErrorCode;

export type StartConversationTurnResult =
  | { started: true; handle: AgentHandle }
  | { started: false; code: ConversationLaunchRejectionCode; message: string };

export type ConversationLaunchDependencies = {
  now: () => Date;
  effectiveUid: () => number | undefined;
  processGroupsSupported: boolean;
};

const consumedAuthorizationIds = new Set<string>();
const maxClockSkewMs = 5_000;

const sameArguments = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Creates the conversation launch boundary with explicit process facts.
 *
 * @internal Tests only; the package exports `startConversationTurn`.
 */
export const createConversationLauncher =
  (dependencies: ConversationLaunchDependencies) =>
  async (input: StartConversationTurnInput): Promise<StartConversationTurnResult> => {
    const reject = (
      code: ConversationLaunchRejectionCode,
      message: string,
    ): StartConversationTurnResult => ({ started: false, code, message });
    const mismatch = (message: string) => reject('authorization_mismatch', message);

    // A task execution authorization (or anything else) fails here: different contract.
    const parsed = conversationTurnAuthorizationSchema.safeParse(input.authorization);
    if (!parsed.success) {
      return mismatch('The conversation authorization is malformed or of another kind.');
    }
    const authorization = parsed.data;
    const { installation, request } = input;
    const redemption = redeemConversationAuthorization(authorization, {
      turnId: request.turnId,
      prompt: request.prompt,
    });
    if (!redemption.ok) {
      return mismatch(redemption.message);
    }
    if (consumedAuthorizationIds.has(authorization.authorizationId)) {
      return mismatch('This authorization was already used.');
    }
    consumedAuthorizationIds.add(authorization.authorizationId);

    const limits: ExecutionLimits = { ...defaultExecutionLimits, ...input.limits };
    for (const name of Object.keys(defaultExecutionLimits) as (keyof ExecutionLimits)[]) {
      const value = limits[name];
      if (!Number.isFinite(value) || value <= 0 || value > defaultExecutionLimits[name]) {
        return reject(
          'safeguard_unavailable',
          `Limit ${name} must be positive and at most ${defaultExecutionLimits[name]}.`,
        );
      }
    }
    if (!dependencies.processGroupsSupported) {
      return reject('safeguard_unavailable', 'Process-group stop is not available here.');
    }
    const uid = dependencies.effectiveUid();
    if (uid === undefined || uid === 0) {
      return reject(
        'elevated_privileges',
        uid === 0 ? 'CLIs must not run as root.' : 'The effective user is unknown.',
      );
    }
    const runtime = authorization.runtime;
    if (installation.runtime !== runtime || request.turnId !== authorization.turnId) {
      return mismatch('The installation or turn differs from the authorization.');
    }
    if (
      authorization.runtimeVersion !== installation.version ||
      !isSupportedCliVersion(runtime, installation.version)
    ) {
      return mismatch(
        `The authorization is for ${runtime} ${authorization.runtimeVersion}, but ${installation.version} is installed or unsupported.`,
      );
    }
    const profile = getConversationSecurityProfile(runtime);
    if (
      authorization.launchProfileId !== profile.id ||
      !sameArguments(authorization.launchArguments, profile.launchArguments)
    ) {
      return mismatch(`The authorization does not match conversation profile "${profile.id}".`);
    }
    const assessments = securityControls.map((control) =>
      assessControl(profile, control, installation.version),
    );
    if (
      assessments.some((expected, index) => {
        const actual = authorization.controlAssessments[index];
        return (
          actual === undefined ||
          actual.control !== expected.control ||
          actual.status !== expected.status ||
          actual.mechanism !== expected.mechanism ||
          actual.notes !== expected.notes
        );
      })
    ) {
      return mismatch('The control assessments differ from the shipped conversation profile.');
    }
    const now = dependencies.now();
    const checkedAt = Date.parse(authorization.checkedAt);
    const age = now.getTime() - checkedAt;
    if (
      !Number.isFinite(checkedAt) ||
      age > limits.maxAuthorizationAgeMs ||
      age < -maxClockSkewMs
    ) {
      return mismatch('The authorization is stale; authorize immediately before launch.');
    }
    if (request.scratchDirectory !== authorization.scratchDirectory) {
      return mismatch('The scratch directory differs from the authorized one.');
    }

    const sourceEnvironment = input.sourceEnvironment ?? process.env;
    const preparation = prepareConversationTurn(installation, request, { sourceEnvironment });
    if (!preparation.ok) {
      return reject(preparation.code, preparation.message);
    }
    const { plan } = preparation;
    const adapter = getAgentAdapter(runtime);
    const environment = adapter.buildEnvironment(sourceEnvironment);
    const expected = installation.fingerprint;
    const sameExecutable = (identity: ExecutableIdentity): boolean =>
      identity.path === installation.executablePath &&
      identity.dev === expected.dev &&
      identity.ino === expected.ino &&
      identity.size === expected.size &&
      identity.mtimeMs === expected.mtimeMs;
    if (!sameExecutable(authorization.invocation.executable)) {
      return mismatch('The authorized executable is not the detected installation.');
    }
    if (!sameArguments(authorization.invocation.arguments, plan.args)) {
      return mismatch('The prepared arguments differ from the authorized arguments.');
    }
    if (authorization.invocation.environmentDigest !== digestEnvironment(environment)) {
      return mismatch('The child environment differs from the authorized environment.');
    }
    const cwdStats = await stat(plan.cwd).catch(() => null);
    const canonicalCwd = await realpath(plan.cwd).catch(() => null);
    if (cwdStats === null || !cwdStats.isDirectory() || canonicalCwd !== plan.cwd) {
      return mismatch('The scratch directory is missing or not canonical.');
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
      return reject('executable_changed', 'The CLI executable changed after discovery.');
    }

    const handle = startSupervisedRun({
      adapter,
      runId: request.turnId,
      executablePath: plan.executablePath,
      args: plan.args,
      cwd: plan.cwd,
      environment,
      stdin: request.prompt,
      explicitModel: plan.modelId !== null,
      timeoutMs: authorization.policy.timeoutMs,
      limits,
      securityMode: 'trusted_local',
      clock: dependencies.now,
      emit: input.emit,
    });
    return { started: true, handle };
  };

/**
 * The only way to start a conversation turn. Requires a fresh, unused conversation authorization
 * issued in this process for exactly this turn and prompt; re-checks the conversation profile,
 * honest control assessments, CLI version, non-root user, process-group support, non-widened
 * limits, the scratch directory, every argument, the environment digest and the executable
 * identity; then supervises the CLI with the authorized timeout. Never claims isolation.
 */
export const startConversationTurn = createConversationLauncher({
  now: () => new Date(),
  effectiveUid: () => process.geteuid?.(),
  processGroupsSupported: supervisorUsesProcessGroups,
});
