import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { ConversationNavigation } from '@/components/conversations/conversation-navigation';
import { ConversationViewTabs } from '@/components/conversations/conversation-views';
import {
  conversationTabs,
  conversationTabUrl,
  resolveConversationTab,
} from '@/lib/conversations/workspace';
import {
  activeProjectSection,
  rememberWorkspaceLocation,
} from '@/lib/projects/workspace-navigation';
import type { ConversationSummary } from '@/lib/conversations/contracts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1);
const pathname = `/projects/${projectId}/conversations/${id(2)}`;
const conversation = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: id(2),
  projectId,
  title: 'A long conversation title '.repeat(12),
  agentRuntime: 'codex',
  modelId: null,
  languageMode: 'en',
  contextMode: 'general',
  revision: 1,
  createdAt: 1,
  updatedAt: 2,
  lastMessageAt: null,
  messageCount: 0,
  ...overrides,
});

test('conversation navigation scopes entries, marks only the active detail and exposes New', () => {
  const html = renderToStaticMarkup(
    createElement(
      PathnameContext.Provider,
      { value: pathname },
      createElement(ConversationNavigation, {
        projectId,
        conversations: [
          conversation(),
          conversation({ id: id(3), title: 'Other topic' }),
          conversation({ id: id(4), projectId: id(5), title: 'Foreign project' }),
        ],
      }),
    ),
  );
  assert.match(html, /aria-label="Project conversations"/);
  assert.match(html, new RegExp(`<a[^>]*aria-current="page"[^>]*href="${pathname}"`));
  assert.equal(html.match(/aria-current="page"/g)?.length, 1);
  assert.doesNotMatch(html, /Foreign project/);
  assert.match(html, /Codex/);
  assert.match(html, /<time dateTime=/);
  assert.match(html, /truncate/);
  assert.match(html, new RegExp(`href="/projects/${projectId}/conversations/new"`));
  assert.match(html, /aria-expanded="false" aria-controls=/);
  assert.match(html, /lg:block[^"]*hidden/);
  assert.match(html, /max-h-48 overflow-y-auto/);
  assert.match(html, /focus-visible:ring-ring/);
});

test('empty project navigation still provides creation', () => {
  const html = renderToStaticMarkup(
    createElement(ConversationNavigation, { projectId, conversations: [] }),
  );
  assert.match(html, /No conversations yet/);
  assert.match(html, /New conversation/);
});

test('tabs expose accessible panels, keep drafts mounted and show work status in every view', () => {
  for (const tab of conversationTabs) {
    const html = renderToStaticMarkup(
      createElement(ConversationViewTabs, {
        tab,
        onChange: () => assert.fail('rendering must not change tabs or start work'),
        chat: 'Chat contents',
        tasks: 'Proposal history',
        notes: 'Local notes',
        turnActive: false,
        generating: true,
      }),
    );
    assert.match(html, /role="tablist"[^>]*aria-label="Conversation views"/);
    assert.equal(html.match(/role="tab"/g)?.length, 3);
    assert.equal(html.match(/role="tabpanel"/g)?.length, 3);
    assert.equal(html.match(/hidden=""/g)?.length, 2);
    assert.match(
      html,
      new RegExp(
        `data-state="active"[^>]*role="tabpanel"[^>]*>${tab === 'chat' ? 'Chat contents' : tab === 'tasks' ? 'Proposal history' : 'Local notes'}`,
      ),
    );
    assert.match(html, /Task proposals are being generated in Tasks/);
    assert.match(html, /Chat contents/);
    assert.match(html, /Proposal history/);
    assert.match(html, /Local notes/);
    assert.match(html, /data-\[state=active\]:text-primary/);
  }
});

test('tab URLs preserve queries, refresh selection and legacy source/batch anchors', () => {
  assert.equal(resolveConversationTab(null), 'chat');
  assert.equal(resolveConversationTab('unknown'), 'chat');
  for (const tab of conversationTabs) {
    const url = conversationTabUrl(pathname, 'other=kept&tab=chat', tab);
    const parsed = new URL(url, 'http://localhost');
    assert.equal(parsed.pathname, pathname);
    assert.equal(parsed.searchParams.get('other'), 'kept');
    assert.equal(parsed.searchParams.getAll('tab').length, 1);
    assert.equal(resolveConversationTab(parsed.searchParams.get('tab')), tab);
    assert.equal(resolveConversationTab(tab, `#message-${id(6)}`), 'chat');
    assert.equal(resolveConversationTab(tab, `#proposals-${id(7)}`), 'tasks');
  }
  // UI-04A still remembers the detail path, and keeps Conversations active for every view.
  assert.equal(
    rememberWorkspaceLocation(projectId, {}, pathname, 'tab=notes').conversation,
    pathname,
  );
  assert.equal(activeProjectSection(projectId, pathname), 'conversations');
});

test('the persistent header control replaces only the panel and keeps all view content mounted', () => {
  for (const settingsOpen of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(ConversationViewTabs, {
        tab: 'notes',
        onChange: () => undefined,
        turnActive: false,
        generating: false,
        header: createElement('h1', null, 'A long title'),
        settings: 'Settings form',
        settingsOpen,
        onSettingsChange: () => undefined,
        chat: 'Retained chat draft',
        tasks: 'Retained proposal draft',
        notes: 'Retained note draft',
      }),
    );
    assert.equal(html.match(/data-conversation-header/g)?.length, 1);
    assert.equal(html.match(/aria-expanded=/g)?.length, 1);
    assert.ok(html.includes(settingsOpen ? 'Back to chat' : 'Conversation settings'));
    assert.match(html, /Retained chat draft/);
    assert.match(html, /Retained proposal draft/);
    assert.match(html, /Retained note draft/);
    assert.match(html, /Settings form/);
    assert.match(html, /min-h-0 min-w-0 flex-1 overflow-hidden/);
  }
});

test('shared panels keep composer outside their focusable history scroll boundary', async () => {
  const { ConversationPanel } = await import('@/components/conversations/conversation-panel');
  for (const name of ['Chat', 'Tasks', 'Notes', 'Conversation settings']) {
    const html = renderToStaticMarkup(
      createElement(
        ConversationPanel,
        {
          name,
          label: `${name} history`,
          footer:
            name === 'Chat' || name === 'Notes' ? createElement('form', null, 'Draft') : undefined,
        },
        'Long history',
      ),
    );
    assert.match(html, /role="region"[^>]*tabindex="0"/);
    assert.match(html, /min-h-0 flex-1 overflow-y-auto overscroll-contain/);
    assert.equal(html.includes('<form>'), name === 'Chat' || name === 'Notes');
    if (html.includes('<form>'))
      assert.ok(html.indexOf('<form>') > html.indexOf('Long history</div></div>'));
  }
});
