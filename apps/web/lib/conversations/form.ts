import {
  conversationLanguageModeDefault,
  conversationRuntimeDefault,
  type AgentRuntime,
  type Conversation,
  type ConversationLanguageMode,
  type UpdateConversationInput,
} from '@ai-agent-manager/core';
import { modelValueProblem } from '@/lib/models/model-selection';
import {
  createProjectConversationRequestSchema,
  type CreateProjectConversationData,
} from '@/lib/conversations/contracts';

// Form state for creating a conversation and editing its settings. Kept free of React so it can be
// tested directly. Values are validated with the domain schema the server uses; the server
// validates again.

/** Value of the model field that means `Default` (no model override). */
export const defaultModel = '';

export type ConversationFormValues = {
  title: string;
  agentRuntime: AgentRuntime;
  /** An explicit model identifier, or `defaultModel`. */
  modelId: string;
  languageMode: ConversationLanguageMode;
};

export type ConversationFormField = keyof ConversationFormValues;

export type ConversationFieldErrors = Partial<Record<ConversationFormField, string>>;

export const newConversationFormValues = (): ConversationFormValues => ({
  title: '',
  agentRuntime: conversationRuntimeDefault,
  modelId: defaultModel,
  languageMode: conversationLanguageModeDefault,
});

export const conversationFormValues = (conversation: Conversation): ConversationFormValues => ({
  title: conversation.title,
  agentRuntime: conversation.agentRuntime,
  modelId: conversation.modelId ?? defaultModel,
  languageMode: conversation.languageMode,
});

/**
 * Switching the runtime resets the model to `Default`, as for tasks: an identifier meant for one
 * CLI is never silently passed to the other.
 */
export const changeConversationRuntime = (
  values: ConversationFormValues,
  agentRuntime: AgentRuntime,
): ConversationFormValues =>
  agentRuntime === values.agentRuntime
    ? values
    : { ...values, agentRuntime, modelId: defaultModel };

const conversationFormFields = new Set<string>([
  'title',
  'agentRuntime',
  'modelId',
  'languageMode',
]);

export const isConversationFormField = (key: string): key is ConversationFormField =>
  conversationFormFields.has(key);

type Validated =
  | { ok: true; request: CreateProjectConversationData }
  | { ok: false; fields: ConversationFieldErrors };

const parseConversationForm = (values: ConversationFormValues): Validated => {
  const parsed = createProjectConversationRequestSchema.safeParse({
    title: values.title,
    agentRuntime: values.agentRuntime,
    modelId: values.modelId.trim() === defaultModel ? null : values.modelId,
    languageMode: values.languageMode,
  });
  if (parsed.success) {
    return { ok: true, request: parsed.data };
  }
  const fields: ConversationFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (isConversationFormField(key) && fields[key] === undefined) {
      fields[key] = issue.message;
    }
  }
  return { ok: false, fields };
};

/** The model must fit the selected runtime (same rule as the server). */
const modelFields = (request: CreateProjectConversationData): Validated => {
  const problem = modelValueProblem(request.agentRuntime, request.modelId ?? '');
  return problem === null ? { ok: true, request } : { ok: false, fields: { modelId: problem } };
};

/** Validates the form; on success `request` holds the normalized values. */
export const validateConversationForm = (values: ConversationFormValues): Validated => {
  const result = parseConversationForm(values);
  return result.ok ? modelFields(result.request) : result;
};

export type ConversationUpdateResult =
  | { ok: true; update: UpdateConversationInput | null }
  | { ok: false; fields: ConversationFieldErrors };

/**
 * Validates the form and returns only the settings that differ from `conversation`, together with
 * the settings revision they are based on (`update: null` when nothing changed).
 */
export const buildConversationUpdate = (
  conversation: Conversation,
  values: ConversationFormValues,
): ConversationUpdateResult => {
  const parsed = parseConversationForm(values);
  if (!parsed.ok) {
    return parsed;
  }
  // Checked only when the runtime or model changes, so a stored custom ID stays editable.
  const result =
    parsed.request.agentRuntime !== conversation.agentRuntime ||
    parsed.request.modelId !== conversation.modelId
      ? modelFields(parsed.request)
      : parsed;
  if (!result.ok) {
    return result;
  }
  const { request } = result;
  const changes = {
    ...(request.title === conversation.title ? {} : { title: request.title }),
    ...(request.agentRuntime === conversation.agentRuntime
      ? {}
      : { agentRuntime: request.agentRuntime }),
    ...(request.modelId === conversation.modelId ? {} : { modelId: request.modelId }),
    ...(request.languageMode === conversation.languageMode
      ? {}
      : { languageMode: request.languageMode }),
  };
  return {
    ok: true,
    update:
      Object.keys(changes).length === 0 ? null : { revision: conversation.revision, ...changes },
  };
};
