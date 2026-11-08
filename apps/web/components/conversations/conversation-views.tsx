'use client';

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConversationPanel } from '@/components/conversations/conversation-panel';
import { chatAnchorTop } from '@/lib/conversations/chat-scroll';
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
  header,
  settings,
  notice,
  settingsOpen = false,
  onSettingsChange,
}: {
  tab: ConversationTab;
  onChange: (tab: ConversationTab) => void;
  chat: ReactNode;
  tasks: ReactNode;
  notes: ReactNode;
  turnActive: boolean;
  generating: boolean;
  hash?: string;
  header?: ReactNode;
  settings?: ReactNode;
  notice?: ReactNode;
  settingsOpen?: boolean;
  onSettingsChange?: () => void;
}) => {
  const settingsId = useId();
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => onChange(resolveConversationTab(value))}
      activationMode="manual"
      className="flex h-full min-h-0 flex-col gap-2"
    >
      {header === undefined ? null : (
        <header
          data-conversation-header
          className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3"
        >
          {header}
          <Button
            type="button"
            variant={settingsOpen ? 'secondary' : 'ghost'}
            className="h-9 w-28 text-xs sm:w-44"
            aria-expanded={settingsOpen}
            aria-controls={settingsId}
            onClick={onSettingsChange}
          >
            {settingsOpen ? <ArrowLeft aria-hidden="true" /> : <Settings2 aria-hidden="true" />}
            {settingsOpen ? (
              'Back to chat'
            ) : (
              <>
                <span className="hidden sm:inline">Conversation settings</span>
                <span className="sm:hidden">Settings</span>
              </>
            )}
          </Button>
        </header>
      )}
      {notice}

      {turnActive || generating ? (
        <p role="status" className="shrink-0 text-xs text-muted-foreground">
          {turnActive
            ? 'A reply is pending in Chat.'
            : 'Task proposals are being generated in Tasks.'}
        </p>
      ) : null}
      <Tabs.List aria-label="Conversation views" className="flex shrink-0 gap-1 border-b pb-1">
        {conversationTabs.map((value) => (
          <Tabs.Trigger
            key={value}
            value={value}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-primary/15 data-[state=active]:text-primary"
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
          hidden={settingsOpen || tab !== value}
          className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {value === 'chat' ? (
            <ChatViewContext.Provider value={{ active: !settingsOpen && tab === 'chat', hash }}>
              {chat}
            </ChatViewContext.Provider>
          ) : (
            { tasks, notes }[value]
          )}
        </Tabs.Content>
      ))}
      {settings === undefined ? null : (
        <div id={settingsId} hidden={!settingsOpen} className="min-h-0 flex-1 overflow-hidden">
          <ConversationPanel name="Conversation settings" label="Conversation settings form">
            {settings}
          </ConversationPanel>
        </div>
      )}
    </Tabs.Root>
  );
};

export const ConversationViews = (
  props: Omit<
    Parameters<typeof ConversationViewTabs>[0],
    'tab' | 'onChange' | 'settingsOpen' | 'onSettingsChange'
  >,
) => {
  const pathname = usePathname();
  const search = useSearchParams();
  const hash = useSyncExternalStore(subscribeHash, readHash, serverHash);
  const tab = resolveConversationTab(search.get('tab'), hash);
  const [settingsView, setSettingsView] = useState({ open: false, hash: '' });
  const settingsOpen = settingsView.open && settingsView.hash === hash;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const taskScrollTop = useRef(0);
  const taskHandledHash = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (tab !== 'tasks' || settingsOpen) return;
    const viewport = workspaceRef.current?.querySelector<HTMLElement>(
      '[aria-label="Task proposals"]',
    );
    if (viewport === undefined || viewport === null) return;
    const top = taskHandledHash.current === hash ? null : chatAnchorTop(viewport, hash);
    taskHandledHash.current = hash;
    viewport.scrollTop = top ?? taskScrollTop.current;
    const remember = () => {
      if (viewport.clientHeight > 0) taskScrollTop.current = viewport.scrollTop;
    };
    viewport.addEventListener('scroll', remember);
    return () => {
      remember();
      viewport.removeEventListener('scroll', remember);
    };
  }, [hash, tab, settingsOpen]);
  return (
    <div
      ref={workspaceRef}
      data-conversation-workspace
      className="h-full min-h-0 min-w-0"
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
          (!destination.hash.startsWith('#message-') && !destination.hash.startsWith('#proposals-'))
        )
          return;
        // Keep fragments in Next's history state so refreshes preserve the selected source/batch.
        // Chat owns local scrolling; the effect above positions proposal batches.
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
        settingsOpen={settingsOpen}
        onSettingsChange={() => setSettingsView({ open: !settingsOpen, hash })}
        onChange={(next) => {
          setSettingsView({ open: false, hash });
          window.history.pushState(null, '', conversationTabUrl(pathname, search.toString(), next));
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }}
      />
    </div>
  );
};
