'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConversationSummary } from '@/lib/conversations/contracts';
import { conversationUrl, newConversationUrl } from '@/lib/conversations/format';
import { formatTimestamp } from '@/lib/projects/format';
import { agentRuntimeLabels } from '@/lib/tasks/board';
import { cn } from '@/lib/utils';

export const ConversationNavigation = ({
  projectId,
  conversations,
}: {
  projectId: string;
  conversations: readonly ConversationSummary[];
}) => {
  const pathname = usePathname();
  const listId = useId();
  const [open, setOpen] = useState(false);
  // Defense in depth: never display another project's entries, even with mixed input.
  const scoped = conversations.filter((conversation) => conversation.projectId === projectId);
  return (
    <aside className="min-w-0 self-start rounded-xl border bg-card lg:sticky lg:top-6">
      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
        <p className="hidden text-sm font-semibold lg:block">Conversations</p>
        <Button
          variant="ghost"
          size="sm"
          className="lg:hidden"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
        >
          Conversations ({scoped.length})
          <ChevronDown aria-hidden="true" />
        </Button>
        <Button asChild size="sm">
          <Link href={newConversationUrl(projectId)} onClick={() => setOpen(false)}>
            <Plus aria-hidden="true" /> New conversation
          </Link>
        </Button>
      </div>
      <nav
        id={listId}
        aria-label="Project conversations"
        className={cn('max-h-[60dvh] overflow-y-auto border-t p-2 lg:block', !open && 'hidden')}
      >
        {scoped.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">No conversations yet.</p>
        ) : (
          <ul className="space-y-1">
            {scoped.map((conversation) => {
              const href = conversationUrl(projectId, conversation.id);
              const active = pathname === href;
              return (
                <li key={conversation.id}>
                  <Link
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                    className={cn(
                      'block rounded-lg px-3 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-primary/15 text-primary' : 'hover:bg-hover',
                    )}
                  >
                    <p className="truncate text-sm font-medium" title={conversation.title}>
                      {conversation.title}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {agentRuntimeLabels[conversation.agentRuntime]}
                    </p>
                    <time
                      dateTime={new Date(conversation.updatedAt).toISOString()}
                      className="text-xs text-muted-foreground tabular-nums"
                    >
                      {formatTimestamp(conversation.updatedAt)}
                    </time>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
};
