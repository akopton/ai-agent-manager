import {
  addConversationNoteInputSchema,
  conversationMessageSchema,
  conversationSchema,
  createConversationInputSchema,
  updateConversationInputSchema,
} from '@ai-agent-manager/core';
import { z } from 'zod';

// Request and response contracts shared by the conversation route handlers, server components and
// the browser. The request schemas are the domain schemas from `core`; the project comes from the
// URL. C1 has no request that produces or stores an AI reply.

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

export const conversationSummarySchema = conversationSchema.extend({
  messageCount: z.number().int(),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
});

export const conversationResponseSchema = z.object({ conversation: conversationSchema });

export const conversationDetailResponseSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(conversationMessageSchema),
});

export const conversationMessageResponseSchema = z.object({
  message: conversationMessageSchema,
  /** `false` when the same request was already saved and the stored note is returned. */
  created: z.boolean(),
});
