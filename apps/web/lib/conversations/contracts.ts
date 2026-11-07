import {
  addConversationNoteInputSchema,
  agentRuntimeSchema,
  conversationLanguageModeSchema,
  conversationMessageSchema,
  conversationSchema,
  conversationTurnStatusSchema,
  createConversationInputSchema,
  requestTaskProposalsInputSchema,
  retryConversationTurnInputSchema,
  retryTaskProposalGenerationInputSchema,
  sendConversationMessageInputSchema,
  taskPrioritySchema,
  taskProposalActionInputSchema,
  taskProposalGenerationStatuses,
  taskProposalStatusSchema,
  taskStatusSchema,
  updateConversationInputSchema,
  updateTaskProposalInputSchema,
} from '@ai-agent-manager/core';
import { z } from 'zod';

// Request and response contracts shared by the conversation route handlers, server components and
// the browser. The request schemas are the domain schemas from `core`; the project comes from the
// URL. Notes (`/messages`) are stored only; chat messages (`/turns`) ask the worker for a reply.

/** A new conversation in the project named by the route. Unknown keys are rejected. */
export const createProjectConversationRequestSchema = createConversationInputSchema.omit({
  projectId: true,
});

export type CreateProjectConversationRequest = z.input<
  typeof createProjectConversationRequestSchema
>;

export type CreateProjectConversationData = z.output<typeof createProjectConversationRequestSchema>;

/** Partial settings change, based on the settings revision the operator loaded. */
export const updateProjectConversationRequestSchema = updateConversationInputSchema;

export type UpdateProjectConversationRequest = z.input<
  typeof updateProjectConversationRequestSchema
>;

/** An operator note. The server always stores it as a `user` note; the role is not accepted. */
export const addConversationMessageRequestSchema = addConversationNoteInputSchema;

export type AddConversationMessageRequest = z.input<typeof addConversationMessageRequestSchema>;

/** A chat message for the AI (C2). The server stores it as a `user` chat message. */
export const sendConversationMessageRequestSchema = sendConversationMessageInputSchema;

export type SendConversationMessageRequest = z.input<typeof sendConversationMessageRequestSchema>;

export const retryConversationTurnRequestSchema = retryConversationTurnInputSchema;

export const conversationSummarySchema = conversationSchema.extend({
  messageCount: z.number().int(),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
});

export const conversationResponseSchema = z.object({ conversation: conversationSchema });

/** One request for an AI reply, as the UI shows it. Never contains the prompt. */
export const conversationTurnViewSchema = z.object({
  id: z.string(),
  status: conversationTurnStatusSchema,
  active: z.boolean(),
  userMessageId: z.string(),
  assistantMessageId: z.string().nullable(),
  retryOfTurnId: z.string().nullable(),
  agentRuntime: agentRuntimeSchema,
  requestedModelId: z.string().nullable(),
  effectiveModelId: z.string().nullable(),
  languageMode: conversationLanguageModeSchema,
  cliVersion: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  replyTruncated: z.boolean(),
  /** From the context manifest: earlier chat messages sent along, and those left out. */
  context: z
    .object({
      includedMessages: z.number().int(),
      omittedMessages: z.number().int(),
      notesExcluded: z.number().int(),
    })
    .nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  stopRequestedAt: z.number().int().nullable(),
});

export type ConversationTurnView = z.infer<typeof conversationTurnViewSchema>;

/** Whether AI replies can be requested now (separate AI Conversations consent). */
export const conversationAiStatusSchema = z.object({
  enabled: z.boolean(),
  /** `disabled` or `stale` explain why replies are off. */
  reason: z.enum(['enabled', 'disabled', 'stale']),
});

export type ConversationAiStatus = z.infer<typeof conversationAiStatusSchema>;

// ---------------------------------------------------------------------------------------------
// C3 — task proposals
// ---------------------------------------------------------------------------------------------

/** An explicit request for task proposals from one AI reply (C3.1), with an optional focus. */
export const requestTaskProposalsRequestSchema = requestTaskProposalsInputSchema;

export type RequestTaskProposalsRequest = z.input<typeof requestTaskProposalsRequestSchema>;

export const retryTaskProposalGenerationRequestSchema = retryTaskProposalGenerationInputSchema;

/** Edit of a draft proposal, based on the revision the operator loaded. */
export const updateTaskProposalRequestSchema = updateTaskProposalInputSchema;

export type UpdateTaskProposalRequest = z.input<typeof updateTaskProposalRequestSchema>;

/** Approve to Backlog, Reject and Reopen name the revision the operator saw. */
export const taskProposalActionRequestSchema = taskProposalActionInputSchema;

