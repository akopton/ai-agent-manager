import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  findUnsafeLaunchArguments,
  getAgentAdapter,
  getRuntimeSecurityProfile,
  isSupportedCliVersion,
  type CliInstallation,
} from '@ai-agent-manager/agents';
import {
  agentRuntimeSchema,
  assessControl,
  authorizedInvocationSchema,
  disclosureVersionSchema,
  mandatoryTrustedLocalSafeguards,
  securityControlSchema,
  securityControls,
  trustedLocalExecutionAuthorizationSchema,
  trustedLocalPolicySchema,
  trustedRepositorySchema,
  type AgentRuntime,
  type AuthorizedInvocation,
  type ControlAssessment,
  type SecurityControl,
  type SecurityDenial,
  type TrustedLocalAuthorizationDecision,
  type TrustedLocalPolicy,
  type TrustedLocalSafeguard,
  type VerifiedWorkspace,
} from '@ai-agent-manager/core';
import type { GitCommandOptions } from '@ai-agent-manager/git';
import {
  deepFreeze,
  describeIssues,
  verifyExecutable,
  verifyWorkspace,
  workspaceRequestSchema,
  type ExecutionWorkspaceRequest,
} from './execution-gate.js';

/**
 * Trusted application state for Trusted Local Mode. It is **not** part of the request: the worker
 * loads it from persisted operator settings (M2) and project trust (M3). A task, REST body or
 * browser input can never supply or widen it. Until persistence exists, callers inject it.
 */
export const trustedLocalStateSchema = z
  .object({
    /** The operator explicitly enabled Trusted Local Mode. Default for new installations: false. */
    enabled: z.boolean(),
    /** The disclosure version the application currently shows; acceptances must match it. */
    currentDisclosureVersion: disclosureVersionSchema,
    /** The operator's recorded acceptance, or `null` if none exists. */
    acceptance: z
      .object({
        disclosureVersion: disclosureVersionSchema,
        acceptedAt: z.iso.datetime(),
        /** The risks the operator accepted with this disclosure. */
        acceptedRisks: z.array(securityControlSchema).max(securityControls.length).readonly(),
      })
      .strict()
      .nullable(),
    /** Repositories the operator marked as trusted, by canonical root and common Git directory. */
    trustedRepositories: z.array(trustedRepositorySchema).max(1000).readonly(),
  })
  .strict();

export type TrustedLocalState = z.infer<typeof trustedLocalStateSchema>;

export type AuthorizeTrustedLocalExecutionRequest = {
  /** Untrusted until validated. Must be a Trusted Local policy; nothing else is converted. */
  policy: unknown;
  runtime: AgentRuntime;
  /** From `adapter.detect()` (trusted code): executable identity, version, detected options. */
  installation: CliInstallation;
  /** `null` = Default model. Part of the intended launch, so the invocation can be re-prepared. */
  modelId: string | null;
  /** As prepared by the adapter (`UnauthorizedInvocationPlan.invocation`). */
  invocation: AuthorizedInvocation;
  workspace: ExecutionWorkspaceRequest;
  gitOptions?: GitCommandOptions;
};

/** Dependencies with security relevance. Only tests replace them; the public gate cannot. */
export type TrustedLocalGateDependencies = {
  now: () => Date;
  /** Effective user ID of the process that will launch the agent; `undefined` if unknown. */
  effectiveUid: () => number | undefined;
  /** Source of the allow-listed child environment, as the launch boundary will use it. */
  sourceEnvironment: () => NodeJS.ProcessEnv;
};

const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0') && isAbsolute(value), 'must be an absolute path');

const installationSchema = z
  .object({
    runtime: agentRuntimeSchema,
    executablePath: absolutePathSchema,
    fingerprint: z
      .object({
        dev: z.number().finite().nonnegative(),
        ino: z.number().finite().nonnegative(),
        size: z.number().finite().nonnegative(),
        mtimeMs: z.number().finite().nonnegative(),
      })
      .strict(),
    version: z.string().trim().min(1).max(100),
    detectedOptions: z.array(z.string().max(200)).max(200),
    detectedAt: z.string(),
  })
  .strict();

const requestSchema = z
  .object({
    policy: z.unknown(),
    runtime: agentRuntimeSchema,
    installation: installationSchema,
    modelId: z.string().max(200).nullable(),
    invocation: authorizedInvocationSchema,
    workspace: workspaceRequestSchema,
    gitOptions: z.unknown().optional(),
  })
  .strict();

/**
 * Prompt used only to re-prepare the invocation. Adapters send the prompt via stdin, so it is not
 * part of the arguments or environment; if that ever changed, the comparison below would deny.
 */
const authorizationProbePrompt = 'Trusted Local authorization check (not sent to any CLI).';

