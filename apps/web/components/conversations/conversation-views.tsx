'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Tabs } from 'radix-ui';
import { ChatViewContext } from '@/components/conversations/conversation-chat';
import {
  conversationTabs,
  conversationTabUrl,
  resolveConversationTab,
  type ConversationTab,
} from '@/lib/conversations/workspace';

const subscribeHash = (notify: () => void) => {
  window.addEventListener('hashchange', notify);
  window.addEventListener('popstate', notify);
  return () => {
    window.removeEventListener('hashchange', notify);
    window.removeEventListener('popstate', notify);
  };
};
const readHash = () => window.location.hash;
const serverHash = () => '';
const labels = { chat: 'Chat', tasks: 'Tasks', notes: 'Notes' };

/** Kept mounted when hidden so switching views preserves unsaved drafts and pending requests. */
export const ConversationViewTabs = ({
  tab,
  onChange,
  chat,
  tasks,
  notes,
  turnActive,
  generating,
  hash = '',
}: {
  tab: ConversationTab;
  onChange: (tab: ConversationTab) => void;
  chat: ReactNode;
  tasks: ReactNode;
  notes: ReactNode;
  turnActive: boolean;
  generating: boolean;
  hash?: string;
}) => (
  <Tabs.Root
    value={tab}
    onValueChange={(value) => onChange(resolveConversationTab(value))}
    activationMode="manual"
  >
    {turnActive || generating ? (
      <p role="status" className="mb-3 text-xs text-muted-foreground">
        {turnActive
          ? 'A reply is pending in Chat.'
          : 'Task proposals are being generated in Tasks.'}
      </p>
    ) : null}
    <Tabs.List aria-label="Conversation views" className="mb-4 flex gap-1 border-b pb-2">
      {conversationTabs.map((value) => (
        <Tabs.Trigger
          key={value}
          value={value}
          className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-primary/15 data-[state=active]:text-primary"
        >
          {labels[value]}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
    {conversationTabs.map((value) => (
      <Tabs.Content
        key={value}
        value={value}
        forceMount
        hidden={tab !== value}
        className="min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {value === 'chat' ? (
          <ChatViewContext.Provider value={{ active: tab === 'chat', hash }}>
            {chat}
          </ChatViewContext.Provider>
        ) : (
          { tasks, notes }[value]
        )}
      </Tabs.Content>
    ))}
  </Tabs.Root>
);

export const ConversationViews = (
  props: Omit<Parameters<typeof ConversationViewTabs>[0], 'tab' | 'onChange'>,
) => {
  const pathname = usePathname();
  const search = useSearchParams();
  const hash = useSyncExternalStore(subscribeHash, readHash, serverHash);
  const tab = resolveConversationTab(search.get('tab'), hash);
  useEffect(() => {
    if (!hash || tab === 'chat') return;
    // Chat owns its transcript anchors. Proposal batches retain their existing navigation.
    const frame = requestAnimationFrame(() =>
      document.getElementById(hash.slice(1))?.scrollIntoView(),
    );
    return () => cancelAnimationFrame(frame);
  }, [hash, tab]);
  return (
    <div
      onClickCapture={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        if (!(event.target instanceof Element)) return;
        const link = event.target.closest('a');
        if (link === null || link.target || link.hasAttribute('download')) return;
        const destination = link;
        if (
          destination.origin !== window.location.origin ||
          destination.pathname !== pathname ||
          !destination.hash.startsWith('#message-')
        )
          return;
        // Native fragment navigation scrolls every ancestor. Let Chat move only its viewport.
        event.preventDefault();
        window.history.pushState(
          null,
          '',
          destination.pathname + destination.search + destination.hash,
        );
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }}
    >
      <ConversationViewTabs
        {...props}
        hash={hash}
        tab={tab}
        onChange={(next) => {
          window.history.pushState(null, '', conversationTabUrl(pathname, search.toString(), next));
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }}
      />
    </div>
  );
};
