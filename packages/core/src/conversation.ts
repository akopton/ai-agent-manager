import { z } from 'zod';
import { agentRuntimeSchema, modelSelectionSchema, type AgentRuntime } from './agent-runtime.js';
import { projectIdSchema } from './project.js';

// C1 — AI Conversations Foundation (`IMPLEMENTATION_PLAN.md` §8). A conversation belongs to exactly
// one project and stores its settings and a durable, ordered message history. C1 runs no model:
// the only message that can be written is an operator note, which is stored locally and never sent
// to Claude Code or Codex. Real CLI-backed replies arrive in C2 on top of the same history.

export const conversationIdSchema = z.uuid();

export type ConversationId = z.infer<typeof conversationIdSchema>;

export const conversationMessageIdSchema = z.uuid();

/**
 * Language modes of a conversation:
 *
 * - `pl_technical_en`: discussion in Polish; technical prompts, task titles, code identifiers and
 *   other technical artifacts in English.
 * - `pl`: discussion and generated text in Polish.
 * - `en`: discussion and generated text in English.
 *
 * C2 sends the matching instruction (`conversationLanguageInstructions`) with every turn.
 */
export const conversationLanguageModes = ['pl_technical_en', 'pl', 'en'] as const;

export const conversationLanguageModeSchema = z.enum(conversationLanguageModes);

export type ConversationLanguageMode = z.infer<typeof conversationLanguageModeSchema>;

export const conversationLanguageModeDefault: ConversationLanguageMode = 'pl_technical_en';

export const conversationLanguageModeLabels: Readonly<Record<ConversationLanguageMode, string>> = {
  pl_technical_en: 'Polish, technical English',
  pl: 'Polish',
  en: 'English',
};

export const conversationLanguageModeDescriptions: Readonly<
  Record<ConversationLanguageMode, string>
> = {
  pl_technical_en:
    'Discussion in Polish. Technical prompts, task titles, code identifiers and other technical artifacts in English.',
  pl: 'Discussion and generated text in Polish.',
  en: 'Discussion and generated text in English.',
};

/**
 * The runtime of a new conversation when none is chosen. It matches the default of the task form;
 * there is no stored project or global runtime preference yet.
 */
export const conversationRuntimeDefault: AgentRuntime = 'claude';

export const conversationTitleMaxLength = 200;

export const conversationTitleSchema = z
  .string()
  .trim()
  .min(1, 'Enter a conversation title.')
  .max(conversationTitleMaxLength, `Use at most ${conversationTitleMaxLength} characters.`);

/**
 * Maximum message length in characters, after trimming. Chosen so a message still fits into the
 * API's 64 KiB request limit as JSON for typical (including Polish) text.
 */
export const conversationMessageMaxLength = 20_000;

/**
 * Message content: plain text that may contain Markdown. Leading and trailing whitespace is
 * trimmed and line endings are normalized to `\n`; the text is otherwise stored as entered.
 */
export const conversationMessageContentSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .min(1, 'Write a message before saving it.')
      .max(
        conversationMessageMaxLength,
        `Use at most ${conversationMessageMaxLength.toLocaleString('en')} characters.`,
      )
      .refine((value) => !value.includes('\0'), {
        message: 'The message must not contain null bytes.',
      }),
  );

/** Who wrote a message. `assistant` messages are replies stored by a completed C2 turn. */
export const conversationMessageRoles = ['user', 'assistant'] as const;

export const conversationMessageRoleSchema = z.enum(conversationMessageRoles);

export type ConversationMessageRole = z.infer<typeof conversationMessageRoleSchema>;

/**
 * How a message entered the history:
 *
 * - `note`: written by the operator and stored only. It is never sent to an agent (C1).
 * - `chat`: part of a CLI-backed exchange (C2): a message sent to the AI, or its reply.
 */
export const conversationMessageKinds = ['note', 'chat'] as const;

export const conversationMessageKindSchema = z.enum(conversationMessageKinds);

export type ConversationMessageKind = z.infer<typeof conversationMessageKindSchema>;

/** A new conversation in a project. `modelId: null` means `Default` (no CLI override). */
export const createConversationInputSchema = z.strictObject({
  projectId: projectIdSchema,
  title: conversationTitleSchema,
  agentRuntime: agentRuntimeSchema.default(conversationRuntimeDefault),
  modelId: modelSelectionSchema.default(null),
  languageMode: conversationLanguageModeSchema.default(conversationLanguageModeDefault),
});

export type CreateConversationInput = z.input<typeof createConversationInputSchema>;

export type CreateConversationData = z.output<typeof createConversationInputSchema>;

/**
 * Partial update of a conversation's settings. `revision` is the settings revision the operator
 * edited; an update based on an older revision is rejected instead of overwriting newer settings.
 */
