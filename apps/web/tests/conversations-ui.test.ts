import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Conversation, ConversationMessage } from '@ai-agent-manager/core';
// Test-only: client components call `useRouter`, which requires the App Router context.
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { ConversationHistory } from '@/components/conversations/conversation-history';
import { ConversationList } from '@/components/conversations/conversation-list';
import { NotesOnlyNotice } from '@/components/conversations/conversation-notice';
import { ConversationSettingsForm } from '@/components/conversations/conversation-settings-form';
import { MessageComposer } from '@/components/conversations/message-composer';
import {
  buildConversationUpdate,
  changeConversationRuntime,
  conversationFormValues,
  newConversationFormValues,
  validateConversationForm,
} from '@/lib/conversations/form';
import { describeMessageAuthor } from '@/lib/conversations/format';
import { activeMainNavKey } from '@/lib/navigation';

// C1 — AI Conversations UI: empty states, list, history, settings and composer render honestly
// (notes are never presented as AI replies), and the navigation and form helpers behave.

const projectId = '00000000-0000-4000-8000-00000000000a';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const noop = () => undefined;
const router: AppRouterInstance = {
  bfcacheId: 'test',
  back: noop,
  forward: noop,
  refresh: noop,
  push: noop,
  replace: noop,
  prefetch: noop,
};

const render = (element: ReactElement): string =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: id(1),
  projectId,
  title: 'Auth redesign',
  agentRuntime: 'claude',
  modelId: null,
  languageMode: 'pl_technical_en',
  revision: 1,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  lastMessageAt: null,
  ...overrides,
});

const message = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: id(100),
  conversationId: id(1),
  sequence: 1,
  role: 'user',
  kind: 'note',
  content: 'First note',
  createdAt: 1_700_000_000_000,
  ...overrides,
});

test('the history empty state explains that AI replies arrive in C2', () => {
  const html = render(createElement(ConversationHistory, { messages: [] }));
  assert.match(html, /No notes yet/);
  assert.match(html, /AI replies will be enabled in C2/);
  assert.match(html, /nothing you write here is sent to Claude Code or Codex/);
});

test('the history renders notes in the given order, labelled as notes, never as AI replies', () => {
  const html = render(
    createElement(ConversationHistory, {
      messages: [
        message({ id: id(101), sequence: 1, content: 'Alpha <script>alert(1)</script>' }),
        message({ id: id(102), sequence: 2, content: 'Beta\n\n- item' }),
      ],
    }),
  );
  assert.ok(html.indexOf('Alpha') < html.indexOf('Beta'));
  assert.match(html, /<ol aria-label="Conversation history"/);
  assert.equal(html.match(/Note · not sent to an AI/g)?.length, 2);
  assert.doesNotMatch(html, /Assistant|AI reply/);
  assert.doesNotMatch(html, /<script>/, 'content is escaped');
  assert.match(html, /whitespace-pre-wrap/);
});

test('describes future assistant messages distinctly from notes', () => {
  assert.deepEqual(describeMessageAuthor({ role: 'user', kind: 'note' }), {
    author: 'You',
    detail: 'Note · not sent to an AI',
  });
  assert.equal(describeMessageAuthor({ role: 'assistant', kind: 'chat' }).author, 'Assistant');
});

test('the list shows title, runtime, model, language and note count, linking to each page', () => {
  const html = render(
    createElement(ConversationList, {
      projectId,
      conversations: [
        { ...conversation(), messageCount: 2 },
        {
          ...conversation({
            id: id(2),
            title: 'Test strategy',
            agentRuntime: 'codex',
            modelId: 'gpt-example',
            languageMode: 'en',
          }),
          messageCount: 1,
        },
      ],
    }),
  );
  assert.match(html, new RegExp(`href="/projects/${projectId}/conversations/${id(1)}"`));
  assert.match(html, new RegExp(`href="/projects/${projectId}/conversations/${id(2)}"`));
  assert.match(html, /Claude Code · Default · Polish, technical English/);
  assert.match(html, /Codex · gpt-example · English/);
  assert.match(html, /2 notes/);
  assert.match(html, /1 note</);
});

test('the notice states that nothing is sent and no agent, task or Git operation starts', () => {
  const html = render(createElement(NotesOnlyNotice));
  assert.match(html, /AI replies are not enabled yet/);
  assert.match(html, /no agent, task or Git operation is started/);
});

test('the new conversation form defaults to Claude Code, Default model and pl_technical_en', () => {
  const html = render(createElement(ConversationSettingsForm, { projectId }));
  assert.match(html, /Create conversation/);
  assert.match(html, /<option value="claude" selected="">Claude Code<\/option>/);
  assert.match(html, /<option value="codex">Codex<\/option>/);
  assert.match(html, /placeholder="Default"/);
  assert.match(html, /<option value="pl_technical_en" selected="">Polish, technical English/);
  assert.match(html, /<option value="pl">Polish<\/option>/);
  assert.match(html, /<option value="en">English<\/option>/);
  assert.match(html, /technical artifacts in English/);
  assert.match(html, new RegExp(`href="/projects/${projectId}/conversations"`));
});

