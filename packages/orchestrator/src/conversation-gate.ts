import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative } from 'node:path';
import { z } from 'zod';
import {
  getAgentAdapter,
  getConversationSecurityProfile,
  isSupportedCliVersion,
  prepareConversationTurn,
  findRejectedConversationArguments,
  type CliInstallation,
} from '@ai-agent-manager/agents';
import {
  agentRuntimeSchema,
  assessControl,
  authorizedInvocationSchema,
  conversationRuntimePolicySchema,
  conversationSafeguards,
  conversationTurnAuthorizationSchema,
  disclosureVersionSchema,
  securityControls,
  type AgentRuntime,
  type AuthorizedInvocation,
  type ConversationAuthorizationDecision,
  type ConversationDenial,
  type ConversationTrustedLocalPolicy,
  type SecurityControl,
} from '@ai-agent-manager/core';
// Restricted entry point: ESLint allows it only in this module.
import { claimConversationIssuer } from '@ai-agent-manager/agents/conversation-issuer';
import { deepFreeze, describeIssues, verifyExecutable } from './execution-gate.js';

// Conversation pre-launch gate (C2, `ARCHITECTURE.md` §15.2). A separate entry point from both
// execution gates; it never issues or accepts an execution authorization.
//
// - Strict Isolated: fail-closed. Every required conversation control must be enforced by the
//   shipped conversation profile for the detected CLI version. None is verified, so every Strict
//   request is denied with `control_not_enforced`.
// - Trusted Local: requires the operator's separate AI Conversations acceptance of the current
//   disclosure (never Execution Mode acceptance or project trust), a supported CLI with the
//   conversation profile's options, the exact re-prepared invocation, a non-root user, a bounded
//   timeout, and a verified scratch directory. The authorization reports honest control
//   assessments and never claims enforcement.

/** Controls a conversation turn would need enforced in Strict Isolated Mode. */
export const conversationRequiredControls: readonly SecurityControl[] = [
  'workspace_write_confinement',
  'git_history_mutation_denied',
  'git_push_denied',
  'untrusted_config_isolation',
  'non_interactive_approval',
];

/** Trusted application state, loaded by the worker from persisted settings; never from requests. */
export const conversationGateStateSchema = z
  .object({
    /** The operator enabled AI Conversations. */
    enabled: z.boolean(),
    currentDisclosureVersion: disclosureVersionSchema,
    acceptance: z
      .object({ disclosureVersion: disclosureVersionSchema, acceptedAt: z.iso.datetime() })
      .strict()
      .nullable(),
    /** Canonical directory under which every turn's scratch directory must be created. */
    scratchRoot: z.string().min(1),
    /**
     * Paths a scratch directory must neither be inside of nor contain: connected repository roots
     * and common Git directories, the managed worktree root, the database directory.
     */
    protectedPaths: z.array(z.string().min(1)).max(10_000),
  })
  .strict();

export type ConversationGateState = z.infer<typeof conversationGateStateSchema>;

export type AuthorizeConversationTurnRequest = {
  /** Untrusted until validated; must be a conversation runtime policy. */
  policy: unknown;
  /** The turn and the exact prompt the launch will send on stdin. */
  turn: { turnId: string; prompt: string };
  runtime: AgentRuntime;
  installation: CliInstallation;
  modelId: string | null;
  /** As prepared by `prepareConversationTurn`. */
  invocation: AuthorizedInvocation;
  scratchDirectory: string;
};

export type ConversationGateDependencies = {
  now: () => Date;
  effectiveUid: () => number | undefined;
  sourceEnvironment: () => NodeJS.ProcessEnv;
};

const installationSchema = z
  .object({
    runtime: agentRuntimeSchema,
    executablePath: z.string().min(1),
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
    turn: z.object({ turnId: z.uuid(), prompt: z.string() }).strict(),
    runtime: agentRuntimeSchema,
    installation: installationSchema,
    modelId: z.string().max(200).nullable(),
    invocation: authorizedInvocationSchema,
    scratchDirectory: z.string().min(1).max(4096),
  })
  .strict();

const issuer = claimConversationIssuer();

const sameArguments = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const contains = (parent: string, child: string): boolean => {
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
};

