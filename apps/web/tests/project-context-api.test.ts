import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  conversationDisclosure,
  projectSourceDisclosure,
  trustedLocalDisclosure,
  type Conversation,
  type RepositoryContextRecord,
} from '@ai-agent-manager/core';
import { applyMigrations, createDatabase } from '@ai-agent-manager/database';
// Test-only: client components call `useRouter`, which requires the App Router context.
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PUT as sourceAccessRoute } from '@/app/api/projects/[projectId]/conversation-source-access/route';
import { PUT as executionTrustRoute } from '@/app/api/projects/[projectId]/execution-trust/route';
import {
  GET as getRoute,
  PATCH as patchRoute,
} from '@/app/api/projects/[projectId]/conversations/[conversationId]/route';
import { POST as sendRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/turns/route';
import { POST as createRoute } from '@/app/api/projects/[projectId]/conversations/route';
import { POST as registerRoute } from '@/app/api/projects/route';
import { PUT as conversationSettingsRoute } from '@/app/api/settings/conversations/route';
import { PUT as trustedLocalRoute } from '@/app/api/settings/trusted-local/route';
import { ConversationSettingsForm } from '@/components/conversations/conversation-settings-form';
import { ProjectSourceAccessCard } from '@/components/conversations/project-source-access-card';
import { ReplySources } from '@/components/conversations/reply-sources';
import {
  conversationDetailResponseSchema,
  conversationResponseSchema,
  projectSourceAccessResponseSchema,
  sendConversationMessageResponseSchema,
  type ConversationTurnView,
} from '@/lib/conversations/contracts';
import { buildSourcesView, describeTurnStage } from '@/lib/conversations/sources';
import { describeReplyMeta, describeTurnState } from '@/lib/conversations/transcript';
import { apiErrorResponseSchema, projectResponseSchema } from '@/lib/projects/contracts';
import { closeDatabase } from '@/lib/server/database';
import {
  createFixtureDirectory,
  createRepository,
  removeFixtureDirectory,
  snapshot,
} from './fixtures';

// C4 — web side of project-aware conversations: the context mode setting, the separate
// source-sharing permission (bound to the repository identity, independent of AI Conversations
// consent and execution trust), send refusals, and the presentation of stages and sources.

const origin = 'http://127.0.0.1:3000';
const databaseVariable = 'AI_AGENT_MANAGER_DATABASE_PATH';

let directory = '';
let previousDatabasePath: string | undefined;

before(() => {
  directory = createFixtureDirectory();
  previousDatabasePath = process.env[databaseVariable];
  process.env[databaseVariable] = join(directory, 'data', 'database.sqlite');
  const connection = createDatabase({ path: process.env[databaseVariable] });
  try {
    applyMigrations(connection);
  } finally {
    connection.close();
  }
});

after(() => {
  closeDatabase();
  if (previousDatabasePath === undefined) {
    delete process.env[databaseVariable];
  } else {
    process.env[databaseVariable] = previousDatabasePath;
  }
  removeFixtureDirectory(directory);
});

const send = (method: 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Request =>
  new Request(`${origin}${path}`, {
    method,
    headers: {
      host: '127.0.0.1:3000',
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const errorOf = async (response: Response) =>
  apiErrorResponseSchema.parse(await response.json()).error;

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let counter = 0;
const setUp = async (
  body: Record<string, unknown> = {},
): Promise<{ root: string; projectId: string; conversation: Conversation }> => {
  counter += 1;
  const name = `context-${counter}`;
  const root = createRepository(join(directory, name));
  const registered = await registerRoute(
    send('POST', '/api/projects', {
      path: root,
      name,
      defaultBaseBranch: 'main',
      remoteName: null,
    }),
  );
  assert.equal(registered.status, 201);
  const projectId = projectResponseSchema.parse(await registered.json()).project.id;
  const created = await createRoute(
    send('POST', `/api/projects/${projectId}/conversations`, { title: 'Plan', ...body }),
    params({ projectId }),
  );
  assert.equal(created.status, 201);
  return {
    root,
    projectId,
    conversation: conversationResponseSchema.parse(await created.json()).conversation,
  };
};

const detail = async (projectId: string, conversationId: string) => {
  const response = await getRoute(
    new Request(`${origin}/api/projects/${projectId}/conversations/${conversationId}`, {
      headers: { host: '127.0.0.1:3000' },
    }),
    params({ projectId, conversationId }),
  );
  assert.equal(response.status, 200);
  return conversationDetailResponseSchema.parse(await response.json());
};

const enableAi = async () => {
  const response = await conversationSettingsRoute(
    send('PUT', '/api/settings/conversations', {
      enabled: true,
      disclosureVersion: conversationDisclosure.version,
    }),
  );
  assert.equal(response.status, 200);
};

const setSourceAccess = (projectId: string, body: unknown) =>
  sourceAccessRoute(
    send('PUT', `/api/projects/${projectId}/conversation-source-access`, body),
    params({ projectId }),
  );

const sendMessage = (projectId: string, conversationId: string, content = 'How does it work?') =>
  sendRoute(
    send('POST', `/api/projects/${projectId}/conversations/${conversationId}/turns`, {
      requestId: randomUUID(),
      content,
    }),
    params({ projectId, conversationId }),
  );

test('new conversations choose a context mode explicitly; General Chat is the default', async () => {
  const general = await setUp();
  assert.equal(general.conversation.contextMode, 'general');
  const aware = await setUp({ contextMode: 'project_aware' });
  assert.equal(aware.conversation.contextMode, 'project_aware');
  const invalid = await createRoute(
    send('POST', `/api/projects/${general.projectId}/conversations`, {
      title: 'X',
      contextMode: 'everything',
    }),
    params({ projectId: general.projectId }),
  );
  assert.equal(invalid.status, 400);
  const switched = await patchRoute(
    send('PATCH', `/api/projects/${general.projectId}/conversations/${general.conversation.id}`, {
      revision: general.conversation.revision,
      contextMode: 'project_aware',
    }),
    params({ projectId: general.projectId, conversationId: general.conversation.id }),
  );
  assert.equal(switched.status, 200);
  assert.equal(
    conversationResponseSchema.parse(await switched.json()).conversation.contextMode,
    'project_aware',
  );
});

test('Project-Aware sends need the project’s own source-sharing permission', async () => {
  const { root, projectId, conversation } = await setUp({ contextMode: 'project_aware' });
  await enableAi();
  // Trusted Local execution consent and project execution trust do not grant source sharing.
  await trustedLocalRoute(
    send('PUT', '/api/settings/trusted-local', {
      enabled: true,
      disclosureVersion: trustedLocalDisclosure.version,
      acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
    }),
  );
  const view = await detail(projectId, conversation.id);
  assert.equal(view.sourceAccess.current, false);
  assert.equal(view.sourceAccess.reason, 'not_allowed');
  const trust = await executionTrustRoute(
    send('PUT', `/api/projects/${projectId}/execution-trust`, {
      trust: 'trusted_local',
      localPath: view.sourceAccess.localPath,
      gitCommonDir: view.sourceAccess.gitCommonDir,
    }),
    params({ projectId }),
  );
  assert.equal(trust.status, 200);
  const refused = await sendMessage(projectId, conversation.id);
  assert.equal(refused.status, 409);
  assert.equal((await errorOf(refused)).code, 'conversation_source_access_required');

  // A grant must name the registered repository and the current disclosure.
  const wrongRepository = await setSourceAccess(projectId, {
    access: 'allowed',
    gitCommonDir: '/elsewhere/.git',
    disclosureVersion: projectSourceDisclosure.version,
  });
  assert.equal(wrongRepository.status, 409);
  const staleDisclosure = await setSourceAccess(projectId, {
    access: 'allowed',
    gitCommonDir: view.sourceAccess.gitCommonDir,
    disclosureVersion: 'older',
  });
  assert.equal(staleDisclosure.status, 409);
  const invalid = await setSourceAccess(projectId, { access: 'everything' });
  assert.equal(invalid.status, 400);

  const before = snapshot(root);
  const allowed = await setSourceAccess(projectId, {
    access: 'allowed',
    gitCommonDir: view.sourceAccess.gitCommonDir,
    disclosureVersion: projectSourceDisclosure.version,
  });
  assert.equal(allowed.status, 200);
  assert.equal(
    projectSourceAccessResponseSchema.parse(await allowed.json()).sourceAccess.current,
    true,
  );
  // Granting only inspects the repository read-only.
  assert.deepEqual(snapshot(root), before);

  const accepted = await sendMessage(projectId, conversation.id);
  assert.equal(accepted.status, 202);
  const { turn } = sendConversationMessageResponseSchema.parse(await accepted.json());
  assert.equal(turn.contextMode, 'project_aware');
  assert.equal(turn.repository, null);

  const withdrawn = await setSourceAccess(projectId, { access: 'none' });
  assert.equal(withdrawn.status, 200);
  assert.equal((await detail(projectId, conversation.id)).sourceAccess.current, false);
});

test('source sharing of one project never applies to another, and General Chat needs none', async () => {
  const first = await setUp({ contextMode: 'project_aware' });
  const second = await setUp({ contextMode: 'project_aware' });
  const general = await setUp();
  await enableAi();
  const view = await detail(first.projectId, first.conversation.id);
  const allowed = await setSourceAccess(first.projectId, {
    access: 'allowed',
    gitCommonDir: view.sourceAccess.gitCommonDir,
    disclosureVersion: projectSourceDisclosure.version,
  });
  assert.equal(allowed.status, 200);
  const crossProject = await setSourceAccess(second.projectId, {
    access: 'allowed',
    gitCommonDir: view.sourceAccess.gitCommonDir,
    disclosureVersion: projectSourceDisclosure.version,
  });
  assert.equal(crossProject.status, 409);
  assert.equal((await sendMessage(second.projectId, second.conversation.id)).status, 409);
  assert.equal((await sendMessage(general.projectId, general.conversation.id)).status, 202);
  const unknown = await setSourceAccess('00000000-0000-4000-8000-00000000ffff', { access: 'none' });
  assert.equal(unknown.status, 404);
});

test('grants are refused cross-origin and when the repository is gone', async () => {
  const { projectId, conversation, root } = await setUp({ contextMode: 'project_aware' });
  const view = await detail(projectId, conversation.id);
  const crossSite = await sourceAccessRoute(
    new Request(`${origin}/api/projects/${projectId}/conversation-source-access`, {
      method: 'PUT',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ access: 'none' }),
    }),
    params({ projectId }),
  );
  assert.equal(crossSite.status, 403);
  const { renameSync } = await import('node:fs');
  renameSync(root, `${root}-moved`);
  try {
    const missing = await setSourceAccess(projectId, {
      access: 'allowed',
      gitCommonDir: view.sourceAccess.gitCommonDir,
      disclosureVersion: projectSourceDisclosure.version,
    });
    assert.equal(missing.status, 409);
    assert.match((await errorOf(missing)).message, /not available/);
  } finally {
    renameSync(`${root}-moved`, root);
  }
});

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

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

const record = (overrides: Partial<RepositoryContextRecord> = {}): RepositoryContextRecord => ({
  version: 1,
  commit: 'c'.repeat(40),
  branch: 'main',
  previousCommit: 'b'.repeat(40),
  selection: 'model',
  selectionNote: 'Worker files.',
  catalog: {
    trackedFiles: 10,
    eligibleFiles: 8,
    excludedFiles: 2,
    listedFiles: 8,
    treeTruncated: false,
  },
  searches: [{ term: 'runQueuedTask', matchedFiles: 2, truncated: false }],
  sources: [
    {
      path: 'src/worker.ts',
      startLine: 1,
      endLine: 40,
      totalLines: 40,
      characters: 900,
      origin: 'requested',
      documentation: false,
      partial: false,
    },
    {
      path: 'src/queue.ts',
      startLine: 10,
      endLine: 30,
      totalLines: 200,
      characters: 400,
      origin: 'search',
      documentation: false,
      partial: true,
    },
  ],
  rejected: [{ path: '.env', reason: 'possibly sensitive (credentials, keys, environment files)' }],
  omitted: [],
  ignoredRequests: [],
  characters: 1_300,
  limited: true,
  unverifiedReferences: ['src/scheduler.ts'],
  ...overrides,
});

test('the Sources view lists only supplied excerpts with limits, refusals and freshness', () => {
  const view = buildSourcesView(record());
  assert.deepEqual(
    view.items.map((item) => item.reference),
    ['src/worker.ts', 'src/queue.ts:10-30'],
  );
  assert.equal(view.commitShort, 'cccccccc');
  assert.equal(view.incomplete, true);
  const notes = view.notes.join('\n');
  assert.match(notes, /Refused: \.env/);
  assert.match(notes, /repository changed since the previous project-aware reply/);
  assert.match(notes, /not supplied to the AI: src\/scheduler\.ts/);
  assert.match(notes, /context was limited/);
  const empty = buildSourcesView(
    record({
      sources: [],
      selection: 'fallback',
      selectionNote: 'Not JSON.',
      limited: false,
      previousCommit: null,
      unverifiedReferences: [],
      rejected: [],
    }),
  );
  assert.match(empty.notes.join('\n'), /No repository content was supplied/);
  assert.match(empty.notes.join('\n'), /keyword search: Not JSON\./);

  const html = render(createElement(ReplySources, { record: record() }));
  assert.match(html, /<details/);
  assert.match(html, /Sources \(2 excerpts\)/);
  assert.match(html, /src\/queue\.ts:10-30/);
  assert.match(html, /Limited context/);
  assert.match(html, /uncommitted changes were not included/);
});

const turn = (overrides: Partial<ConversationTurnView>): ConversationTurnView => ({
  id: 't',
  status: 'running',
  active: true,
  userMessageId: 'u',
  assistantMessageId: null,
  retryOfTurnId: null,
  agentRuntime: 'codex',
  requestedModelId: null,
  effectiveModelId: null,
  languageMode: 'en',
  cliVersion: null,
  errorCode: null,
  errorMessage: null,
  replyTruncated: false,
  contextMode: 'project_aware',
  contextStage: 'selecting_files',
  repository: null,
  context: null,
  createdAt: 1,
  startedAt: 2,
  endedAt: null,
  stopRequestedAt: null,
  ...overrides,
});

test('running project-aware turns show their stage; replies are labelled Project-Aware', () => {
  assert.equal(describeTurnStage('reading_files', 'Codex'), 'Reading repository files…');
  const state = describeTurnState(turn({}), { retryable: false, aiEnabled: true });
  assert.equal(state?.title, 'Codex is choosing relevant files…');
  assert.match(state?.description ?? '', /repository excerpts are sent/);
  assert.equal(state?.canStop, true);
  const general = describeTurnState(turn({ contextMode: 'general', contextStage: null }), {
    retryable: false,
    aiEnabled: true,
  });
  assert.equal(general?.title, 'Codex is writing a reply…');
  assert.match(describeReplyMeta(turn({ status: 'completed' })), /Project-Aware$/);
  assert.doesNotMatch(
    describeReplyMeta(turn({ status: 'completed', contextMode: 'general' })),
    /Project-Aware/,
  );
});

test('settings show the context choice; the source-sharing card states what is shared', () => {
  const form = render(createElement(ConversationSettingsForm, { projectId: 'p' }));
  assert.match(form, /<legend[^>]*>Context<\/legend>/);
  assert.match(form, /<input type="radio"[^>]*checked=""[^>]*value="general"\/>/);
  assert.match(form, /value="project_aware"/);
  assert.match(form, /General Chat/);
  assert.match(form, /Project-Aware/);

  const sourceAccess = {
    current: false,
    access: 'none' as const,
    reason: 'not_allowed' as const,
    allowedAt: null,
    localPath: '/repos/app',
    gitCommonDir: '/repos/app/.git',
    disclosure: {
      version: projectSourceDisclosure.version,
      title: projectSourceDisclosure.title,
      statements: [...projectSourceDisclosure.statements],
    },
  };
  const card = render(
    createElement(ProjectSourceAccessCard, { projectId: 'p', projectName: 'App', sourceAccess }),
  );
  assert.match(card, /Not allowed/);
  assert.match(card, /Allow source sharing/);
  assert.match(card, /disabled=""/);
  assert.match(
    card,
    /Uncommitted edits, untracked files, task worktrees and Git metadata are never read/,
  );
  assert.doesNotMatch(card, /sandbox(ed)?|isolated|read-only mode/i);
  const allowed = render(
    createElement(ProjectSourceAccessCard, {
      projectId: 'p',
      projectName: 'App',
      sourceAccess: {
        ...sourceAccess,
        current: true,
        access: 'allowed',
        reason: 'allowed',
        allowedAt: 1,
      },
    }),
  );
  assert.match(allowed, /Stop sharing source/);
});

test('web conversation code reaches Git only through the read-only source-context entry point', () => {
  const webRoot = fileURLToPath(new URL('..', import.meta.url));
  const access = readFileSync(join(webRoot, 'lib/server/project-source-access.ts'), 'utf8');
  assert.match(access, /from '@ai-agent-manager\/git\/source-context'/);
  assert.doesNotMatch(access, /from '@ai-agent-manager\/git'|node:child_process|node:fs/);
  for (const file of [
    'lib/server/conversations.ts',
    'lib/conversations/sources.ts',
    'components/conversations/reply-sources.tsx',
    'components/conversations/project-source-access-card.tsx',
    'app/api/projects/[projectId]/conversation-source-access/route.ts',
  ]) {
    assert.doesNotMatch(
      readFileSync(join(webRoot, file), 'utf8'),
      /@ai-agent-manager\/(?:git|agents|orchestrator)['/]|node:child_process/,
      file,
    );
  }
});
