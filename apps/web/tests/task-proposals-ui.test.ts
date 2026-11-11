import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Test-only: client components call `useRouter`, which requires the App Router context.
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import type { ConversationMessage } from '@ai-agent-manager/core';
import { ConversationHistory } from '@/components/conversations/conversation-history';
import { TaskProposalsPanel } from '@/components/conversations/task-proposals-panel';
import type {
  ConversationAiStatus,
  ConversationTurnView,
  TaskProposalGenerationView,
  TaskProposalView,
} from '@/lib/conversations/contracts';
import {
  buildProposalUpdate,
  changeProposalRuntime,
  countProposals,
  describeGenerationState,
  proposalFormValues,
} from '@/lib/conversations/proposals';

// C3 UI: the proposal panel renders its empty, loading, error, draft, approved and rejected states
// honestly, keeps AI suggestions apart from operator values, and the editor sends only changes.

const projectId = '00000000-0000-4000-8000-00000000000a';
const conversationId = '00000000-0000-4000-8000-000000000101';
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

const enabled: ConversationAiStatus = { enabled: true, reason: 'enabled' };

const generation = (
  overrides: Partial<TaskProposalGenerationView> = {},
): TaskProposalGenerationView => ({
  id: id(1),
  status: 'completed',
  active: false,
  retryOfGenerationId: null,
  agentRuntime: 'claude',
  requestedModelId: null,
  effectiveModelId: null,
  languageMode: 'pl_technical_en',
  instructions: '',
  sourceMessageId: id(302),
  basedOnSequence: 2,
  cliVersion: '2.1.317',
  errorCode: null,
  errorMessage: null,
  proposalCount: 1,
  skippedCount: 0,
  note: null,
  context: null,
  createdAt: 1,
  startedAt: 2,
  endedAt: 3,
  stopRequestedAt: null,
  ...overrides,
});

const proposal = (overrides: Partial<TaskProposalView> = {}): TaskProposalView => ({
  id: id(10),
  projectId,
  conversationId,
  generationId: id(1),
  position: 1,
  status: 'draft',
  title: 'Add login rate limiting',
  prompt: 'Implement rate limiting for POST /login.',
  agentRuntime: 'claude',
  modelId: null,
  priority: 'high',
  baseBranch: null,
  suggested: {
    title: 'Add login rate limiting',
    prompt: 'Implement rate limiting for POST /login.',
    priority: 'high',
    agentRuntime: 'claude',
    modelId: null,
  },
  edited: false,
  rationale: 'Ochrona przed brute force.',
  dependencies: '',
  revision: 1,
  taskId: null,
  createdAt: 3,
  updatedAt: 3,
  approvedAt: null,
  rejectedAt: null,
  ...overrides,
});

const panel = (props: Partial<Parameters<typeof TaskProposalsPanel>[0]> = {}): string =>
  render(
    createElement(TaskProposalsPanel, {
      projectId,
      conversationId,
      defaultBaseBranch: 'main',
      branches: ['main', 'develop'],
      generations: [],
      proposals: [],
      ...props,
    }),
  );

// A transcript: user message (301), completed reply (302), user message (303) whose turn failed,
// and a note (304).
const messages: ConversationMessage[] = [
  {
    id: id(301),
    conversationId,
    sequence: 1,
    role: 'user',
    kind: 'chat',
    content: 'How?',
    createdAt: 1,
  },
  {
    id: id(302),
    conversationId,
    sequence: 2,
    role: 'assistant',
    kind: 'chat',
    content: 'Plan: A then B.',
    createdAt: 2,
  },
  {
    id: id(303),
    conversationId,
    sequence: 3,
    role: 'user',
    kind: 'chat',
    content: 'And tests?',
    createdAt: 3,
  },
  {
    id: id(304),
    conversationId,
    sequence: 4,
    role: 'user',
    kind: 'note',
    content: 'My note',
    createdAt: 4,
  },
];

