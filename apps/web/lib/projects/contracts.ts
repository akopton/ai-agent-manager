import {
  executionErrorCodes,
  projectRegistrationErrorCodes,
  projectSchema,
  publicationErrorCodes,
  reviewActionErrorCodes,
  taskErrorCodes,
  taskRecoveryErrorCodes,
} from '@ai-agent-manager/core';
import { z } from 'zod';
import { reviewErrorCodes } from '@/lib/review/errors';

// Response contracts shared by the project and task route handlers, server components, and the
// browser.

export const apiErrorCodes = [
  ...projectRegistrationErrorCodes,
  ...taskErrorCodes,
  ...executionErrorCodes,
  'invalid_request',
  'unsupported_media_type',
  'payload_too_large',
  'forbidden_host',
  'forbidden_origin',
  'project_not_found',
  'project_has_dependents',
  'repository_unavailable',
  'repository_identity_changed',
  'database_not_ready',
  'repository_inspection_failed',
  ...reviewErrorCodes,
  ...reviewActionErrorCodes,
  ...publicationErrorCodes,
  ...taskRecoveryErrorCodes,
  'internal_error',
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];

export const apiErrorResponseSchema = z.object({
  error: z.object({
    // Kept open so a newer server code still renders as a readable message.
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export const headStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch'), branch: z.string(), commit: z.string() }),
  z.object({ kind: z.literal('unborn'), branch: z.string(), commit: z.null() }),
  z.object({ kind: z.literal('detached'), commit: z.string() }),
]);

export type HeadStateView = z.infer<typeof headStateSchema>;

export const remoteViewSchema = z.object({
  name: z.string(),
  /** First configured fetch URL with credentials redacted, or `null` if none is configured. */
  fetchUrl: z.string().nullable(),
});

export type RemoteView = z.infer<typeof remoteViewSchema>;

export const workingTreeSummarySchema = z.object({
  isClean: z.boolean(),
  staged: z.number().int(),
  unstaged: z.number().int(),
  untracked: z.number().int(),
  conflicted: z.number().int(),
});

export type WorkingTreeSummary = z.infer<typeof workingTreeSummarySchema>;

export const repositoryPreviewSchema = z.object({
  /** Canonical repository root that will be registered. */
  path: z.string(),
  gitCommonDir: z.string(),
  suggestedName: z.string(),
  head: headStateSchema,
  branches: z.array(z.string()),
  remotes: z.array(remoteViewSchema),
  suggestedBaseBranch: z.string(),
  suggestedRemoteName: z.string().nullable(),
  workingTree: workingTreeSummarySchema,
  /** Set when this repository is already registered. */
  existingProject: z.object({ id: z.string(), name: z.string() }).nullable(),
});

export type RepositoryPreview = z.infer<typeof repositoryPreviewSchema>;

export const repositoryStateSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    head: headStateSchema,
    branches: z.array(z.string()),
    remotes: z.array(remoteViewSchema),
    workingTree: workingTreeSummarySchema,
    baseBranchExists: z.boolean(),
    remoteExists: z.boolean(),
  }),
  /** The registered path no longer holds a usable repository (moved, deleted, or inaccessible). */
  z.object({ status: z.literal('unavailable'), code: z.string(), message: z.string() }),
  /** A repository exists at the path, but it is not the repository that was registered. */
  z.object({ status: z.literal('identity_changed'), message: z.string() }),
  z.object({ status: z.literal('inspection_failed'), message: z.string() }),
]);

export type RepositoryState = z.infer<typeof repositoryStateSchema>;

export const projectDetailsSchema = z.object({
  project: projectSchema,
  repository: repositoryStateSchema,
});

export type ProjectDetails = z.infer<typeof projectDetailsSchema>;

export const projectListResponseSchema = z.object({ projects: z.array(projectSchema) });

export const projectResponseSchema = z.object({ project: projectSchema });

export const repositoryPreviewResponseSchema = z.object({ preview: repositoryPreviewSchema });

export const disconnectProjectResponseSchema = z.object({
  disconnected: z.object({ id: z.string(), name: z.string() }),
});
