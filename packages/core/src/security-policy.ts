import { z } from 'zod';
import { agentRuntimeSchema } from './agent-runtime.js';

/**
 * Execution-time restrictions an agent run may require. Each describes an outcome that must hold
 * for the agent CLI **and every process it starts**, not merely for the CLI's own file tools.
 */
export const securityControls = [
  /** The process tree can write only inside the approved task worktree. */
  'workspace_write_confinement',
  /** The process tree has no network access. */
  'network_denied',
  /** No commits, merges, rebases, resets, ref or Git config changes in any repository. */
  'git_history_mutation_denied',
  /** No pushes to any remote, including local-path remotes. */
  'git_push_denied',
  /** No access to credentials outside the worktree (SSH keys, credential helpers, tokens). */
  'credential_isolation',
  /** Repository-controlled CLI configuration (settings, hooks, MCP, rules) cannot widen permissions. */
  'untrusted_config_isolation',
  /** Nothing waits for interactive approval; actions that would need approval are denied. */
  'non_interactive_approval',
] as const;

export const securityControlSchema = z.enum(securityControls);

export type SecurityControl = z.infer<typeof securityControlSchema>;

/**
 * Controls about what the process tree can do. A CLI permission that only governs the CLI's own
 * tools cannot satisfy them while the agent can start other processes. The remaining controls
 * concern how the CLI itself is configured.
 */
export const processBoundaryControls: readonly SecurityControl[] = [
  'workspace_write_confinement',
  'network_denied',
  'git_history_mutation_denied',
  'git_push_denied',
  'credential_isolation',
];

const riskAcknowledgementSchema = z
  .object({
    control: securityControlSchema,
    /** The user's explanation of the risk; informational only. */
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * Security policy requested by AI Agent Manager for one agent execution.
 *
 * Every field defaults to the restrictive value, and unknown fields are rejected, so a policy can
 * never request a capability the gate does not understand. Values that cannot be honoured (such
 * as allowing pushes) are deliberately not representable.
 */
export const executionSecurityPolicySchema = z
  .object({
    version: z.literal(1),
    /** Agents may only write inside the verified task worktree; no additional directories. */
    workspaceAccess: z.literal('task_worktree_only').default('task_worktree_only'),
    /** `allow` removes `network_denied` from the required controls; nothing else changes. */
    network: z.enum(['deny', 'allow']).default('deny'),
    /** Runs are unattended in MVP: interactive approval is never available. */
    interactiveApproval: z.literal('deny').default('deny'),
    /** Commit, push, merge, and destructive Git operations belong to the trusted publish service. */
    gitMutations: z.literal('deny').default('deny'),
    /**
     * User acknowledgements of known residual risks (ARCHITECTURE §7.3). **Informational only:**
     * they are attached to the matching denial for display and never authorize an execution.
     * Every required control is mandatory in MVP and must be enforced.
     */
    riskAcknowledgements: z
      .array(riskAcknowledgementSchema)
      .max(securityControls.length)
      .refine(
        (risks) => new Set(risks.map((risk) => risk.control)).size === risks.length,
        'Each control may be acknowledged at most once.',
      )
      .default([]),
  })
  .strict();

export type ExecutionSecurityPolicy = z.output<typeof executionSecurityPolicySchema>;
export type ExecutionSecurityPolicyInput = z.input<typeof executionSecurityPolicySchema>;

export const defaultExecutionSecurityPolicy: ExecutionSecurityPolicy = Object.freeze(
  executionSecurityPolicySchema.parse({ version: 1 }),
);

/** Controls the policy requires to be enforced. All are mandatory; none can be waived. */
export const requiredSecurityControls = (policy: ExecutionSecurityPolicy): SecurityControl[] =>
  securityControls.filter((control) => control !== 'network_denied' || policy.network === 'deny');

/**
 * How a launch configuration attempts to provide a control.
 *
 * - `os_sandbox`: the operating system denies the operation (for example macOS Seatbelt).
 * - `cli_permission`: the agent CLI's own permission system refuses its tools.
 * - `launch_configuration`: flags or environment chosen by the adapter (such as ignoring
 *   repository settings files).
 * - `instruction_only`: prompt or system-prompt text. Never counts as enforcement.
 * - `none`: nothing restricts it.
 */
export const enforcementMechanisms = [
  'os_sandbox',
  'cli_permission',
  'launch_configuration',
  'instruction_only',
  'none',
] as const;

export const enforcementMechanismSchema = z.enum(enforcementMechanisms);

export type EnforcementMechanism = z.infer<typeof enforcementMechanismSchema>;

const nonEmptyTextSchema = z.string().trim().min(1).max(2000);

export const controlCapabilitySchema = z
  .object({
    control: securityControlSchema,
    mechanism: enforcementMechanismSchema,
    /**
     * Whether the mechanism also restricts every subprocess (shell commands, Git, package
     * managers, hooks). A CLI permission that only governs the CLI's own file tools does not.
     * Only consulted for `processBoundaryControls`.
     */
    coversSubprocesses: z.boolean(),
    /**
     * `verified` only when an adversarial test against the exact `assessedVersion` and launch
     * arguments observed the operation being denied; `evidence` must then name that test.
     */
    verification: z.enum(['verified', 'unverified']),
    evidence: nonEmptyTextSchema.optional(),
    notes: nonEmptyTextSchema,
  })
  .strict()
  .refine((capability) => capability.verification !== 'verified' || capability.evidence, {
    message: 'Verified capabilities must reference their evidence.',
  });

export type ControlCapability = z.infer<typeof controlCapabilitySchema>;

/**
 * Security facts about one fixed way of launching an agent CLI. Profiles are trusted code shipped
 * with adapters; never construct them from user input or database contents.
 */
export const runtimeSecurityProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    runtime: agentRuntimeSchema,
    /** CLI version the capabilities were assessed against; `null` when never assessed. */
    assessedVersion: z.string().trim().min(1).max(100).nullable(),
    /** Fixed CLI arguments, excluding the prompt and model, that the adapter must use verbatim. */
    launchArguments: z.array(z.string().max(1000)).max(100),
    capabilities: z.array(controlCapabilitySchema).max(securityControls.length),
  })
  .strict()
  .refine(
    (profile) =>
      new Set(profile.capabilities.map((capability) => capability.control)).size ===
      profile.capabilities.length,
    { message: 'Each control may be described at most once.' },
  );

