import { z } from 'zod';
import { agentRuntimeSchema } from './agent-runtime.js';
import { authorizedInvocationSchema } from './execution-authorization.js';
import {
  controlAssessmentSchema,
  disclosureVersionSchema,
  maxExecutionTimeoutMs,
  securityControlSchema,
  securityControls,
} from './security-policy.js';

// Conversation Mode security contracts (C2, `ARCHITECTURE.md` §15.2 and §7.5 "Conversation Mode").
// They are deliberately **separate types** from Execution Mode: a conversation authorization has
// no worktree, repository or task, and `startAgentExecution` rejects it. Execution Mode acceptance
// and project trust never enable conversations, and conversation acceptance never grants task
// execution, worktrees or publishing.

/**
 * The versioned AI Conversations disclosure. Changing any statement requires a new `version`; an
 * acceptance of an older version is stale and blocks every turn until the operator accepts again.
 */
export const conversationDisclosure = Object.freeze({
  // C4 (2026-11-07.2): project-aware conversations can send repository excerpts, so the earlier
  // statement "gives it no … project file" changed and the acceptance must be renewed.
  version: '2026-11-07.2',
  title: 'AI Conversations (Trusted Local)',
  statements: Object.freeze([
    'Sending a chat message starts Claude Code or Codex on this Mac as your user, with your account’s permissions and the CLI login you already use. No API keys are used or stored.',
    'The message, a language instruction and the earlier chat messages of the same conversation are sent to the provider behind the selected CLI. Notes are never sent.',
    'The CLI runs in a new, empty scratch directory under the AI Agent Manager data folder. AI Agent Manager never gives it a repository path, worktree or task data.',
    'General Chat sends no project files. A Project-Aware conversation additionally sends excerpts of committed files that AI Agent Manager reads from that project’s repository, and only after you allowed source sharing for that project separately. Before the answer, the CLI is run once more to choose the files from a list of paths.',
    'Claude Code is started with all tools disabled; Codex runs in its read-only sandbox. These are CLI settings, not OS-enforced isolation, and they have not been adversarially verified: a CLI could still read files your account can read and reach the network.',
    'Conversations never create, queue or start tasks, create worktrees, commit, push or publish. AI Agent Manager does not act on anything a reply says.',
    'Stop terminates the CLI’s process group, not every possible descendant process.',
    'The CLIs may keep their own local records (for example logs or caches under ~/.claude or ~/.codex), although session persistence is turned off where the CLI supports it.',
    'Replies can be wrong or incomplete. Treat them as advice.',
  ] as const),
});

/** Conversation security modes. Strict Isolated stays fail-closed until a profile is verified. */
export const conversationSecurityModes = ['strict_isolated', 'trusted_local'] as const;

export const conversationSecurityModeSchema = z.enum(conversationSecurityModes);

export type ConversationSecurityMode = z.infer<typeof conversationSecurityModeSchema>;

/** Mandatory wall-clock limit of one conversation turn. */
export const conversationTurnTimeoutMs = 10 * 60 * 1000;

export const conversationStrictPolicySchema = z
  .object({ mode: z.literal('strict_isolated'), version: z.literal(1) })
  .strict();

export const conversationTrustedLocalPolicySchema = z
  .object({
    mode: z.literal('trusted_local'),
    version: z.literal(1),
    /** The operator's recorded acceptance of `conversationDisclosure`. */
    acceptance: z
      .object({ disclosureVersion: disclosureVersionSchema, acceptedAt: z.iso.datetime() })
      .strict(),
    /** Mandatory and bounded. */
    timeoutMs: z.number().int().positive().max(maxExecutionTimeoutMs),
  })
  .strict();

export type ConversationTrustedLocalPolicy = z.output<typeof conversationTrustedLocalPolicySchema>;

export const conversationRuntimePolicySchema = z.discriminatedUnion('mode', [
  conversationStrictPolicySchema,
  conversationTrustedLocalPolicySchema,
]);

export type ConversationRuntimePolicy = z.output<typeof conversationRuntimePolicySchema>;

/**
 * What a Trusted Local conversation authorization actually applied. None of these is an
 * isolation claim:
 *
 * - `invocation_binding`: executable identity, every argument and the environment digest.
 * - `scratch_directory_verification`: a canonical, empty, private directory inside the
 *   conversation scratch root and outside every connected repository and the worktree root.
 * - `no_repository_path`: no repository, worktree or project path is passed to the CLI.
 * - `allow_listed_environment`, `non_root`, `mandatory_timeout`, `output_limits`,
 *   `process_group_stop`: as in Execution Mode.
 */
