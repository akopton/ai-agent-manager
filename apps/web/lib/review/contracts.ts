import {
  approvePublicationInputSchema,
  gitOperationKindSchema,
  gitOperationStatusSchema,
  publicationFailureStageSchema,
  publicationStatusSchema,
  requestChangesInputSchema,
  retryPublicationPushInputSchema,
  taskStatusSchema,
} from '@ai-agent-manager/core';
import { z } from 'zod';
import { reviewDecisionViewSchema, taskRunViewSchema } from '@/lib/execution/contracts';
import { reviewErrorCodes } from '@/lib/review/errors';

// Response contracts of the read-only Review Changes routes. Shared by route handlers, server
// components and the browser.

export const fileChangeTypes = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type_changed',
  'conflicted',
] as const;

export const diffOmissionReasons = [
  'too_large',
  'binary',
  'unsupported_file_type',
  'unsupported_encoding',
  'diff_too_large',
  'read_budget_exhausted',
  'outside_worktree',
] as const;

export type DiffOmissionReasonView = (typeof diffOmissionReasons)[number];

const fileKindSchema = z.enum(['file', 'executable', 'symlink', 'submodule', 'directory', 'other']);

/** One changed path, relative to the worktree root (base commit versus working tree). */
export const changedFileViewSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  change: z.enum(fileChangeTypes),
  /** `false` for untracked files. */
  tracked: z.boolean(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  /** Changed by a commit on the task branch after the base commit. */
  committed: z.boolean(),
  existsInWorktree: z.boolean(),
  kind: fileKindSchema,
  previousKind: fileKindSchema.nullable(),
  binary: z.boolean().nullable(),
  size: z.number().nullable(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  similarity: z.number().nullable(),
  symlinkTarget: z.string().nullable(),
  symlinkEscapesWorktree: z.boolean().nullable(),
  diffOmitted: z.enum(diffOmissionReasons).nullable(),
});

export type ChangedFileView = z.infer<typeof changedFileViewSchema>;

const reviewErrorCodeSchema = z.enum(reviewErrorCodes);

export const reviewChangesSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    headCommit: z.string(),
    /** False after a rebase or reset of the task branch. */
    baseIsAncestor: z.boolean(),
    files: z.array(changedFileViewSchema),
    totalFiles: z.number(),
    filesTruncated: z.boolean(),
    totals: z.object({ additions: z.number(), deletions: z.number() }),
    /** Git-ignored paths are counted, never listed or read. */
    ignoredCount: z.number(),
    ignoredTruncated: z.boolean(),
    consistency: z.enum(['stable', 'changed_during_inspection']),
    revision: z.string(),
  }),
  z.object({
    state: z.literal('unavailable'),
    code: reviewErrorCodeSchema,
    message: z.string(),
  }),
]);

export type ReviewChanges = z.infer<typeof reviewChangesSchema>;

/** Why the latest run is not eligible for the normal review path. */
export const reviewBlockReasons = [
  'no_run',
  'run_active',
  'run_not_completed',
  'integrity_violation',
  'integrity_inconclusive',
  'integrity_not_run',
  'task_not_in_review',
  'changes_unavailable',
  'changed_during_inspection',
] as const;

export type ReviewBlockReason = (typeof reviewBlockReasons)[number];

/**
 * Why Approve & Push is not offered for the current review (besides normal-review eligibility).
 * Derived from the inventory, the stored publications and the project's remote; page loads never
 * hash, stage, commit or push anything.
 */
export const publicationReadinessReasons = [
  'not_review_eligible',
  'no_changes',
  'files_truncated',
  'unexpected_commits',
  'conflicted_file',
  'unsupported_file',
  'no_remote',
  'remote_not_found',
  'remote_mirror',
  'publication_active',
  'push_pending',
] as const;

export type PublicationReadinessReason = (typeof publicationReadinessReasons)[number];

export const gitOperationViewSchema = z.object({
  kind: gitOperationKindSchema,
  attempt: z.number(),
  status: gitOperationStatusSchema,
  commitSha: z.string().nullable(),
  remoteName: z.string().nullable(),
  ref: z.string(),
  outcome: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});

export type GitOperationView = z.infer<typeof gitOperationViewSchema>;

