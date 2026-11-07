import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import type { ConversationSummary } from '@/lib/conversations/contracts';
import {
  conversationUrl,
  describeLanguageMode,
  formatMessageCount,
} from '@/lib/conversations/format';
import { describeModelChoice } from '@/lib/models/model-selection';
import { formatTimestamp } from '@/lib/projects/format';
import { agentRuntimeLabels } from '@/lib/tasks/board';

/** A project's conversations, most recently changed first. */
export const ConversationList = ({
  projectId,
  conversations,
}: {
  projectId: string;
  conversations: readonly ConversationSummary[];
}) => (
  <ul aria-label="Conversations" className="divide-y overflow-hidden rounded-xl border bg-card">
    {conversations.map((conversation) => (
      <li key={conversation.id}>
        <Link
          href={conversationUrl(projectId, conversation.id)}
          className="flex items-center gap-4 px-4 py-3.5 transition-colors outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-sm font-medium">{conversation.title}</p>
            <p className="text-xs leading-5 text-muted-foreground">
              {agentRuntimeLabels[conversation.agentRuntime]} ·{' '}
              {describeModelChoice(conversation.agentRuntime, conversation.modelId)} ·{' '}
              {describeLanguageMode(conversation.languageMode)}
            </p>
          </div>
          <div className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
            <p>{formatMessageCount(conversation.messageCount)}</p>
            <p className="tabular-nums">{formatTimestamp(conversation.updatedAt)}</p>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
      </li>
    ))}
  </ul>
);