export const conversationSafeguards = [
  'invocation_binding',
  'scratch_directory_verification',
  'no_repository_path',
  'allow_listed_environment',
  'non_root',
  'mandatory_timeout',
  'output_limits',
  'process_group_stop',
] as const;

export const conversationSafeguardSchema = z.enum(conversationSafeguards);

export type ConversationSafeguard = z.infer<typeof conversationSafeguardSchema>;

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'must not contain NUL characters');

/**
 * Authorization for **one** conversation turn in Trusted Local Mode. There is deliberately no
 * `controls`/`enforced` field: `controlAssessments` are the honest statuses of the conversation
 * launch profile, and every control that is not enforced is listed in `acceptedRisks`.
 */
export const conversationTurnAuthorizationSchema = z
  .object({
    kind: z.literal('conversation_turn'),
    mode: z.literal('trusted_local'),
    authorizationId: z.uuid(),
    checkedAt: z.iso.datetime(),
    turnId: z.uuid(),
    runtime: agentRuntimeSchema,
    runtimeVersion: z.string().min(1).max(100),
    launchProfileId: z.string().min(1).max(100),
    launchArguments: z.array(z.string().max(1000)).max(100).readonly(),
    invocation: authorizedInvocationSchema,
    scratchDirectory: pathSchema,
    policy: conversationTrustedLocalPolicySchema,
    controlAssessments: z.array(controlAssessmentSchema).length(securityControls.length).readonly(),
    acceptedRisks: z.array(securityControlSchema).max(securityControls.length).readonly(),
    safeguards: z.array(conversationSafeguardSchema).min(1).readonly(),
    processContainment: z.literal('process_group_only'),
  })
  .strict()
  .superRefine((value, context) => {
    const assessed = value.controlAssessments.map((assessment) => assessment.control);
    if (securityControls.some((control, index) => assessed[index] !== control)) {
      context.addIssue({
        code: 'custom',
        path: ['controlAssessments'],
        message: 'Every control must be assessed exactly once, in order.',
      });
    }
    const unenforced = value.controlAssessments
      .filter((assessment) => assessment.status !== 'enforced')
      .map((assessment) => assessment.control);
    if (
      unenforced.length !== value.acceptedRisks.length ||
      unenforced.some((control) => !value.acceptedRisks.includes(control))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['acceptedRisks'],
        message: 'Accepted risks must equal the controls that are not enforced.',
      });
    }
    for (const safeguard of conversationSafeguards) {
      if (!value.safeguards.includes(safeguard)) {
        context.addIssue({
          code: 'custom',
          path: ['safeguards'],
          message: `Safeguard "${safeguard}" is mandatory.`,
        });
      }
    }
    if (
      value.invocation.arguments.length < value.launchArguments.length ||
      value.launchArguments.some(
        (argument, index) => value.invocation.arguments[index] !== argument,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['invocation', 'arguments'],
        message: 'The invocation must start with the launch arguments.',
      });
    }
  });

export type ConversationTurnAuthorization = z.output<typeof conversationTurnAuthorizationSchema>;

export const conversationDenialCodes = [
  'invalid_request',
  'policy_missing',
  'policy_invalid',
  /** Only Trusted Local policies are accepted by the Trusted Local conversation path. */
  'mode_mismatch',
  /** Strict Isolated: a required control of the conversation profile is not enforced. */
  'control_not_enforced',
  'conversation_disabled',
  'acceptance_missing',
  'acceptance_stale',
  'acceptance_invalid',
  'cli_version_unsupported',
  /** The installed CLI does not list an option the conversation profile needs. */
  'conversation_profile_unsupported',
  'executable_not_verified',
  'unsafe_launch_arguments',
  'invocation_invalid',
  'scratch_directory_invalid',
  'elevated_privileges',
  'timeout_required',
  'inspection_failed',
] as const;

export const conversationDenialCodeSchema = z.enum(conversationDenialCodes);

export type ConversationDenialCode = z.infer<typeof conversationDenialCodeSchema>;

export type ConversationDenial = { code: ConversationDenialCode; message: string };

export type ConversationAuthorizationDecision =
  | { authorized: true; authorization: ConversationTurnAuthorization }
  | { authorized: false; denials: readonly ConversationDenial[] };
