import {
  requestWorkspaceCleanupInputSchema,
  workspaceCleanupStatusSchema,
} from '@ai-agent-manager/core';
import { z } from 'zod';

// Contracts for the managed workspace panel, Remove local worktree, and Archive/Restore (TM-02),
// shared by the route handlers, server components and the browser. Paths are display-only: the
// browser names a workspace by its record ID and the commit it saw, never by a path.

/** `POST …/workspace/cleanup`: `{requestId, workspaceId, expectedCommit, confirmed: true}`. */
export const workspaceCleanupRequestSchema = requestWorkspaceCleanupInputSchema;

export const workspaceCleanupViewSchema = z.object({
  id: z.string(),
  status: workspaceCleanupStatusSchema,
  basis: z.enum(['published', 'discarded_unchanged']),
  expectedCommit: z.string(),
  branchCommit: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  removedAt: z.number().nullable(),
});

export type WorkspaceCleanupView = z.infer<typeof workspaceCleanupViewSchema>;

/**
 * - `none`: the task never created a worktree.
 * - `retained`: Git confirms the managed worktree.
 * - `missing`: the directory and registration are gone, but no removal was recorded.
 * - `inconsistent`: something exists at the location that is not a verified task worktree.
 * - `unavailable`: the repository or worktree could not be inspected.
 * - `removed`: Remove local worktree completed; the records are kept.
 */
export const workspaceStates = [
  'none',
  'retained',
  'missing',
  'inconsistent',
  'unavailable',
  'removed',
] as const;

export const workspacePanelSchema = z.object({
  state: z.enum(workspaceStates),
  workspace: z
    .object({
      id: z.string(),
      path: z.string(),
      branch: z.string(),
      baseBranch: z.string(),
      baseSha: z.string(),
      createdAt: z.number(),
    })
    .nullable(),
  git: z
    .object({
      registered: z.boolean(),
      pathExists: z.boolean(),
      locked: z.boolean(),
      managedLock: z.boolean(),
      branchCommit: z.string().nullable(),
      headCommit: z.string().nullable(),
      identityVerified: z.boolean(),
      identityReason: z.string().nullable(),
      workingTree: z
        .object({
          clean: z.boolean(),
          staged: z.number(),
          unstaged: z.number(),
          untracked: z.number(),
          conflicted: z.number(),
        })
        .nullable(),
      ignoredCount: z.number().nullable(),
    })
    .nullable(),
  cleanup: z.object({
    available: z.boolean(),
    /** The commit the request must name; `null` when removal is unavailable. */
    expectedCommit: z.string().nullable(),
    basis: z.enum(['published', 'discarded_unchanged']).nullable(),
    /** Why removal is unavailable, for display (empty when available). */
    reasons: z.array(z.string()),
  }),
  /** The newest removal request, if any. */
  current: workspaceCleanupViewSchema.nullable(),
  history: z.array(workspaceCleanupViewSchema),
});

export type WorkspacePanel = z.infer<typeof workspacePanelSchema>;

export const workspacePanelResponseSchema = z.object({ workspace: workspacePanelSchema });

export const workspaceCleanupResponseSchema = z.object({ cleanup: workspaceCleanupViewSchema });

/** Whether a task can be archived now, derived on the server from its records. */
export const taskArchiveOptionSchema = z.object({
  archived: z.boolean(),
  available: z.boolean(),
  reason: z.string().nullable(),
});

export type TaskArchiveOption = z.infer<typeof taskArchiveOptionSchema>;
