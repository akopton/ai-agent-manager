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

/** The author label of a message. C1 stores only operator notes. */
export const describeMessageAuthor = (message: Pick<ConversationMessage, 'role' | 'kind'>) => {
  if (message.role === 'assistant') {
    return { author: 'Assistant', detail: 'AI reply' };
  }
  return message.kind === 'note'
    ? { author: 'You', detail: 'Note · not sent to an AI' }
    : { author: 'You', detail: 'Message' };
};

export const formatMessageCount = (count: number): string =>
  count === 1 ? '1 note' : `${count.toLocaleString('en')} notes`;