const turn = (overrides: Partial<ConversationTurnView>): ConversationTurnView => ({
  id: id(501),
  status: 'completed',
  active: false,
  userMessageId: id(301),
  assistantMessageId: id(302),
  retryOfTurnId: null,
  agentRuntime: 'claude',
  requestedModelId: null,
  effectiveModelId: null,
  languageMode: 'pl_technical_en',
  cliVersion: '2.1.317',
  errorCode: null,
  errorMessage: null,
  replyTruncated: false,
  contextMode: 'general',
  contextStage: null,
  repository: null,
  context: null,
  createdAt: 1,
  startedAt: 1,
  endedAt: 2,
  stopRequestedAt: null,
  ...overrides,
});

const turns: ConversationTurnView[] = [
  turn({}),
  turn({
    id: id(502),
    status: 'failed',
    userMessageId: id(303),
    assistantMessageId: null,
    errorMessage: 'Claude Code failed.',
  }),
];

const transcript = (
  generations: TaskProposalGenerationView[] = [],
  ai: ConversationAiStatus = enabled,
  turnList: ConversationTurnView[] = turns,
): string =>
  render(
    createElement(ConversationHistory, {
      projectId,
      conversationId,
      messages,
      turns: turnList,
      ai,
      generations,
    }),
  );

test('C3.1: Generate tasks appears only under completed AI replies', () => {
  const html = transcript();
  assert.equal(html.match(/Generate tasks</g)?.length, 1);
  // It sits in the reply's list item, which is the navigation target for its proposals.
  const item = html.slice(html.indexOf(`id="message-${id(302)}"`));
  assert.ok(item.indexOf('Generate tasks') < item.indexOf('</article>'));
  assert.match(html, /aria-label="Generate tasks from this reply"/);
  assert.match(html, />Focus</);
  // User messages now have stable reference anchors, but no Generate tasks action.
  const userItem = html.slice(
    html.indexOf(`id="message-${id(301)}"`),
    html.indexOf(`id="message-${id(302)}"`),
  );
  assert.match(userItem, />Reference</);
  assert.doesNotMatch(userItem, /Generate tasks/);
  assert.doesNotMatch(html, new RegExp(`id="message-${id(304)}"`));
});

