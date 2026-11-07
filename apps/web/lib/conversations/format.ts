import {
  conversationLanguageModeLabels,
  type ConversationLanguageMode,
  type ConversationMessage,
} from '@ai-agent-manager/core';

// Pure helpers for the conversation screens.

export const conversationsUrl = (projectId: string): string =>
  `/projects/${projectId}/conversations`;

export const newConversationUrl = (projectId: string): string =>
  `${conversationsUrl(projectId)}/new`;

export const conversationUrl = (projectId: string, conversationId: string): string =>
  `${conversationsUrl(projectId)}/${conversationId}`;

/** How the model selection is shown: `Default` means the CLI's own configuration. */
export const describeModel = (modelId: string | null): string => modelId ?? 'Default';

export const describeLanguageMode = (mode: ConversationLanguageMode): string =>
  conversationLanguageModeLabels[mode];

/** The author label of a message: notes stay local, chat messages were sent to the AI. */
export const describeMessageAuthor = (message: Pick<ConversationMessage, 'role' | 'kind'>) => {
  if (message.role === 'assistant') {
    return { author: 'AI reply', detail: 'From the selected CLI' };
  }
  return message.kind === 'note'
    ? { author: 'Note', detail: 'Not sent to an AI' }
    : { author: 'You', detail: 'Sent to AI' };
};

/** Messages, notes and replies together. */
export const formatMessageCount = (count: number): string =>
  count === 1 ? '1 message' : `${count.toLocaleString('en')} messages`;