/** One explicit proposal request, as the UI shows it. Never contains the prompt. */
export const taskProposalGenerationViewSchema = z.object({
  id: z.string(),
  status: z.enum(taskProposalGenerationStatuses),
  active: z.boolean(),
  retryOfGenerationId: z.string().nullable(),
  agentRuntime: agentRuntimeSchema,
  requestedModelId: z.string().nullable(),
  effectiveModelId: z.string().nullable(),
  languageMode: conversationLanguageModeSchema,
  /** The operator's optional focus; empty when none. */
  instructions: z.string(),
  /**
   * C3.1: the AI reply the proposals were generated from. `null` for C3 requests, which used the
   * whole answered conversation. The source text itself is never returned here.
   */
  sourceMessageId: z.string().nullable(),
  basedOnSequence: z.number().int(),
  cliVersion: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  proposalCount: z.number().int(),
  skippedCount: z.number().int(),
  /** The AI's note from the proposal document. */
  note: z.string().nullable(),
  context: z
    .object({
      includedMessages: z.number().int(),
      omittedMessages: z.number().int(),
      notesExcluded: z.number().int(),
    })
    .nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  stopRequestedAt: z.number().int().nullable(),
});

export type TaskProposalGenerationView = z.infer<typeof taskProposalGenerationViewSchema>;

/**
 * A task proposal. The top-level task fields are the operator's current (approved, once
 * approved) values; `suggested` keeps what the AI suggested, so the two stay distinguishable.
 */
export const taskProposalViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  conversationId: z.string(),
  generationId: z.string(),
  position: z.number().int(),
  status: taskProposalStatusSchema,
  title: z.string(),
  prompt: z.string(),
  agentRuntime: agentRuntimeSchema,
  modelId: z.string().nullable(),
  priority: taskPrioritySchema,
  /** `null` = the project's default base branch. */
  baseBranch: z.string().nullable(),
  suggested: z.object({
    title: z.string(),
    prompt: z.string(),
    priority: taskPrioritySchema,
    agentRuntime: agentRuntimeSchema,
    modelId: z.string().nullable(),
  }),
  /** Whether the operator changed any value the AI suggested (or chose a base branch). */
  edited: z.boolean(),
  rationale: z.string(),
  dependencies: z.string(),
  revision: z.number().int(),
  /** The task created by approval. */
  taskId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  approvedAt: z.number().int().nullable(),
  rejectedAt: z.number().int().nullable(),
});

export type TaskProposalView = z.infer<typeof taskProposalViewSchema>;

export const taskProposalGenerationResponseSchema = z.object({
  generation: taskProposalGenerationViewSchema,
  created: z.boolean().optional(),
});

export const taskProposalListResponseSchema = z.object({
  proposals: z.array(taskProposalViewSchema),
  generations: z.array(taskProposalGenerationViewSchema),
});

export const taskProposalResponseSchema = z.object({ proposal: taskProposalViewSchema });

export const approveTaskProposalResponseSchema = z.object({
  proposal: taskProposalViewSchema,
  task: z.object({ id: z.string(), title: z.string(), status: taskStatusSchema }),
  /** `false` when the proposal was already approved and its existing task is returned. */
  created: z.boolean(),
});

export const conversationDetailResponseSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(conversationMessageSchema),
  turns: z.array(conversationTurnViewSchema),
  ai: conversationAiStatusSchema,
  generations: z.array(taskProposalGenerationViewSchema),
  proposals: z.array(taskProposalViewSchema),
});

export const conversationMessageResponseSchema = z.object({
  message: conversationMessageSchema,
  /** `false` when the same request was already saved and the stored note is returned. */
  created: z.boolean(),
});

export const sendConversationMessageResponseSchema = z.object({
  message: conversationMessageSchema,
  turn: conversationTurnViewSchema,
  created: z.boolean(),
});

export const conversationTurnResponseSchema = z.object({
  turn: conversationTurnViewSchema,
  created: z.boolean().optional(),
});

/** `PUT /api/settings/conversations`: accept the current disclosure, or turn AI replies off. */
export const conversationSettingsRequestSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(true), disclosureVersion: z.string().min(1).max(64) }),
  z.strictObject({ enabled: z.literal(false) }),
]);

export const conversationSettingsViewSchema = z.object({
  disclosure: z.object({
    version: z.string(),
    title: z.string(),
    statements: z.array(z.string()),
  }),
  enabled: z.boolean(),
  acceptedDisclosureVersion: z.string().nullable(),
  acceptedAt: z.number().nullable(),
  /** Enabled with an acceptance of the current disclosure. */
  current: z.boolean(),
});

export type ConversationSettingsView = z.infer<typeof conversationSettingsViewSchema>;

export const conversationSettingsResponseSchema = z.object({
  settings: conversationSettingsViewSchema,
});
