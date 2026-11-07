import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Conversation, ConversationMessage } from '@ai-agent-manager/core';
import type { ConversationTurnView } from '@/lib/conversations/contracts';
// Test-only: client components call `useRouter`, which requires the App Router context.
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { ConversationHistory } from '@/components/conversations/conversation-history';
import { ConversationList } from '@/components/conversations/conversation-list';
import { ConversationAiNotice } from '@/components/conversations/conversation-notice';
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
import { buildTranscript } from '@/lib/conversations/transcript';
import { activeMainNavKey } from '@/lib/navigation';

// AI Conversations UI (C1 + C2): notes are never presented as AI replies, replies render safe
// Markdown with their runtime and model, every turn state (pending, generating, stopping, failed,
// stopped, interrupted) is visible, and the model selector, navigation and form helpers behave.

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
  contextMode: 'general',
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

const ai = { enabled: true, reason: 'enabled' } as const;
const aiOff = { enabled: false, reason: 'disabled' } as const;

const turn = (overrides: Partial<ConversationTurnView> = {}): ConversationTurnView => ({
  id: id(500),
  status: 'completed',
  active: false,
  userMessageId: id(101),
  assistantMessageId: id(102),
  retryOfTurnId: null,
  agentRuntime: 'claude',
  requestedModelId: 'opus',
  effectiveModelId: 'claude-opus-5-5',
  languageMode: 'pl_technical_en',
  cliVersion: '2.1.317',
  errorCode: null,
  errorMessage: null,
  replyTruncated: false,
  contextMode: 'general',
  contextStage: null,
  repository: null,
  context: { includedMessages: 0, omittedMessages: 0, notesExcluded: 0 },
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_100,
  endedAt: 1_700_000_001_000,
  stopRequestedAt: null,
  ...overrides,
});

const history = (
  messages: ConversationMessage[],
  turns: ConversationTurnView[] = [],
  status: { enabled: boolean; reason: 'enabled' | 'disabled' | 'stale' } = ai,
) =>
  render(
    createElement(ConversationHistory, {
      projectId,
      conversationId: id(1),
      messages,
      turns,
      ai: status,
    }),
  );

test('the history empty state explains that notes are never sent', () => {
  const html = history([]);
  assert.match(html, /No messages yet/);
  assert.match(html, /Notes are never sent to Claude Code or Codex/);
});

test('notes are labelled as notes, escaped, and never shown as AI replies', () => {
  const html = history([
    message({ id: id(101), sequence: 1, content: 'Alpha <script>alert(1)</script>' }),
    message({ id: id(102), sequence: 2, content: 'Beta\n\n- item' }),
  ]);
  assert.ok(html.indexOf('Alpha') < html.indexOf('Beta'));
  assert.match(html, /<ol aria-label="Conversation history"/);
  assert.equal(html.match(/Not sent to an AI/g)?.length, 2);
  assert.doesNotMatch(html, /AI reply/);
  assert.doesNotMatch(html, /<script>/, 'content is escaped');
  assert.match(html, /whitespace-pre-wrap/);
});