/** Read-only checks of the turn's scratch directory. */
const checkScratchDirectory = async (
  path: string,
  state: ConversationGateState,
  uid: number | undefined,
): Promise<ConversationDenial[]> => {
  const deny = (message: string): ConversationDenial[] => [
    { code: 'scratch_directory_invalid', message },
  ];
  if (path.includes('\0') || !isAbsolute(path) || normalize(path) !== path) {
    return deny('The scratch directory must be an absolute, normalized path.');
  }
  const canonical = await realpath(path).catch(() => null);
  const root = await realpath(state.scratchRoot).catch(() => null);
  if (canonical === null || canonical !== path) {
    return deny('The scratch directory is missing or not canonical.');
  }
  if (root === null || root === canonical || !contains(root, canonical)) {
    return deny('The scratch directory is not inside the conversation scratch root.');
  }
  for (const protectedPath of state.protectedPaths) {
    const resolved = (await realpath(protectedPath).catch(() => null)) ?? protectedPath;
    if (contains(resolved, canonical) || contains(canonical, resolved)) {
      return deny(
        'The scratch directory overlaps a connected repository, the worktree root or application data.',
      );
    }
  }
  const stats = await lstat(canonical).catch(() => null);
  if (stats === null || !stats.isDirectory() || stats.isSymbolicLink()) {
    return deny('The scratch directory is not a real directory.');
  }
  if (uid === undefined || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
    return deny('The scratch directory must be private to the current user (mode 0700).');
  }
  const entries = await readdir(canonical).catch(() => null);
  if (entries === null || entries.length > 0) {
    return deny('The scratch directory must be empty before a turn starts.');
  }
  return [];
};

/**
 * Creates the conversation gate with explicit dependencies.
 *
 * @internal Tests only; the package exports `authorizeConversationTurn`.
 */
