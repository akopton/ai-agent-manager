import { z } from 'zod';
import { agentRuntimeSchema } from './agent-runtime.js';
import {
  controlAssessmentSchema,
  enforcementMechanismSchema,
  requiredSecurityControls,
  securityControlSchema,
  securityControls,
  strictIsolatedPolicySchema,
  trustedLocalPolicySchema,
  type ControlAssessment,
  type SecurityControl,
} from './security-policy.js';

export const securityDenialCodes = [
  /** The request is malformed (missing fields, relative paths, invalid identifiers). */
  'invalid_request',
  /** No security policy was supplied. */
  'policy_missing',
  /** The policy is invalid or requests something unsupported. */
  'policy_invalid',
  /** The launch profile is invalid or belongs to another runtime. */
  'profile_invalid',
  /** The launch profile contains arguments that bypass or widen CLI restrictions. */
  'unsafe_launch_arguments',
  /** A required control is not enforced; risk acknowledgements do not change this. */
  'control_not_enforced',
  /** The repository is not a valid main working tree, or Git refused it (safe.directory). */
  'repository_invalid',
  /** The repository is not the one recorded for the task. */
  'repository_mismatch',
  /** Git does not confirm the worktree as a ready AI Agent Manager task worktree. */
  'worktree_not_verified',
  /** The worktree is not on the expected task branch. */
  'branch_mismatch',
  /** The AI Agent Manager lock marker or filesystem ownership does not match. */
  'ownership_not_verified',
  /** HEAD or the task branch moved away from the recorded base commit. */
  'unexpected_head',
  /** A supplied path is not canonical (symlinked components, `..`, trailing segments). */
  'path_not_canonical',
  /** A path is outside the managed layout or the task worktree. */
  'path_outside_workspace',
  /** The worktree overlaps the main checkout, the Git directory, or another worktree. */
  'unsafe_path_relationship',
  /** Git or the filesystem failed unexpectedly; nothing could be verified. */
  'inspection_failed',
  /** The executable is not a canonical executable file, or differs from the identity in the request. */
  'executable_not_verified',
  /** The invocation does not start with the profile's launch arguments, or is malformed. */
  'invocation_invalid',
  // Trusted Local Mode only (SEC-02). Defined here; no gate emits them yet (SEC-02b).
  /** The request's mode does not match the gate or authorization it was given to. */
  'mode_mismatch',
  /** Trusted Local Mode is not enabled by the operator. */
  'trusted_local_disabled',
  /** No operator acceptance of the Trusted Local disclosure exists. */
  'acceptance_missing',
  /** The acceptance refers to an older disclosure version. */
  'acceptance_stale',
  /** The repository is not trusted, or its identity (root, common dir) differs from the trusted one. */
  'repository_not_trusted',
  /** The process would run with elevated privileges. */
  'elevated_privileges',
  /** No valid timeout was supplied. */
  'timeout_required',
] as const;

export type SecurityDenialCode = (typeof securityDenialCodes)[number];

export type SecurityDenial = {
  code: SecurityDenialCode;
  /** Actionable explanation for the user. */
  message: string;
  control?: SecurityControl;
  /** Git inspection issues, when the worktree could not be verified. */
  issues?: readonly string[];
  /** For `control_not_enforced`: why the launch profile does not enforce the control. */
  assessment?: ControlAssessment;
  /**
   * For `control_not_enforced`: the user's risk acknowledgement from the policy, if any. Shown for
   * context only; it does not change the decision.
   */
  acknowledgement?: string;
};

const nonEmptyPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'must not contain NUL characters');

const fileNumberSchema = z.number().finite().nonnegative();

const launchArgumentSchema = z.string().max(1000);

/**
 * Workspace facts verified during preflight. Paths are canonical absolute paths; the gate checks
 * canonicalization (platform-specific). These schemas only check the shape.
 */
export const verifiedWorkspaceSchema = z
  .object({
    repositoryRoot: nonEmptyPathSchema,
    commonDir: nonEmptyPathSchema,
    worktreePath: nonEmptyPathSchema,
    /** Canonical directory to use as the process `cwd`; inside `worktreePath`. */
    workingDirectory: nonEmptyPathSchema,
    branch: z.string().min(1).max(255),
    baseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  })
  .strict();

export type VerifiedWorkspace = z.infer<typeof verifiedWorkspaceSchema>;

/**
 * Identity of an executable file: its canonical path plus the file facts observed at discovery.
 * A replaced or modified binary has a different identity.
 */
export const executableIdentitySchema = z
  .object({
    /** Canonical absolute path (no symlinked components); the process is spawned from it. */
    path: nonEmptyPathSchema,
    dev: fileNumberSchema,
    ino: fileNumberSchema,
    size: fileNumberSchema,
    mtimeMs: fileNumberSchema,
  })
  .strict();

export type ExecutableIdentity = z.infer<typeof executableIdentitySchema>;