export const updateConversationInputSchema = z
  .strictObject({
    revision: z.number().int().min(1),
    title: conversationTitleSchema.optional(),
    agentRuntime: agentRuntimeSchema.optional(),
    modelId: modelSelectionSchema.optional(),
    languageMode: conversationLanguageModeSchema.optional(),
  })
  .refine(
    (value) =>
      [value.title, value.agentRuntime, value.modelId, value.languageMode].some(
        (field) => field !== undefined,
      ),
    { message: 'Change at least one setting.' },
  );

export type UpdateConversationInput = z.input<typeof updateConversationInputSchema>;

export type UpdateConversationData = z.output<typeof updateConversationInputSchema>;

/**
 * An operator note. `requestId` is generated by the client for each submission and deduplicates
 * repeated submissions of the same note (double clicks, retries after a lost response).
 */
export const addConversationNoteInputSchema = z.strictObject({
  requestId: z.uuid(),
  content: conversationMessageContentSchema,
});

export type AddConversationNoteInput = z.input<typeof addConversationNoteInputSchema>;

/** A stored conversation. Timestamps are Unix milliseconds. */
export const conversationSchema = z.object({
  id: conversationIdSchema,
  projectId: projectIdSchema,
  title: z.string(),
  agentRuntime: agentRuntimeSchema,
  /** An explicit model identifier, or `null` for `Default`. */
  modelId: z.string().nullable(),
  languageMode: conversationLanguageModeSchema,
  /** Increases with every settings change; used to reject stale updates. */
  revision: z.number().int(),
  createdAt: z.number().int(),
  /** The last change to the settings or the history. */
  updatedAt: z.number().int(),
  /** When the newest message was saved; `null` while the history is empty. */
  lastMessageAt: z.number().int().nullable(),
});

export type Conversation = z.infer<typeof conversationSchema>;

/** A stored message. `sequence` orders the history: 1, 2, 3… per conversation, without gaps. */
export const conversationMessageSchema = z.object({
  id: conversationMessageIdSchema,
  conversationId: conversationIdSchema,
  sequence: z.number().int(),
  role: conversationMessageRoleSchema,
  kind: conversationMessageKindSchema,
  content: z.string(),
  createdAt: z.number().int(),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

/**
 * Applies the runtime/model rule of tasks (`SPEC.md` §5): switching the runtime without choosing a
 * model resets the model to `Default` instead of passing a model meant for the other CLI.
 */
export const resolveConversationUpdate = (
  current: { agentRuntime: AgentRuntime },
  update: UpdateConversationData,
): UpdateConversationData => {
  const runtimeChanged =
    update.agentRuntime !== undefined && update.agentRuntime !== current.agentRuntime;
  if (runtimeChanged && update.modelId === undefined) {
    return { ...update, modelId: null };
  }
  return update;
};

/** Expected reasons a conversation command is rejected. */
export const conversationErrorCodes = [
  'invalid_conversation_input',
  'project_not_found',
  'conversation_not_found',
  /** The settings changed since the operator loaded them. */
  'conversation_changed',
  /** A request ID was reused for a different message or conversation. */
  'conversation_request_conflict',
  // C2 — CLI-backed turns.
  /** The conversation already has a queued or running turn. */
  'conversation_turn_active',
  /** AI replies are off: the AI Conversations disclosure has not been accepted. */
  'conversation_ai_disabled',
  /** The accepted AI Conversations disclosure is older than the current one. */
  'conversation_ai_stale',
  'conversation_turn_not_found',
  /** Stop was requested for a turn that already finished. */
  'conversation_turn_not_active',
  /** Only the latest failed, stopped or interrupted turn can be retried. */
  'conversation_turn_not_retryable',
  // C3 — task proposals.
  /** Proposals need at least one answered exchange to work from. */
  'task_proposal_no_history',
  'task_proposal_generation_not_found',
  /** Stop was requested for a generation that already finished. */
  'task_proposal_generation_not_active',
  /** Only the latest failed, stopped or interrupted generation can be retried. */
  'task_proposal_generation_not_retryable',
  'task_proposal_not_found',
  /** The proposal changed since the operator loaded it (stale revision). */
  'task_proposal_changed',
  /** The proposal is approved or rejected and cannot be changed this way. */
  'task_proposal_not_editable',
  // C3.1 — source-scoped generation.
  /** The selected source reply does not exist in this conversation. */
  'task_proposal_source_not_found',
  /** The selected message is not a completed AI reply (a user message or a note). */
  'task_proposal_source_invalid',
] as const;

export const conversationErrorCodeSchema = z.enum(conversationErrorCodes);

export type ConversationErrorCode = z.infer<typeof conversationErrorCodeSchema>;

/** A rejected conversation command. `details` holds safe, structured context. */
export class ConversationError extends Error {
  override name = 'ConversationError';

  constructor(
    readonly code: ConversationErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}