/**
 * Safeguards recorded in every Trusted Local authorization. Each one is verified here or bound as
 * an obligation of the launch boundary that consumes the authorization (SEC-02c):
 *
 * - `invocation_binding`, `worktree_verification`, `allow_listed_environment`, `non_root`: checked
 *   here (re-prepared invocation, Git worktree verification, environment digest of the
 *   allow-listed environment, effective UID).
 * - `mandatory_timeout`, `output_limits`, `process_group_stop`: obligations the launch boundary
 *   must honor (the timeout is in the policy). Until SEC-02c exists, no launch boundary accepts a
 *   Trusted Local authorization at all.
 *
 * `post_run_git_integrity_check` is deliberately absent until SEC-02d implements it.
 */
const appliedSafeguards: readonly TrustedLocalSafeguard[] = mandatoryTrustedLocalSafeguards;

const sameArguments = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameExecutable = (
  left: AuthorizedInvocation['executable'],
  right: AuthorizedInvocation['executable'],
): boolean =>
  left.path === right.path &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs;

const touches = (error: z.ZodError, field: string): boolean =>
  error.issues.some((issue) => issue.path[0] === field);

/** Validates the policy. Strict policies are rejected, never converted. */
const checkPolicy = (value: unknown, denials: SecurityDenial[]): TrustedLocalPolicy | null => {
  if (value === undefined || value === null) {
    denials.push({
      code: 'policy_missing',
      message: 'No security policy was supplied; executions are denied without one.',
    });
    return null;
  }
  const mode = typeof value === 'object' && 'mode' in value ? value.mode : undefined;
  if (mode !== 'trusted_local') {
    denials.push({
      code: 'mode_mismatch',
      message: `The Trusted Local gate accepts only policies with mode "trusted_local", not ${JSON.stringify(mode ?? null)}. Policies are never converted between modes.`,
    });
    return null;
  }
  const parsed = trustedLocalPolicySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  denials.push({ code: 'policy_invalid', message: describeIssues(parsed.error) });
  if (touches(parsed.error, 'timeoutMs')) {
    denials.push({
      code: 'timeout_required',
      message: `A positive, finite timeout of at most 24 hours is mandatory in Trusted Local Mode.`,
    });
  }
  return null;
};

/** Operator enablement, acceptance and accepted risks; all from trusted state. */
const checkAcceptance = (
  policy: TrustedLocalPolicy | null,
  state: TrustedLocalState,
  assessments: readonly ControlAssessment[],
  now: Date,
  denials: SecurityDenial[],
): void => {
  if (!state.enabled) {
    denials.push({
      code: 'trusted_local_disabled',
      message: 'Trusted Local Mode is not enabled. The operator must enable it in Settings.',
    });
  }
  const recorded = state.acceptance;
  if (recorded === null) {
    denials.push({
      code: 'acceptance_missing',
      message: 'The operator has not accepted the Trusted Local disclosure.',
    });
    return;
  }
  if (recorded.disclosureVersion !== state.currentDisclosureVersion) {
    denials.push({
      code: 'acceptance_stale',
      message: `The acceptance is for disclosure ${recorded.disclosureVersion}, but the current disclosure is ${state.currentDisclosureVersion}. The operator must accept it again.`,
    });
  }
  const acceptedAt = Date.parse(recorded.acceptedAt);
  if (!Number.isFinite(acceptedAt) || acceptedAt > now.getTime()) {
    denials.push({
      code: 'acceptance_invalid',
      message: `The recorded acceptance time ${recorded.acceptedAt} is in the future or invalid.`,
    });
  }
  if (policy === null) {
    return;
  }
  if (
    policy.acceptance.disclosureVersion !== recorded.disclosureVersion ||
    policy.acceptance.acceptedAt !== recorded.acceptedAt
  ) {
    denials.push({
      code: 'acceptance_invalid',
      message: "The policy's acceptance does not match the operator's recorded acceptance.",
    });
  }
  const unrecorded = policy.acceptedRisks.filter(
    (control) => !recorded.acceptedRisks.includes(control),
  );
  if (unrecorded.length > 0) {
    denials.push({
      code: 'acceptance_invalid',
      message: `The policy lists risks the operator did not accept: ${unrecorded.join(', ')}.`,
    });
  }
  for (const assessment of assessments) {
    if (assessment.status === 'enforced') {
      continue;
    }
    if (!policy.acceptedRisks.includes(assessment.control)) {
      denials.push({
        code: 'risk_not_accepted',
        control: assessment.control,
        assessment,
        message: `"${assessment.control}" is not enforced (${assessment.status}); Trusted Local Mode requires the operator to accept this risk explicitly.`,
      });
    }
  }
};

