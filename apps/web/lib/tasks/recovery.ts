import {
  discardTaskInputSchema,
  recoverTaskInputSchema,
  taskRecoveryKindSchema,
  type TaskRecoveryKind,
} from '@ai-agent-manager/core';
import { z } from 'zod';

// Contracts for Retry, Resume and Discard (TM-01), shared by the route handlers, server components
// and the browser. The request schemas are the domain schemas from `core`; the recovery kind comes
// from the route, never from the body.

/** `POST …/retry` and `POST …/resume`: `{runId, processStopConfirmed?}`. */
export const recoverTaskRequestSchema = recoverTaskInputSchema;

/** `POST …/discard`: `{runId, confirmed: true}`. */
export const discardTaskRequestSchema = discardTaskInputSchema;

/** URL segment of each recovery route under `/api/projects/:projectId/tasks/:taskId/`. */
export const taskRecoverySegments: Readonly<Record<TaskRecoveryKind, string>> = {
  retry: 'retry',
  resume: 'resume',
};

/**
 * What the operator can do to recover or discard a task, derived on the server from the task's
 * latest run and records (never from the browser). Git state is not inspected here: the retained
 * worktree is re-verified when Retry or Resume is submitted and again before launch.
 */
export const taskRecoveryOptionsSchema = z.object({
  /** The latest attempt; requests name it so a stale page is refused. */
  runId: z.string(),
  attempt: z.number(),
  recovery: z
    .object({
      kind: taskRecoveryKindSchema,
      available: z.boolean(),
      /** Why the action is unavailable, for display. */
      unavailableReason: z.string().nullable(),
      /** The next attempt continues in the existing worktree with its current changes. */
      workspaceRetained: z.boolean(),
      /** The operator must confirm that no agent process of the attempt is still running. */
      processConfirmationRequired: z.boolean(),
      /** The latest review feedback is sent again, because no later attempt reached review. */
      carriesFeedback: z.boolean(),
    })
    .nullable(),
  discard: z
    .object({
      available: z.boolean(),
      unavailableReason: z.string().nullable(),
      workspaceRetained: z.boolean(),
    })
    .nullable(),
});

export type TaskRecoveryOptions = z.infer<typeof taskRecoveryOptionsSchema>;