export const publicationViewSchema = z.object({
  id: z.string(),
  status: publicationStatusSchema,
  failureStage: publicationFailureStageSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  runId: z.string(),
  /** Attempt number of the approved run. */
  attempt: z.number(),
  fileCount: z.number(),
  /** The approved paths (current path; renames also list their previous path). */
  files: z.array(
    z.object({ path: z.string(), previousPath: z.string().nullable(), change: z.string() }),
  ),
  snapshotHash: z.string(),
  baseCommit: z.string(),
  branch: z.string(),
  remoteName: z.string(),
  remoteUrl: z.string(),
  commitMessage: z.string(),
  commitSha: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  committedAt: z.number().nullable(),
  pushedAt: z.number().nullable(),
  /** The commit exists and only the push may be retried now. */
  canRetryPush: z.boolean(),
  operations: z.array(gitOperationViewSchema),
});

export type PublicationView = z.infer<typeof publicationViewSchema>;

export const publicationPanelSchema = z.object({
  /** Where Approve & Push would publish: the project's configured remote and the task branch. */
  destination: z
    .object({
      remoteName: z.string(),
      remoteUrl: z.string(),
      branch: z.string(),
      remoteRef: z.string(),
    })
    .nullable(),
  /** Generated from the task; the browser never supplies it. */
  commitMessage: z.string().nullable(),
  readiness: z.object({
    ready: z.boolean(),
    reasons: z.array(z.enum(publicationReadinessReasons)),
  }),
  /** The publication that holds the task (in progress or push pending), if any. */
  current: publicationViewSchema.nullable(),
  /** Every publication of the task, newest first. */
  history: z.array(publicationViewSchema),
});

export type PublicationPanel = z.infer<typeof publicationPanelSchema>;

export const taskReviewViewSchema = z.object({
  task: z.object({
    id: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    title: z.string(),
    status: taskStatusSchema,
  }),
  /** The latest run; `null` when the task never ran. */
  run: taskRunViewSchema.nullable(),
  workspace: z
    .object({
      path: z.string(),
      branch: z.string(),
      baseBranch: z.string(),
      baseSha: z.string(),
      createdAt: z.number(),
    })
    .nullable(),
  /**
   * Whether the result may follow the normal review path (and, later, publishing). Never an
   * approval: a completed process with a clean integrity check says nothing about correctness.
   */
  eligibility: z.object({
    eligible: z.boolean(),
    reasons: z.array(z.enum(reviewBlockReasons)),
  }),
  changes: reviewChangesSchema,
  /** Every attempt of the task, newest first. Earlier attempts keep their recorded evidence. */
  attempts: z.array(taskRunViewSchema),
  /** Review decisions of the task's attempts, newest first. */
  decisions: z.array(reviewDecisionViewSchema),
  /** Approve & Push (M6-03): destination, readiness and publication history. */
  publication: publicationPanelSchema,
});

export type TaskReviewView = z.infer<typeof taskReviewViewSchema>;

export const taskReviewResponseSchema = z.object({ review: taskReviewViewSchema });

export const fileDiffViewSchema = z.object({
  file: changedFileViewSchema,
  /** Complete unified diff, or `null` when it is not shown (see `omitted`). Never truncated. */
  patch: z.string().nullable(),
  omitted: z.enum(diffOmissionReasons).nullable(),
  consistency: z.enum(['stable', 'changed_during_inspection']),
  revision: z.string(),
});

export type FileDiffView = z.infer<typeof fileDiffViewSchema>;

export const fileDiffResponseSchema = z.object({ diff: fileDiffViewSchema });

/** `GET …/review/diff?path=`: a worktree-relative path as listed by the change inventory. */
export const fileDiffQuerySchema = z.object({
  path: z
    .string()
    .min(1, 'Choose a changed file.')
    .max(4096, 'The path is too long.')
    .refine((value) => !value.includes('\0'), 'The path is invalid.'),
});

/** `POST …/review/request-changes`: feedback for the attempt and inventory revision shown. */
export const requestChangesRequestSchema = requestChangesInputSchema;

export const requestChangesResponseSchema = z.object({
  task: z.object({ id: z.string(), status: taskStatusSchema }),
  decision: reviewDecisionViewSchema,
});

export type RequestChangesResponse = z.infer<typeof requestChangesResponseSchema>;

/** `POST …/review/approve`: the operator's confirmed approval (see `approvePublicationInputSchema`). */
export const approvePublicationRequestSchema = approvePublicationInputSchema;

/** `POST …/review/retry-push`. */
export const retryPublicationPushRequestSchema = retryPublicationPushInputSchema;

export const publicationResponseSchema = z.object({
  task: z.object({ id: z.string(), status: taskStatusSchema }),
  publication: publicationViewSchema,
});

export type PublicationResponse = z.infer<typeof publicationResponseSchema>;