export const createConversationGate =
  (dependencies: ConversationGateDependencies) =>
  async (
    request: AuthorizeConversationTurnRequest,
    trustedState: ConversationGateState,
  ): Promise<ConversationAuthorizationDecision> => {
    const deny = (denials: ConversationDenial[]): ConversationAuthorizationDecision =>
      deepFreeze({ authorized: false, denials });
    const state = conversationGateStateSchema.safeParse(trustedState);
    if (!state.success) {
      return deny([{ code: 'invalid_request', message: describeIssues(state.error) }]);
    }
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) {
      return deny([{ code: 'invalid_request', message: describeIssues(parsed.error) }]);
    }
    const input = parsed.data;
    const now = dependencies.now();
    const profile = getConversationSecurityProfile(input.runtime);
    const assessments = securityControls.map((control) =>
      assessControl(profile, control, input.installation.version),
    );

    if (input.policy === undefined || input.policy === null) {
      return deny([{ code: 'policy_missing', message: 'No conversation policy was supplied.' }]);
    }
    const policyResult = conversationRuntimePolicySchema.safeParse(input.policy);
    if (!policyResult.success) {
      const mode =
        typeof input.policy === 'object' && 'mode' in input.policy ? input.policy.mode : undefined;
      return deny([
        mode === 'strict_isolated' || mode === 'trusted_local'
          ? { code: 'policy_invalid', message: describeIssues(policyResult.error) }
          : {
              code: 'mode_mismatch',
              message: `Conversation policies need mode "strict_isolated" or "trusted_local", not ${JSON.stringify(mode ?? null)}.`,
            },
      ]);
    }
    const policy = policyResult.data;
    if (policy.mode === 'strict_isolated') {
      // Fail-closed, and never downgraded to Trusted Local.
      const denials: ConversationDenial[] = conversationRequiredControls
        .map((control) => assessControl(profile, control, input.installation.version))
        .filter((assessment) => assessment.status !== 'enforced')
        .map((assessment) => ({
          code: 'control_not_enforced' as const,
          message: `Strict Isolated conversations require "${assessment.control}", but profile "${profile.id}" does not enforce it (${assessment.status}).`,
        }));
      return deny(
        denials.length > 0
          ? denials
          : [
              {
                code: 'control_not_enforced',
                message: 'Strict Isolated conversations are not available.',
              },
            ],
      );
    }
    const trustedPolicy: ConversationTrustedLocalPolicy = policy;
    const denials: ConversationDenial[] = [];

    const { enabled, acceptance, currentDisclosureVersion } = state.data;
    if (!enabled) {
      denials.push({
        code: 'conversation_disabled',
        message: 'AI Conversations are not enabled. Accept the disclosure in Settings.',
      });
    }
    if (acceptance === null) {
      denials.push({
        code: 'acceptance_missing',
        message: 'The AI Conversations disclosure has not been accepted.',
      });
    } else {
      if (acceptance.disclosureVersion !== currentDisclosureVersion) {
        denials.push({
          code: 'acceptance_stale',
          message: `The acceptance is for disclosure ${acceptance.disclosureVersion}; the current one is ${currentDisclosureVersion}.`,
        });
      }
      const acceptedAt = Date.parse(acceptance.acceptedAt);
      if (
        !Number.isFinite(acceptedAt) ||
        acceptedAt > now.getTime() ||
        trustedPolicy.acceptance.disclosureVersion !== acceptance.disclosureVersion ||
        trustedPolicy.acceptance.acceptedAt !== acceptance.acceptedAt
      ) {
        denials.push({
          code: 'acceptance_invalid',
          message: "The policy's acceptance does not match the operator's recorded acceptance.",
        });
      }
    }

    const uid = dependencies.effectiveUid();
    if (uid === undefined || uid === 0) {
      denials.push({
        code: 'elevated_privileges',
        message: uid === 0 ? 'CLIs must not run as root.' : 'The effective user is unknown.',
      });
    }

    const { installation, invocation, runtime } = input;
    if (installation.runtime !== runtime) {
      denials.push({ code: 'invalid_request', message: 'The installation is for another CLI.' });
    } else {
      if (!isSupportedCliVersion(runtime, installation.version)) {
        denials.push({
          code: 'cli_version_unsupported',
          message: `${runtime} ${installation.version} is not a supported CLI version.`,
        });
      }
      const detected = { path: installation.executablePath, ...installation.fingerprint };
      const executable = invocation.executable;
      if (
        detected.path !== executable.path ||
        detected.dev !== executable.dev ||
        detected.ino !== executable.ino ||
        detected.size !== executable.size ||
        detected.mtimeMs !== executable.mtimeMs
      ) {
        denials.push({
          code: 'executable_not_verified',
          message: 'The invocation executable is not the detected installation.',
        });
      }
      denials.push(
        ...(await verifyExecutable(executable)).map((denial) => ({
          code: 'executable_not_verified' as const,
          message: denial.message,
        })),
      );
      for (const problem of findRejectedConversationArguments(runtime, invocation.arguments)) {
        denials.push({ code: 'unsafe_launch_arguments', message: problem });
      }
      const preparation = prepareConversationTurn(
        installation,
        {
          turnId: input.turn.turnId,
          prompt: input.turn.prompt,
          modelId: input.modelId,
          scratchDirectory: input.scratchDirectory,
        },
        { sourceEnvironment: dependencies.sourceEnvironment() },
      );
      if (!preparation.ok) {
        denials.push({
          code:
            preparation.code === 'conversation_profile_unsupported'
              ? 'conversation_profile_unsupported'
              : preparation.code === 'unsafe_arguments'
                ? 'unsafe_launch_arguments'
                : 'invocation_invalid',
          message: preparation.message,
        });
      } else {
        const { plan } = preparation;
        if (
          !sameArguments(plan.profileArguments, profile.launchArguments) ||
          !sameArguments(plan.args, invocation.arguments) ||
          plan.invocation.environmentDigest !== invocation.environmentDigest
        ) {
          denials.push({
            code: 'invocation_invalid',
            message: 'The invocation differs from the conversation launch the adapter prepares.',
          });
        }
      }
    }
    if (getAgentAdapter(runtime).runtime !== profile.runtime) {
      denials.push({ code: 'invocation_invalid', message: 'Profile and adapter differ.' });
    }
    denials.push(...(await checkScratchDirectory(input.scratchDirectory, state.data, uid)));

    if (denials.length > 0) {
      return deny(denials);
    }
    const candidate = {
      kind: 'conversation_turn',
      mode: 'trusted_local',
      authorizationId: randomUUID(),
      checkedAt: now.toISOString(),
      turnId: input.turn.turnId,
      runtime,
      runtimeVersion: installation.version,
      launchProfileId: profile.id,
      launchArguments: [...profile.launchArguments],
      invocation: {
        executable: { ...invocation.executable },
        arguments: [...invocation.arguments],
        environmentDigest: invocation.environmentDigest,
      },
      scratchDirectory: input.scratchDirectory,
      policy: trustedPolicy,
      controlAssessments: assessments,
      acceptedRisks: assessments
        .filter((assessment) => assessment.status !== 'enforced')
        .map((assessment) => assessment.control),
      safeguards: [...conversationSafeguards],
      processContainment: 'process_group_only',
    };
    const authorization = conversationTurnAuthorizationSchema.safeParse(candidate);
    if (!authorization.success) {
      return deny([{ code: 'inspection_failed', message: describeIssues(authorization.error) }]);
    }
    if (issuer === null || !issuer(authorization.data, input.turn)) {
      return deny([
        {
          code: 'inspection_failed',
          message:
            'The authorization could not be registered with the conversation launch boundary.',
        },
      ]);
    }
    return deepFreeze({ authorized: true, authorization: authorization.data });
  };

/**
 * Decides, before launch, whether one conversation turn may start. Read-only: inspects the
 * filesystem and never starts a process. Trusted state comes from persisted operator settings;
 * nothing in the request can grant consent. Issued authorizations are registered for exactly one
 * `startConversationTurn` call with this turn and prompt.
 */
export const authorizeConversationTurn = createConversationGate({
  now: () => new Date(),
  effectiveUid: () => process.geteuid?.(),
  sourceEnvironment: () => process.env,
});