test('C3.1: the action is blocked with a reason while AI is off or another request runs', () => {
  assert.match(transcript([], { enabled: false, reason: 'disabled' }), /AI Conversations are off/);
  assert.match(
    transcript([generation({ status: 'running', active: true, endedAt: null })]),
    /Task proposals are being generated/,
  );
  const pendingReply = transcript([], enabled, [
    turns[0] as ConversationTurnView,
    turn({
      id: id(503),
      status: 'running',
      active: true,
      userMessageId: id(303),
      assistantMessageId: null,
    }),
  ]);
  assert.match(pendingReply, /A reply is still pending/);
  assert.match(pendingReply, /<button[^>]*disabled=""[^>]*title="A reply is still pending/);
});

test('C3.1: the request state is shown under its source reply, with Stop, Retry and a link', () => {
  const queued = transcript([
    generation({
      status: 'queued',
      active: true,
      startedAt: null,
      endedAt: null,
      proposalCount: 0,
    }),
  ]);
  assert.match(queued, /Waiting for the worker/);
  assert.match(queued, />Stop</);
  const failed = transcript([
    generation({
      status: 'failed',
      errorCode: 'malformed_output',
      errorMessage: 'The reply was not a single JSON proposal document.',
      proposalCount: 0,
    }),
  ]);
  assert.match(failed, /Proposals could not be generated/);
  assert.match(failed, />Retry</);
  const done = transcript([generation({ id: id(1), proposalCount: 2 })]);
  assert.match(done, /2 proposals generated/);
  assert.match(done, new RegExp(`href="#proposals-${id(1)}"`));
  assert.match(done, /View proposals/);
  assert.match(done, /Generate tasks again/);
  // A request made from another reply is not shown here.
  assert.doesNotMatch(
    transcript([generation({ sourceMessageId: id(999) })]),
    /proposals generated/,
  );
});

test('empty state: proposals appear only when asked for from a reply', () => {
  const html = panel();
  assert.match(
    html,
    /No task proposals yet\. They appear here only when you ask for them from an AI reply\./,
  );
  assert.match(html, /under an AI reply/);
  assert.doesNotMatch(html, /Approve to Backlog/);
  // The separate bottom generation form is gone.
  assert.doesNotMatch(html, /Generate task proposals/);
});

test('C3.1: batches name and link their source reply; C3 batches say they used the conversation', () => {
  const html = panel({
    generations: [
      generation({ id: id(1), sourceMessageId: null, note: null }),
      generation({ id: id(2), instructions: 'Only backend', note: 'Two tasks.' }),
    ],
    proposals: [
      proposal({ id: id(10), generationId: id(1) }),
      proposal({ id: id(11), generationId: id(2), title: 'From the reply' }),
    ],
  });
  assert.match(html, new RegExp(`id="proposals-${id(1)}"`));
  assert.match(html, new RegExp(`id="proposals-${id(2)}"`));
  assert.match(html, /from the whole conversation \(before C3\.1\)/);
  assert.match(html, /from one AI reply/);
  assert.match(html, /Focus: <span[^>]*>Only backend/);
  assert.match(html, /AI note: Two tasks\./);
  // Batch header and card both link back to the source reply.
  assert.equal(html.match(new RegExp(`href="#message-${id(302)}"`, 'g'))?.length, 2);
  assert.match(html, /Show source reply/);
  assert.match(html, />Source reply</);
  assert.ok(html.indexOf(`proposals-${id(1)}`) < html.indexOf(`proposals-${id(2)}`));
});

test('a draft card shows the AI suggestion and explicit Approve, Reject and Edit actions', () => {
  const html = panel({ generations: [generation()], proposals: [proposal()] });
  assert.match(html, />Draft</);
  assert.match(html, /AI suggestion/);
  assert.match(html, /Add login rate limiting/);
  assert.match(html, /High priority/);
  assert.match(html, /project default \(main\)/);
  assert.match(html, /Ochrona przed brute force\./);
  assert.match(html, /Approve to Backlog/);
  assert.match(html, />Reject</);
  assert.match(html, />Edit</);
  assert.match(html, /creates one task in Backlog\. It is not queued or started\./);
  assert.match(html, /1 draft · 0 approved · 0 rejected/);
});

test('an edited draft says so and keeps the original suggestion visible', () => {
  const html = panel({
    generations: [generation()],
    proposals: [
      proposal({
        title: 'Rate limit login',
        agentRuntime: 'codex',
        modelId: 'gpt-6.1-sol',
        baseBranch: 'develop',
        edited: true,
      }),
    ],
  });
  assert.match(html, /Edited by you/);
  assert.match(html, /Show the AI&#x27;s original suggestion/);
  assert.match(html, /Codex · /);
  assert.match(html, /base develop/);
});

test('approved proposals link to their task and cannot be acted on again', () => {
  const html = panel({
    generations: [generation()],
    proposals: [proposal({ status: 'approved', taskId: id(99), approvedAt: 5, revision: 2 })],
  });
  assert.match(html, />Approved</);
  assert.match(html, new RegExp(`href="/projects/${projectId}/tasks/${id(99)}"`));
  assert.match(html, /The task is in Backlog and was not queued\./);
  assert.doesNotMatch(html, /Approve to Backlog/);
  assert.doesNotMatch(html, />Reject</);
  assert.doesNotMatch(html, />Edit</);
});

test('rejected proposals can only be reopened', () => {
  const html = panel({
    generations: [generation()],
    proposals: [proposal({ status: 'rejected', rejectedAt: 5, revision: 2 })],
  });
  assert.match(html, />Rejected</);
  assert.match(html, />Reopen</);
  assert.doesNotMatch(html, /Approve to Backlog/);
});

test('Tasks preserves failed, empty and pending generation history without cards', () => {
  const html = panel({
    aiEnabled: true,
    generations: [
      generation({
        id: id(1),
        status: 'failed',
        errorMessage: 'Invalid proposal output.',
        proposalCount: 0,
      }),
      generation({
        id: id(2),
        status: 'completed',
        proposalCount: 0,
        note: 'No actionable tasks.',
      }),
      generation({ id: id(3), status: 'queued', active: true, startedAt: null, proposalCount: 0 }),
    ],
  });
  assert.match(html, /Invalid proposal output/);
  assert.match(html, /No actionable tasks/);
  assert.match(html, /Waiting for the worker/);
  assert.match(html, />Stop</);
  assert.doesNotMatch(html, />Retry</, 'busy conversations cannot retry a failed generation');
  assert.doesNotMatch(html, /No task proposals yet/);
  for (const n of [1, 2, 3]) assert.match(html, new RegExp(`id="proposals-${id(n)}"`));
});

test('Tasks offers Retry only for the latest failed request per reply and never for C3 legacy', () => {
  const failed = generation({ status: 'failed', proposalCount: 0 });
  const html = panel({
    aiEnabled: true,
    generations: [
      { ...failed, id: id(1) },
      { ...failed, id: id(2) },
      { ...failed, id: id(3), sourceMessageId: null },
    ],
  });
  assert.equal(html.match(/>Retry</g)?.length, 1);
  assert.doesNotMatch(panel({ aiEnabled: false, generations: [failed] }), />Retry</);
  assert.doesNotMatch(
    panel({ aiEnabled: true, turnActive: true, generations: [failed] }),
    />Retry</,
  );
});

test('generation states describe every lifecycle status', () => {
  const statuses = [
    ['queued', 'pending', true, false],
    ['running', 'running', true, false],
    ['stopping', 'stopping', false, false],
    ['completed', 'completed', false, false],
    ['failed', 'failed', false, true],
    ['cancelled', 'stopped', false, true],
    ['interrupted', 'interrupted', false, true],
  ] as const;
  for (const [status, tone, canStop, canRetry] of statuses) {
    const state = describeGenerationState(generation({ status }), {
      latest: true,
      aiEnabled: true,
    });
    assert.deepEqual(
      [state.tone, state.canStop, state.canRetry],
      [tone, canStop, canRetry],
      status,
    );
  }
  assert.equal(
    describeGenerationState(generation({ status: 'failed' }), { latest: true, aiEnabled: false })
      .canRetry,
    false,
  );
  assert.match(
    describeGenerationState(generation({ skippedCount: 2 }), { latest: true, aiEnabled: true })
      .description ?? '',
    /2 items did not match/,
  );
});

test('the editor sends only changed fields with the revision and validates like the server', () => {
  const current = proposal({ modelId: 'opus', revision: 3 });
  const values = proposalFormValues(current);
  assert.deepEqual(buildProposalUpdate(current, values), { ok: true, update: null });
  assert.deepEqual(
    buildProposalUpdate(current, { ...values, title: 'New', baseBranch: 'develop' }),
    {
      ok: true,
      update: { revision: 3, title: 'New', baseBranch: 'develop' },
    },
  );
  const switched = changeProposalRuntime(values, 'codex');
  assert.equal(switched.modelId, '');
  assert.deepEqual(buildProposalUpdate(current, switched), {
    ok: true,
    update: { revision: 3, agentRuntime: 'codex', modelId: null },
  });
  const wrongModel = buildProposalUpdate(current, { ...values, modelId: 'gpt-6.1-sol' });
  assert.equal(wrongModel.ok, false);
  assert.ok(!wrongModel.ok && wrongModel.fields.modelId !== undefined);
  const emptyTitle = buildProposalUpdate(current, { ...values, title: '  ' });
  assert.ok(!emptyTitle.ok && emptyTitle.fields.title !== undefined);
  assert.deepEqual(
    countProposals([
      proposal(),
      proposal({ status: 'approved' }),
      proposal({ status: 'rejected' }),
      proposal(),
    ]),
    { draft: 2, approved: 1, rejected: 1 },
  );
});

test('UI-04C: long proposal prompts have a bounded preview and deliberate expansion', () => {
  const prompt = 'Implement one focused part. '.repeat(200) + 'PRIVATE-END-MARKER';
  const html = panel({ generations: [generation()], proposals: [proposal({ prompt })] });
  assert.match(html, /Expand prompt/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /PRIVATE-END-MARKER/);
  assert.match(html, /Approve to Backlog/);
  assert.match(html, />Edit</);
});