test('the settings form shows the stored settings and starts disabled until changed', () => {
  const html = render(
    createElement(ConversationSettingsForm, {
      projectId,
      conversation: conversation({
        agentRuntime: 'codex',
        modelId: 'gpt-example',
        languageMode: 'pl',
      }),
    }),
  );
  assert.match(html, /value="Auth redesign"/);
  assert.match(html, /<option value="codex" selected="">/);
  assert.match(html, /value="gpt-example"/);
  assert.match(html, /<option value="pl" selected="">/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Save settings/);
});

test('the composer saves notes only and explains it, with an accessible label and counter', () => {
  const html = render(createElement(MessageComposer, { projectId, conversationId: id(1) }));
  assert.match(html, /<label[^>]*for="([^"]+)"[^>]*>New note<\/label>/);
  const labelFor = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
  assert.ok(labelFor !== undefined);
  assert.match(html, new RegExp(`<textarea[^>]* id="${labelFor}"`));
  assert.match(html, /It is not sent to Claude Code or Codex, and no reply is generated/);
  assert.match(html, /0 \/ 20,000 characters/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Save note/);
  assert.doesNotMatch(html, />Send</);
});

test('form helpers validate, reset the model on a runtime switch and send only changes', () => {
  assert.deepEqual(newConversationFormValues(), {
    title: '',
    agentRuntime: 'claude',
    modelId: '',
    languageMode: 'pl_technical_en',
  });
  const invalid = validateConversationForm(newConversationFormValues());
  assert.equal(invalid.ok, false);
  assert.ok(!invalid.ok && invalid.fields.title !== undefined);

  const valid = validateConversationForm({ ...newConversationFormValues(), title: ' Plan ' });
  assert.deepEqual(valid.ok && valid.request, {
    title: 'Plan',
    agentRuntime: 'claude',
    modelId: null,
    languageMode: 'pl_technical_en',
  });

  const stored = conversation({ modelId: 'claude-example', revision: 4 });
  const values = conversationFormValues(stored);
  assert.deepEqual(changeConversationRuntime(values, 'codex'), {
    ...values,
    agentRuntime: 'codex',
    modelId: '',
  });
  assert.deepEqual(buildConversationUpdate(stored, values), { ok: true, update: null });
  assert.deepEqual(
    buildConversationUpdate(stored, {
      ...changeConversationRuntime(values, 'codex'),
      languageMode: 'en',
    }),
    { ok: true, update: { revision: 4, agentRuntime: 'codex', modelId: null, languageMode: 'en' } },
  );
});

test('main navigation highlights Conversations for global and project conversation pages', () => {
  assert.equal(activeMainNavKey('/'), 'overview');
  assert.equal(activeMainNavKey('/conversations'), 'conversations');
  assert.equal(activeMainNavKey(`/projects/${projectId}/conversations`), 'conversations');
  assert.equal(activeMainNavKey(`/projects/${projectId}/conversations/new`), 'conversations');
  assert.equal(activeMainNavKey(`/projects/${projectId}/conversations/${id(1)}`), 'conversations');
  assert.equal(activeMainNavKey('/projects'), 'projects');
  assert.equal(activeMainNavKey(`/projects/${projectId}/board`), 'projects');
  assert.equal(activeMainNavKey('/projects/conversations-site'), 'projects');
  assert.equal(activeMainNavKey('/settings'), 'settings');
  assert.equal(activeMainNavKey('/conversationsx'), undefined);
});

test('conversation code has no path to agents, Git, execution, workers or task commands', () => {
  const webRoot = fileURLToPath(new URL('..', import.meta.url));
  const collect = (path: string): string[] =>
    statSync(path).isDirectory()
      ? readdirSync(path).flatMap((entry) => collect(join(path, entry)))
      : /\.tsx?$/.test(path)
        ? [path]
        : [];
  const files = [
    ...collect(join(webRoot, 'components/conversations')),
    ...collect(join(webRoot, 'lib/conversations')),
    join(webRoot, 'lib/server/conversations.ts'),
    ...collect(join(webRoot, 'app/api/projects/[projectId]/conversations')),
    ...collect(join(webRoot, 'app/projects/[projectId]/conversations')),
    join(webRoot, 'app/conversations/page.tsx'),
    join(webRoot, '../../packages/database/src/conversations.ts'),
    join(webRoot, '../../packages/core/src/conversation.ts'),
  ];
  assert.ok(files.length >= 15, `found ${files.length} files`);
  const forbidden = [
    /@ai-agent-manager\/(?:agents|git|orchestrator)/,
    /node:child_process/,
    /lib\/server\/(?:execution|review|publication|recovery|workspace|tasks)/,
    /\b(?:createTask|transitionTask|requestTaskExecution|claimStartCommand|createPublication)\b/,
    /\bworkerCommands\b|\btaskRuns\b/,
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} must not match ${pattern}`);
    }
  }
});
