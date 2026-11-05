import { taskStatusSchema } from '@ai-agent-manager/core';
import { z } from 'zod';
import { taskRunViewSchema } from '@/lib/execution/contracts';
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