export type RuntimeSecurityProfile = z.infer<typeof runtimeSecurityProfileSchema>;

/**
 * What the gate concluded about one control for a specific launch.
 *
 * - `enforced`: verified for the detected CLI version, by a real mechanism, for all subprocesses.
 * - `cli_tools_only`: verified, but subprocesses are not covered (process-boundary controls only).
 * - `unverified`: a mechanism exists but is unverified, or verified for a different CLI version.
 * - `instruction_only`: only the model is asked to comply.
 * - `unsupported`: not restricted, or not described by the profile.
 */
export const controlEnforcementStatuses = [
  'enforced',
  'cli_tools_only',
  'unverified',
  'instruction_only',
  'unsupported',
] as const;

export type ControlEnforcementStatus = (typeof controlEnforcementStatuses)[number];

export type ControlAssessment = {
  control: SecurityControl;
  status: ControlEnforcementStatus;
  mechanism: EnforcementMechanism;
  notes: string;
};

/** Classifies a control for a launch. Only `enforced` satisfies a policy requirement. */
export const assessControl = (
  profile: RuntimeSecurityProfile,
  control: SecurityControl,
  detectedVersion: string | null,
): ControlAssessment => {
  const capability = profile.capabilities.find((candidate) => candidate.control === control);
  if (capability === undefined) {
    return {
      control,
      status: 'unsupported',
      mechanism: 'none',
      notes: `Launch profile "${profile.id}" does not describe this control.`,
    };
  }
  const { mechanism, notes } = capability;
  if (mechanism === 'none') {
    return { control, status: 'unsupported', mechanism, notes };
  }
  if (mechanism === 'instruction_only') {
    return { control, status: 'instruction_only', mechanism, notes };
  }
  if (capability.verification !== 'verified') {
    return { control, status: 'unverified', mechanism, notes };
  }
  if (detectedVersion === null || detectedVersion !== profile.assessedVersion) {
    return {
      control,
      status: 'unverified',
      mechanism,
      notes: `Verified against CLI version ${profile.assessedVersion ?? 'unknown'}, but the detected version is ${
        detectedVersion ?? 'unknown'
      }. ${notes}`,
    };
  }
  if (processBoundaryControls.includes(control) && !capability.coversSubprocesses) {
    return { control, status: 'cli_tools_only', mechanism, notes };
  }
  return { control, status: 'enforced', mechanism, notes };
};