/** Repository trust comes only from trusted state and matches root and common Git directory. */
const checkRepositoryTrust = (
  workspace: ExecutionWorkspaceRequest,
  state: TrustedLocalState,
  now: Date,
  denials: SecurityDenial[],
): TrustedLocalState['trustedRepositories'][number] | null => {
  const candidates = state.trustedRepositories.filter(
    (entry) => entry.root === workspace.repositoryPath,
  );
  const deny = (message: string) => {
    denials.push({ code: 'repository_not_trusted', message });
    return null;
  };
  if (candidates.length === 0) {
    return deny(`The repository ${workspace.repositoryPath} is not trusted for local execution.`);
  }
  if (candidates.length > 1) {
    return deny(`The repository ${workspace.repositoryPath} has conflicting trust records.`);
  }
  const [trusted] = candidates;
  if (trusted === undefined) {
    return null;
  }
  if (trusted.commonDir !== workspace.commonDir) {
    return deny(
      `The repository at ${workspace.repositoryPath} uses Git directory ${workspace.commonDir}, but trust was granted for ${trusted.commonDir}. Trust the repository again if it was replaced.`,
    );
  }
  const trustedAt = Date.parse(trusted.trustedAt);
  if (!Number.isFinite(trustedAt) || trustedAt > now.getTime()) {
    return deny(`The trust record time ${trusted.trustedAt} is in the future or invalid.`);
  }
  return trusted;
};

/**
 * Executable, CLI version and complete invocation. The invocation is re-prepared with the
 * trusted adapter from the detected installation and the allow-listed environment, so the
 * arguments, environment digest and working directory must be exactly what production would use.
 */
const checkInvocation = async (
  input: z.output<typeof requestSchema>,
  policy: TrustedLocalPolicy | null,
  sourceEnvironment: NodeJS.ProcessEnv,
  denials: SecurityDenial[],
): Promise<void> => {
  const { runtime, installation, invocation, workspace } = input;
  const adapter = getAgentAdapter(runtime);
  const profile = adapter.securityProfile;
  if (installation.runtime !== runtime) {
    denials.push({
      code: 'invalid_request',
      message: `The installation is for ${installation.runtime}, not ${runtime}.`,
    });
    return;
  }
  if (!isSupportedCliVersion(runtime, installation.version)) {
    denials.push({
      code: 'cli_version_unsupported',
      message: `${runtime} ${installation.version} is not a supported CLI version.`,
    });
  }
  const detected = { path: installation.executablePath, ...installation.fingerprint };
  if (!sameExecutable(detected, invocation.executable)) {
    denials.push({
      code: 'executable_not_verified',
      message: 'The invocation executable is not the detected installation.',
    });
  }
  denials.push(...(await verifyExecutable(invocation.executable)));
  for (const problem of findUnsafeLaunchArguments(runtime, invocation.arguments)) {
    denials.push({ code: 'unsafe_launch_arguments', message: problem });
  }
  const workingDirectory = workspace.workingDirectory ?? workspace.worktreePath;
  const preparation = adapter.prepareExecution(
    installation,
    {
      runId: 'trusted-local-authorization',
      prompt: authorizationProbePrompt,
      modelId: input.modelId,
      workingDirectory,
      ...(policy === null ? {} : { timeoutMs: policy.timeoutMs }),
    },
    { sourceEnvironment },
  );
  if (!preparation.ok) {
    denials.push({
      code:
        preparation.code === 'unsafe_arguments' ? 'unsafe_launch_arguments' : 'invocation_invalid',
      message: `The adapter refused to prepare this launch: ${preparation.message}`,
    });
    return;
  }
  const { plan } = preparation;
  if (!sameArguments(plan.profileArguments, profile.launchArguments)) {
    denials.push({
      code: 'invocation_invalid',
      message: `The prepared launch does not use profile "${profile.id}".`,
    });
  }
  if (!sameArguments(invocation.arguments, plan.args)) {
    denials.push({
      code: 'invocation_invalid',
      message: 'The invocation arguments differ from the launch the adapter prepares.',
    });
  }
  if (invocation.environmentDigest !== plan.invocation.environmentDigest) {
    denials.push({
      code: 'invocation_invalid',
      message: 'The environment digest differs from the allow-listed environment for this launch.',
    });
  }
  if (!sameExecutable(plan.invocation.executable, invocation.executable)) {
    denials.push({
      code: 'executable_not_verified',
      message: 'The prepared executable differs from the invocation executable.',
    });
  }
  if (plan.cwd !== workingDirectory) {
    denials.push({
      code: 'path_outside_workspace',
      message: 'The prepared working directory differs from the task working directory.',
    });
  }
};

/**
 * Creates the Trusted Local gate with explicit dependencies. Exported for tests only through
 * this module; the package entry point exports `authorizeTrustedLocalExecution`, which uses the
 * real clock, effective UID and process environment.
 *
 * @internal
 */