test('a completed exchange shows the sent message and a Markdown reply with its model', () => {
  const html = history(
    [
      message({ id: id(101), kind: 'chat', content: 'Plan the API' }),
      message({
        id: id(102),
        sequence: 2,
        role: 'assistant',
        kind: 'chat',
        content:
          '## Plan\n\n1. **Design** `schema`\n\n```ts\nconst x = 1;\n```\n\n<img src=x onerror=alert(1)>',
      }),
    ],
    [turn()],
  );
  assert.match(html, /Sent to AI/);
  assert.match(html, /aria-label="AI reply,/);
  assert.match(
    html,
    /Claude Code · Opus \(latest\) \(opus\) → claude-opus-5-5 · Polish, technical English/,
  );
  assert.match(html, /<h4[^>]*>Plan<\/h4>/);
  assert.match(html, /<strong[^>]*>Design<\/strong>/);
  assert.match(html, /<code class="font-mono">const x = 1;<\/code>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /role="status"/);
});

test('pending, generating, stopping, failed and interrupted turns are shown honestly', () => {
  const sent = [message({ id: id(101), kind: 'chat', content: 'Hello' })];
  const pending = history(sent, [
    turn({ status: 'queued', active: true, assistantMessageId: null, startedAt: null }),
  ]);
  assert.match(pending, /Waiting for the worker…/);
  assert.match(pending, />Stop</);
  assert.doesNotMatch(pending, />Retry</);

  const running = history(sent, [
    turn({ status: 'running', active: true, assistantMessageId: null }),
  ]);
  assert.match(running, /Claude Code is writing a reply…/);
  assert.match(running, />Stop</);

  const stopping = history(sent, [
    turn({ status: 'stopping', active: true, assistantMessageId: null }),
  ]);
  assert.match(stopping, /Stopping…/);
  assert.doesNotMatch(stopping, />Stop</);

  const failed = history(sent, [
    turn({
      status: 'failed',
      assistantMessageId: null,
      errorCode: 'cli_auth_required',
      errorMessage: 'Claude Code is not signed in or its login expired.',
    }),
  ]);
  assert.match(failed, /No reply/);
  assert.match(failed, /not signed in/);
  assert.match(failed, />Retry</);
  assert.doesNotMatch(failed, /aria-label="AI reply/);

  // Retry needs AI replies enabled.
  const failedOff = history(
    sent,
    [turn({ status: 'failed', assistantMessageId: null, errorMessage: 'x' })],
    aiOff,
  );
  assert.doesNotMatch(failedOff, />Retry</);

  const interrupted = history(sent, [
    turn({
      status: 'interrupted',
      assistantMessageId: null,
      errorMessage: 'The worker restarted.',
    }),
  ]);
  assert.match(interrupted, /Interrupted/);
  assert.match(interrupted, />Retry</);
});

test('only the latest unanswered message offers Retry', () => {
  const transcript = buildTranscript(
    [
      message({ id: id(101), kind: 'chat', content: 'First' }),
      message({ id: id(103), sequence: 2, kind: 'note', content: 'Note' }),
    ],
    [turn({ status: 'failed', assistantMessageId: null })],
    ai,
  );
  const sentEntry = transcript[0];
  assert.equal(sentEntry?.kind, 'sent');
  assert.equal(sentEntry?.kind === 'sent' ? sentEntry.state?.canRetry : undefined, false);
});

test('describes notes, sent messages and replies distinctly', () => {
  assert.deepEqual(describeMessageAuthor({ role: 'user', kind: 'note' }), {
    author: 'Note',
    detail: 'Not sent to an AI',
  });
  assert.equal(describeMessageAuthor({ role: 'user', kind: 'chat' }).detail, 'Sent to AI');
  assert.equal(describeMessageAuthor({ role: 'assistant', kind: 'chat' }).author, 'AI reply');
});

test('the list shows title, runtime, model, language and message count, linking to each page', () => {
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
  assert.match(html, /Codex · gpt-example \(custom\) · English/);
  assert.match(html, /2 messages/);
  assert.match(html, /1 message</);
});

test('the notice never claims isolation and points to the separate consent when off', () => {
  const on = render(createElement(ConversationAiNotice, { ai }));
  assert.match(on, /Planning conversation/);
  assert.match(on, /not OS-enforced isolation/);
  assert.match(on, /never create tasks, worktrees, commits or pushes/);
  assert.doesNotMatch(on, /\bsandboxed\b|\bisolated\b|read-only conversation/i);
  const off = render(createElement(ConversationAiNotice, { ai: aiOff }));
  assert.match(off, /AI replies are off/);
  assert.match(off, /href="\/settings"/);
  assert.match(off, /Task execution consent does not enable conversations/);
});

test('the new conversation form defaults to Claude Code, Default model and pl_technical_en', () => {
  const html = render(createElement(ConversationSettingsForm, { projectId }));
  assert.match(html, /Create conversation/);
  assert.match(html, /<option value="claude" selected="">Claude Code<\/option>/);
  assert.match(html, /<option value="codex">Codex<\/option>/);
  assert.match(html, /<option value="" selected="">Default \(recommended\)/);
  assert.match(html, /<option value="opus">Opus \(latest\) · opus<\/option>/);
  assert.doesNotMatch(html, /gpt-6/, 'only the selected runtime’s models are listed');
  assert.match(html, /Custom model ID…/);
  assert.match(html, /<option value="pl_technical_en" selected="">Polish, technical English/);
  assert.match(html, /<option value="pl">Polish<\/option>/);
  assert.match(html, /<option value="en">English<\/option>/);
  assert.match(html, /technical artifacts in English/);
  assert.match(html, new RegExp(`href="/projects/${projectId}/conversations"`));
});

test('the settings form shows stored settings, including a saved custom model ID', () => {
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
  assert.match(html, /<option value="__custom__" selected="">Custom model ID…/);
  assert.match(html, /value="gpt-example"/);
  assert.match(html, /<option value="gpt-6.1-sol">GPT-6.1-Sol · gpt-6.1-sol<\/option>/);
  assert.match(html, /<option value="pl" selected="">/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Save settings/);

  const catalog = render(
    createElement(ConversationSettingsForm, {
      projectId,
      conversation: conversation({ modelId: 'sonnet' }),
    }),
  );
  assert.match(catalog, /<option value="sonnet" selected="">/);
  assert.doesNotMatch(catalog, /aria-label="Custom model ID"/);
});

const composer = (overrides: Partial<Parameters<typeof MessageComposer>[0]> = {}) =>
  render(
    createElement(MessageComposer, {
      projectId,
      conversationId: id(1),
      aiEnabled: true,
      turnActive: false,
      target: 'Claude Code · Default · Polish, technical English',
      ...overrides,
    }),
  );

test('the composer sends to the AI by default and keeps notes clearly separate', () => {
  const html = composer();
  assert.match(html, /<label[^>]*for="([^"]+)"[^>]*>Message to the AI<\/label>/);
  const labelFor = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
  assert.ok(labelFor !== undefined);
  assert.match(html, new RegExp(`<textarea[^>]* id="${labelFor}"`));
  assert.match(html, /role="radio" aria-checked="true"[^>]*>Send to AI/);
  assert.match(html, /Save as note/);
  assert.match(html, /Notes are not sent/);
  assert.match(html, /0 \/ 20,000 characters/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Send/);
});

test('with AI replies off the composer starts in note mode and links to Settings', () => {
  const html = composer({ aiEnabled: false });
  assert.match(html, />New note<\/label>/);
  assert.match(html, /role="radio" aria-checked="true"[^>]*>Save as note/);
  assert.match(html, /never sent to Claude Code or Codex/);
});

test('while a reply is pending the composer is blocked', () => {
  const html = composer({ turnActive: true });
  assert.match(html, /A reply is still pending/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
});

test('form helpers validate, reset the model on a runtime switch and send only changes', () => {
  assert.deepEqual(newConversationFormValues(), {
    title: '',
    agentRuntime: 'claude',
    modelId: '',
    languageMode: 'pl_technical_en',
    contextMode: 'general',
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
    contextMode: 'general',
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
  // C4: the context mode is sent only when it changes.
  assert.deepEqual(buildConversationUpdate(stored, { ...values, contextMode: 'project_aware' }), {
    ok: true,
    update: { revision: 4, contextMode: 'project_aware' },
  });
});

test('main navigation keeps project conversations in the project workspace', () => {
  assert.equal(activeMainNavKey('/'), 'overview');
  assert.equal(activeMainNavKey('/conversations'), 'conversations');
  assert.equal(activeMainNavKey(`/projects/${projectId}/conversations`), 'projects');
  assert.equal(activeMainNavKey(`/projects/${projectId}/conversations/new`), 'projects');
  assert.equal(activeMainNavKey(`/projects/${projectId}/conversations/${id(1)}`), 'projects');
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
    // C3: proposal requests, editing and approval reach tasks only through the database command.
    join(webRoot, 'lib/server/task-proposals.ts'),
    join(webRoot, '../../packages/core/src/task-proposal.ts'),
    join(webRoot, '../../packages/database/src/task-proposal-generations.ts'),
    ...collect(join(webRoot, 'app/api/projects/[projectId]/conversations')),
    ...collect(join(webRoot, 'app/projects/[projectId]/conversations')),
    join(webRoot, 'app/conversations/page.tsx'),
    join(webRoot, 'app/api/settings/conversations/route.ts'),
    ...collect(join(webRoot, 'components/models')),
    ...collect(join(webRoot, 'lib/models')),
    join(webRoot, '../../packages/database/src/conversations.ts'),
    join(webRoot, '../../packages/database/src/conversation-turns.ts'),
    join(webRoot, '../../packages/core/src/conversation.ts'),
    join(webRoot, '../../packages/core/src/conversation-turn.ts'),
    join(webRoot, '../../packages/core/src/conversation-security.ts'),
    join(webRoot, '../../packages/core/src/model-catalog.ts'),
  ];
  assert.ok(files.length >= 30, `found ${files.length} files`);
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
