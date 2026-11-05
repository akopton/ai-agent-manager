import {
  acceptTrustedLocalInputSchema,
  agentRuntimeSchema,
  executionSecurityModeSchema,
  gitIntegrityResultStatusSchema,
  projectExecutionTrustInputSchema,
  projectExecutionTrustSchema,
  reviewStatusSchema,
  taskRunStatusSchema,
} from '@ai-agent-manager/core';
import { z } from 'zod';

// Request and response contracts for Trusted Local settings, project trust, start/stop requests
// and run inspection. Shared by route handlers, server components and the browser.

/** `PUT /api/settings/trusted-local`: accept the current disclosure, or disable the mode. */
export const trustedLocalSettingsRequestSchema = z.discriminatedUnion('enabled', [
  acceptTrustedLocalInputSchema.extend({ enabled: z.literal(true) }),
  z.strictObject({ enabled: z.literal(false) }),
]);

export type TrustedLocalSettingsRequest = z.infer<typeof trustedLocalSettingsRequestSchema>;

export const executionSettingsViewSchema = z.object({
  disclosure: z.object({
    version: z.string(),
    title: z.string(),
    statements: z.array(z.string()),
    acceptedRisks: z.array(z.string()),
  }),
  trustedLocal: z.object({
    enabled: z.boolean(),
    acceptedDisclosureVersion: z.string().nullable(),
    acceptedAt: z.number().nullable(),
    /** Enabled with an acceptance of the current disclosure. */
    current: z.boolean(),
  }),
});

export type ExecutionSettingsView = z.infer<typeof executionSettingsViewSchema>;

export const executionSettingsResponseSchema = z.object({ settings: executionSettingsViewSchema });

/** `PUT /api/projects/:projectId/execution-trust`. */
export const projectTrustRequestSchema = projectExecutionTrustInputSchema;

export const projectTrustViewSchema = z.object({
  executionTrust: projectExecutionTrustSchema,
  trustedCommonDir: z.string().nullable(),
  trustedAt: z.number().nullable(),
  /** Trusted for the repository identity that is registered now. */
  current: z.boolean(),
});

export type ProjectTrustView = z.infer<typeof projectTrustViewSchema>;

export const projectTrustResponseSchema = z.object({ trust: projectTrustViewSchema });

export const taskRunViewSchema = z.object({
  id: z.string(),
  attempt: z.number(),
  status: taskRunStatusSchema,
  active: z.boolean(),
  agentRuntime: agentRuntimeSchema,
  requestedModelId: z.string().nullable(),
  effectiveModelId: z.string().nullable(),
  securityMode: executionSecurityModeSchema,
  disclosureVersion: z.string().nullable(),
  cliVersion: z.string().nullable(),
  processContainment: z.string().nullable(),
  acceptedRisks: z.array(z.string()),
  safeguards: z.array(z.string()),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  summary: z.string().nullable(),
  stopRequestedAt: z.number().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  eventsDropped: z.number(),
  /** Process completed and the Git integrity check is clean. Never an approval. */
  reviewEligible: z.boolean(),
  gitIntegrity: z.object({
    status: gitIntegrityResultStatusSchema,
    checkedAt: z.number().nullable(),
    totalFindings: z.number(),
    findings: z.array(
      z.object({
        code: z.string(),
        disposition: z.enum(['violation', 'inconclusive']),
        subject: z.string(),
      }),
    ),
  }),
});

export type TaskRunView = z.infer<typeof taskRunViewSchema>;

/**
 * A stored review decision about one attempt (M6-02). `followUpRunId` is set once the worker has
 * claimed the attempt that continues from this change request; until then it is pending.
 */
export const reviewDecisionViewSchema = z.object({
  id: z.string(),
  status: reviewStatusSchema,
  runId: z.string(),
  /** Attempt number of the reviewed run. */
  attempt: z.number(),
  feedback: z.string(),
  createdAt: z.number(),
  followUpRunId: z.string().nullable(),
  followUpAttempt: z.number().nullable(),
});

export type ReviewDecisionView = z.infer<typeof reviewDecisionViewSchema>;

export const taskExecutionViewSchema = z.object({
  runs: z.array(taskRunViewSchema),
  workspace: z
    .object({
      path: z.string(),
      branch: z.string(),
      baseBranch: z.string(),
      baseSha: z.string(),
      createdAt: z.number(),
    })
    .nullable(),
  lastCommand: z
    .object({
      status: z.enum(['pending', 'accepted', 'rejected']),
      resultCode: z.string().nullable(),
      resultMessage: z.string().nullable(),
      createdAt: z.number(),
      processedAt: z.number().nullable(),
    })
    .nullable(),
  /** Review decisions of the task's attempts, newest first. */
  reviews: z.array(reviewDecisionViewSchema),
  /** Recent events of the latest run; `payload` is the stored, redacted JSON text. */
  events: z.array(
    z.object({
      sequence: z.number(),
      kind: z.string(),
      payload: z.string(),
      createdAt: z.number(),
    }),
  ),
});

export type TaskExecutionView = z.infer<typeof taskExecutionViewSchema>;

export const taskExecutionResponseSchema = z.object({ execution: taskExecutionViewSchema });