/** The complete process launch an authorization covers. */
export const authorizedInvocationSchema = z
  .object({
    executable: executableIdentitySchema,
    /**
     * Every argument after the executable, starting with the profile's `launchArguments`. The
     * prompt is not part of it: adapters send the prompt via stdin.
     */
    arguments: z.array(launchArgumentSchema).max(200).readonly(),
    /**
     * `sha256:<hex>` over the complete child environment (sorted names and values). Binds the
     * environment without storing its values in the authorization.
     */
    environmentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export type AuthorizedInvocation = z.infer<typeof authorizedInvocationSchema>;

export const authorizedControlSchema = z
  .object({
    control: securityControlSchema,
    /** Always `enforced`: a strict authorization exists only when every required control is. */
    status: z.literal('enforced'),
    mechanism: enforcementMechanismSchema,
  })
  .strict();

export type AuthorizedControl = z.infer<typeof authorizedControlSchema>;

/**
 * Launch binding shared by both modes: exactly what may be launched, where, and when. The
 * execution layer must spawn exactly `invocation.executable.path` with exactly
 * `invocation.arguments`, an environment matching `invocation.environmentDigest`, and
 * `workspace.workingDirectory` as `cwd`. The authorization is short-lived (checked against
 * `checkedAt`) and single-use (`authorizationId`).
 */
const launchBindingShape = {
  /** Unique per authorization; the launch boundary accepts each authorization once. */
  authorizationId: z.uuid(),
  /** ISO-8601 UTC timestamp of the check; the launch boundary refuses stale authorizations. */
  checkedAt: z.iso.datetime(),
  runtime: agentRuntimeSchema,
  launchProfileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  /** The profile's fixed arguments; `invocation.arguments` starts with them. */
  launchArguments: z.array(launchArgumentSchema).max(100).readonly(),
  invocation: authorizedInvocationSchema,
  workspace: verifiedWorkspaceSchema,
} as const;

type LaunchBinding = {
  launchArguments: readonly string[];
  invocation: { arguments: readonly string[] };
};

const checkArgumentPrefix = (binding: LaunchBinding, context: z.RefinementCtx): void => {
  const { launchArguments } = binding;
  const prefix = binding.invocation.arguments.slice(0, launchArguments.length);
  if (
    prefix.length !== launchArguments.length ||
    prefix.some((value, index) => value !== launchArguments[index])
  ) {
    context.addIssue({
      code: 'custom',
      path: ['invocation', 'arguments'],
      message: 'The invocation must start with the launch profile arguments.',
    });
  }
};

/**
 * Strict Isolated authorization: preflight permission to launch one agent execution. It exists
 * only when the workspace is verified, the launch arguments are safe, **and** every required
 * control is enforced by a verified mechanism; a valid workspace and safe arguments alone never
 * produce one.
 *
 * It is a point-in-time check, not a lasting guarantee: re-authorize if anything (worktree, CLI
 * binary or version, policy, profile, model) changes.
 */
export const strictExecutionAuthorizationSchema = z
  .object({
    mode: z.literal('strict_isolated'),
    ...launchBindingShape,
    runtimeVersion: z.string().trim().min(1).max(100).nullable(),
    policy: strictIsolatedPolicySchema,
    controls: z.array(authorizedControlSchema).max(securityControls.length).readonly(),
  })
  .strict()
  .superRefine((authorization, context) => {
    checkArgumentPrefix(authorization, context);
    const listed = authorization.controls.map((entry) => entry.control);
    if (new Set(listed).size !== listed.length) {
      context.addIssue({ code: 'custom', path: ['controls'], message: 'Duplicate control.' });
    }
    for (const control of requiredSecurityControls(authorization.policy)) {
      if (!listed.includes(control)) {
        context.addIssue({
          code: 'custom',
          path: ['controls'],
          message: `Required control "${control}" is not listed as enforced.`,
        });
      }
    }
  });

export type StrictExecutionAuthorization = z.infer<typeof strictExecutionAuthorizationSchema>;

/**
 * The Strict Isolated authorization under its pre-SEC-02 name, consumed by the strict gate and
 * launch boundary. It is never a Trusted Local authorization.
 */
export type ExecutionAuthorization = StrictExecutionAuthorization;

/** Safeguards a Trusted Local launch can apply. None of them is an isolation boundary. */
export const trustedLocalSafeguards = [
  /** Executable identity, every argument, environment digest and `cwd` are bound. */
  'invocation_binding',
  /** The task worktree, branch and base commit were verified through Git. */
  'worktree_verification',
  /** The child environment is allow-listed (drops `SSH_AUTH_SOCK`, `GIT_*`, API keys). Not credential isolation. */
  'allow_listed_environment',
  /** The agent does not run with elevated privileges. */
  'non_root',
  /** The run has a finite timeout. */
  'mandatory_timeout',
  /** Stdout and line sizes are bounded. */
  'output_limits',
  /** Stop and timeout terminate the CLI's process group (not every descendant; SEC-01). */
  'process_group_stop',
  /** A read-only Git inventory is compared after the run (detects, never prevents). */
  'post_run_git_integrity_check',
] as const;

export const trustedLocalSafeguardSchema = z.enum(trustedLocalSafeguards);

export type TrustedLocalSafeguard = z.infer<typeof trustedLocalSafeguardSchema>;

/** Safeguards every Trusted Local authorization must record as applied. */
export const mandatoryTrustedLocalSafeguards: readonly TrustedLocalSafeguard[] = [
  'invocation_binding',
  'worktree_verification',
  'allow_listed_environment',
  'non_root',
  'mandatory_timeout',
  'output_limits',
  'process_group_stop',
];

/** The repository the operator marked as trusted, identified by canonical root and common dir. */
export const trustedRepositorySchema = z
  .object({
    root: nonEmptyPathSchema,
    commonDir: nonEmptyPathSchema,
    trustedAt: z.iso.datetime(),
  })
  .strict();

export type TrustedRepository = z.infer<typeof trustedRepositorySchema>;

/**
 * Trusted Local authorization (SEC-02). It binds the same launch facts as a strict authorization,
 * but it is **not** an enforcement claim:
 *
 * - There is no `controls` field. `controlAssessments` records the honest per-control status
 *   (`assessControl`) for every control, never upgraded.
 * - `acceptedRisks` lists exactly the controls that are not enforced, and each one must be
 *   accepted by the operator in `policy.acceptedRisks`.
 * - `processContainment` is always `process_group_only`.
 */
export const trustedLocalExecutionAuthorizationSchema = z
  .object({
    mode: z.literal('trusted_local'),
    ...launchBindingShape,
    /** Required: Trusted Local launches are bound to a detected CLI version. */
    runtimeVersion: z.string().trim().min(1).max(100),
    policy: trustedLocalPolicySchema,
    trustedRepository: trustedRepositorySchema,
    controlAssessments: z.array(controlAssessmentSchema).max(securityControls.length).readonly(),
    acceptedRisks: z.array(securityControlSchema).max(securityControls.length).readonly(),
    safeguards: z.array(trustedLocalSafeguardSchema).max(trustedLocalSafeguards.length).readonly(),
    processContainment: z.literal('process_group_only'),
  })
  .strict()
  .superRefine((authorization, context) => {
    checkArgumentPrefix(authorization, context);
    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });

    const assessed = authorization.controlAssessments.map((entry) => entry.control);
    if (
      assessed.length !== securityControls.length ||
      securityControls.some((control) => !assessed.includes(control))
    ) {
      issue('controlAssessments', 'Every security control must be assessed exactly once.');
    }
    const unenforced = authorization.controlAssessments
      .filter((entry) => entry.status !== 'enforced')
      .map((entry) => entry.control);
    const risks = authorization.acceptedRisks;
    if (
      new Set(risks).size !== risks.length ||
      risks.length !== unenforced.length ||
      unenforced.some((control) => !risks.includes(control))
    ) {
      issue('acceptedRisks', 'Accepted risks must be exactly the controls that are not enforced.');
    }
    const accepted = authorization.policy.acceptedRisks;
    for (const control of risks) {
      if (!accepted.includes(control)) {
        issue('acceptedRisks', `Risk "${control}" was not accepted by the operator.`);
      }
    }
    const safeguards = authorization.safeguards;
    if (new Set(safeguards).size !== safeguards.length) {
      issue('safeguards', 'Duplicate safeguard.');
    }
    for (const safeguard of mandatoryTrustedLocalSafeguards) {
      if (!safeguards.includes(safeguard)) {
        issue('safeguards', `Mandatory safeguard "${safeguard}" is missing.`);
      }
    }
    if (
      authorization.workspace.repositoryRoot !== authorization.trustedRepository.root ||
      authorization.workspace.commonDir !== authorization.trustedRepository.commonDir
    ) {
      issue('trustedRepository', 'The workspace does not belong to the trusted repository.');
    }
  });

export type TrustedLocalExecutionAuthorization = z.infer<
  typeof trustedLocalExecutionAuthorizationSchema
>;

/**
 * Either authorization, discriminated by `mode`. A Trusted Local authorization never satisfies the
 * strict schema (different `mode`, no `controls`), and a strict one never satisfies the Trusted
 * Local schema.
 */
export const securityModeAuthorizationSchema = z.discriminatedUnion('mode', [
  strictExecutionAuthorizationSchema,
  trustedLocalExecutionAuthorizationSchema,
]);

export type SecurityModeAuthorization = z.infer<typeof securityModeAuthorizationSchema>;

export type ExecutionAuthorizationDecision =
  | { authorized: true; authorization: ExecutionAuthorization }
  | { authorized: false; denials: readonly SecurityDenial[] };