export const createTrustedLocalGate =
  (dependencies: TrustedLocalGateDependencies) =>
  async (
    request: AuthorizeTrustedLocalExecutionRequest,
    trustedState: TrustedLocalState,
  ): Promise<TrustedLocalAuthorizationDecision> => {
    const deny = (denials: SecurityDenial[]): TrustedLocalAuthorizationDecision =>
      deepFreeze({ authorized: false, denials });
    const state = trustedLocalStateSchema.safeParse(trustedState);
    if (!state.success) {
      return deny([
        {
          code: 'invalid_request',
          message: `The trusted application state is invalid: ${describeIssues(state.error)}`,
        },
      ]);
    }
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) {
      return deny([{ code: 'invalid_request', message: describeIssues(parsed.error) }]);
    }
    const input = parsed.data;
    const now = dependencies.now();
    const denials: SecurityDenial[] = [];

    const policy = checkPolicy(input.policy, denials);
    // Assessments come from the shipped, code-defined profile, never from the request.
    const profile = getRuntimeSecurityProfile(input.runtime);
    const assessments: ControlAssessment[] = securityControls.map((control) =>
      assessControl(profile, control, input.installation.version),
    );
    checkAcceptance(policy, state.data, assessments, now, denials);

    const uid = dependencies.effectiveUid();
    if (uid === undefined || uid === 0) {
      denials.push({
        code: 'elevated_privileges',
        message:
          uid === 0
            ? 'Agents must not run as root.'
            : 'The effective user could not be determined, so a non-elevated launch cannot be confirmed.',
      });
    }

    await checkInvocation(input, policy, dependencies.sourceEnvironment(), denials);
    const trusted = checkRepositoryTrust(input.workspace, state.data, now, denials);
    // Repository trust never replaces worktree verification.
    const workspaceResult = await verifyWorkspace(input.workspace, request.gitOptions ?? {});
    denials.push(...workspaceResult.denials);

    const verified: VerifiedWorkspace | null = workspaceResult.verified;
    if (denials.length > 0 || policy === null || trusted === null || verified === null) {
      return deny(
        denials.length > 0
          ? denials
          : [{ code: 'inspection_failed', message: 'Authorization could not be completed.' }],
      );
    }

    const acceptedRisks: SecurityControl[] = assessments
      .filter((assessment) => assessment.status !== 'enforced')
      .map((assessment) => assessment.control);
    const candidate = {
      mode: 'trusted_local',
      authorizationId: randomUUID(),
      checkedAt: now.toISOString(),
      runtime: input.runtime,
      runtimeVersion: input.installation.version,
      launchProfileId: profile.id,
      launchArguments: [...profile.launchArguments],
      invocation: {
        executable: { ...input.invocation.executable },
        arguments: [...input.invocation.arguments],
        environmentDigest: input.invocation.environmentDigest,
      },
      workspace: verified,
      policy,
      trustedRepository: { ...trusted },
      controlAssessments: assessments,
      acceptedRisks,
      safeguards: [...appliedSafeguards],
      processContainment: 'process_group_only',
    };
    // The result must satisfy the SEC-02a contract; anything else is an internal error, denied.
    const authorization = trustedLocalExecutionAuthorizationSchema.safeParse(candidate);
    if (!authorization.success) {
      return deny([
        {
          code: 'inspection_failed',
          message: `The authorization failed its own contract: ${describeIssues(authorization.error)}`,
        },
      ]);
    }
    return deepFreeze({ authorized: true, authorization: authorization.data });
  };

/**
 * Decides, before launch, whether an agent execution may run in **Trusted Local Mode**. A
 * separate entry point from the strict `authorizeAgentExecution`; neither falls back to the other.
 *
 * Authorizes only when the operator enabled Trusted Local Mode, accepted the current disclosure
 * and every unenforced control as a risk, and trusted this exact repository (canonical root and
 * common Git directory); the worktree passes every strict-gate workspace check; the executable is
 * the detected, unchanged, supported CLI; the invocation, environment digest and working directory
 * are exactly what the trusted adapter prepares; a timeout is set; and the agent will not run with
 * elevated privileges.
 *
 * A Trusted Local authorization is **not** an enforcement claim: `controlAssessments` are the
 * honest statuses from the shipped profiles, and every unenforced control appears in
 * `acceptedRisks`. Read-only: inspects Git and the filesystem, never modifies them, and starts no
 * process. Trusted state comes from the operator's settings, never from the request.
 */
export const authorizeTrustedLocalExecution = createTrustedLocalGate({
  now: () => new Date(),
  effectiveUid: () => process.geteuid?.(),
  sourceEnvironment: () => process.env,
});
