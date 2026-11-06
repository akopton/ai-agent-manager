import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { conversationMessageMaxLength, type Conversation } from '@ai-agent-manager/core';
import { applyMigrations, createDatabase } from '@ai-agent-manager/database';
import { POST as messageRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/messages/route';
import {
  GET as getRoute,
  PATCH as updateRoute,
} from '@/app/api/projects/[projectId]/conversations/[conversationId]/route';
import {
  GET as listRoute,
  POST as createRoute,
} from '@/app/api/projects/[projectId]/conversations/route';
import { DELETE as disconnectRoute } from '@/app/api/projects/[projectId]/route';
import { POST as registerRoute } from '@/app/api/projects/route';
import {
  conversationDetailResponseSchema,
  conversationListResponseSchema,
  conversationMessageResponseSchema,
  conversationResponseSchema,
} from '@/lib/conversations/contracts';
import { apiErrorResponseSchema, projectResponseSchema } from '@/lib/projects/contracts';
import { closeDatabase } from '@/lib/server/database';
import {
  createFixtureDirectory,
  createRepository,
  git,
  removeFixtureDirectory,
  snapshot,
} from './fixtures';

// C1 — AI Conversations API: project scoping, validation, deduplication, stale updates and the
// guarantee that conversation requests never touch tasks, the worker queue, runs or Git.

const origin = 'http://127.0.0.1:3000';
const databaseVariable = 'AI_AGENT_MANAGER_DATABASE_PATH';
const unknownId = '00000000-0000-4000-8000-00000000ffff';

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

const defaultHeaders = { host: '127.0.0.1:3000', origin };

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${origin}${path}`, { headers: { host: '127.0.0.1:3000', ...headers } });

const send = (
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`${origin}${path}`, {
    method,
    headers: {
      ...defaultHeaders,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

const projectParams = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

const conversationParams = (projectId: string, conversationId: string) => ({
  params: Promise.resolve({ projectId, conversationId }),
});

const errorOf = async (response: Response) =>
  apiErrorResponseSchema.parse(await response.json()).error;

let projectCounter = 0;

const registerProject = async () => {
  projectCounter += 1;
  const name = `conversations-${projectCounter}`;
  const root = createRepository(join(directory, name));
  git(root, 'branch', 'develop');
  const response = await registerRoute(
    send('POST', '/api/projects', {
      path: root,
      name,
      defaultBaseBranch: 'main',
      remoteName: null,
    }),
  );
  assert.equal(response.status, 201);
  return { root, project: projectResponseSchema.parse(await response.json()).project };
};

const createConversation = async (
  projectId: string,
  body: Record<string, unknown> = {},
): Promise<Conversation> => {
  const response = await createRoute(
    send('POST', `/api/projects/${projectId}/conversations`, { title: 'Auth redesign', ...body }),
    projectParams(projectId),
  );
  assert.equal(response.status, 201);
  return conversationResponseSchema.parse(await response.json()).conversation;
};

const postNote = (
  projectId: string,
  conversationId: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  messageRoute(
    send(
      'POST',
      `/api/projects/${projectId}/conversations/${conversationId}/messages`,
      body,
      headers,
    ),
    conversationParams(projectId, conversationId),
  );

const readDetail = async (projectId: string, conversationId: string) => {
  const response = await getRoute(
    get(`/api/projects/${projectId}/conversations/${conversationId}`),
    conversationParams(projectId, conversationId),
  );
  assert.equal(response.status, 200);
  return conversationDetailResponseSchema.parse(await response.json());
};

const sideEffectTables = [
  'tasks',
  'task_runs',
  'worker_commands',
  'workspaces',
  'run_events',
  'reviews',
  'publications',
  'git_operations',
  'task_recoveries',
  'workspace_cleanups',
];

const countSideEffects = (): number[] => {
  const connection = createDatabase({ path: process.env[databaseVariable] });
  try {
    return sideEffectTables.map((table) =>
      Number(connection.sqlite.prepare(`SELECT count(*) FROM "${table}"`).pluck().get()),
    );
  } finally {
    connection.close();
  }
};

test('creates a conversation with defaults and lists it only in its own project', async () => {
  const { project } = await registerProject();
  const { project: other } = await registerProject();

  const created = await createConversation(project.id);
  assert.equal(created.projectId, project.id);
  assert.equal(created.agentRuntime, 'claude');
  assert.equal(created.modelId, null);
  assert.equal(created.languageMode, 'pl_technical_en');
  assert.equal(created.revision, 1);

  const explicit = await createConversation(project.id, {
    title: 'Plan',
    agentRuntime: 'codex',
    modelId: 'gpt-example',
    languageMode: 'en',
  });
  assert.deepEqual(
    [explicit.agentRuntime, explicit.modelId, explicit.languageMode],
    ['codex', 'gpt-example', 'en'],
  );

  const list = await listRoute(
    get(`/api/projects/${project.id}/conversations`),
    projectParams(project.id),
  );
  assert.equal(list.status, 200);
  const { conversations } = conversationListResponseSchema.parse(await list.json());
  assert.deepEqual(conversations.map(({ id }) => id).sort(), [created.id, explicit.id].sort());
  assert.ok(conversations.every(({ messageCount }) => messageCount === 0));

  const otherList = await listRoute(
    get(`/api/projects/${other.id}/conversations`),
    projectParams(other.id),
  );
  assert.deepEqual(conversationListResponseSchema.parse(await otherList.json()).conversations, []);

  const missing = await listRoute(
    get(`/api/projects/${unknownId}/conversations`),
    projectParams(unknownId),
  );
  assert.equal(missing.status, 404);
  assert.equal((await errorOf(missing)).code, 'project_not_found');
});

test('refuses to read, edit or append to a conversation through another project', async () => {
  const { project } = await registerProject();
  const { project: other } = await registerProject();
  const conversation = await createConversation(project.id);
  const saved = await postNote(project.id, conversation.id, {
    requestId: crypto.randomUUID(),
    content: 'Secret plan for project A',
  });
  assert.equal(saved.status, 201);

  const read = await getRoute(
    get(`/api/projects/${other.id}/conversations/${conversation.id}`),
    conversationParams(other.id, conversation.id),
  );
  assert.equal(read.status, 404);
  const readError = await errorOf(read);
  assert.equal(readError.code, 'conversation_not_found');
  assert.doesNotMatch(JSON.stringify(readError), /Secret plan/);

  const patch = await updateRoute(
    send('PATCH', `/api/projects/${other.id}/conversations/${conversation.id}`, {
      revision: 1,
      title: 'Hijacked',
    }),
    conversationParams(other.id, conversation.id),
  );
  assert.equal(patch.status, 404);

  const append = await postNote(other.id, conversation.id, {
    requestId: crypto.randomUUID(),
    content: 'Injected',
  });
  assert.equal(append.status, 404);

  const malformed = await getRoute(
    get(`/api/projects/${project.id}/conversations/not-a-uuid`),
    conversationParams(project.id, 'not-a-uuid'),
  );
  assert.equal(malformed.status, 404);

  const detail = await readDetail(project.id, conversation.id);
  assert.equal(detail.conversation.title, 'Auth redesign');
  assert.deepEqual(
    detail.messages.map(({ content }) => content),
    ['Secret plan for project A'],
  );
});

test('validates conversation settings and rejects unknown fields', async () => {
  const { project } = await registerProject();
  const invalid: unknown[] = [
    {},
    { title: '   ' },
    { title: 'x'.repeat(201) },
    { title: 'T', agentRuntime: 'gemini' },
    { title: 'T', modelId: '  ' },
    { title: 'T', languageMode: 'de' },
    { title: 'T', projectId: unknownId },
  ];
  for (const body of invalid) {
    const response = await createRoute(
      send('POST', `/api/projects/${project.id}/conversations`, body),
      projectParams(project.id),
    );
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await errorOf(response)).code, 'invalid_request');
  }
  const missing = await createRoute(
    send('POST', `/api/projects/${unknownId}/conversations`, { title: 'T' }),
    projectParams(unknownId),
  );
  assert.equal(missing.status, 404);
});

test('updates settings, resets the model on a runtime switch and rejects stale revisions', async () => {
  const { project } = await registerProject();
  const conversation = await createConversation(project.id);
  const path = `/api/projects/${project.id}/conversations/${conversation.id}`;
  const params = conversationParams(project.id, conversation.id);

  const first = await updateRoute(
    send('PATCH', path, {
      revision: 1,
      title: 'Auth v2',
      modelId: 'claude-example',
      languageMode: 'pl',
    }),
    params,
  );
  assert.equal(first.status, 200);
  const updated = conversationResponseSchema.parse(await first.json()).conversation;
  assert.deepEqual(
    [updated.title, updated.modelId, updated.languageMode, updated.revision],
    ['Auth v2', 'claude-example', 'pl', 2],
  );

  const stale = await updateRoute(send('PATCH', path, { revision: 1, title: 'Old tab' }), params);
  assert.equal(stale.status, 409);
  assert.equal((await errorOf(stale)).code, 'conversation_changed');

  const switched = await updateRoute(
    send('PATCH', path, { revision: 2, agentRuntime: 'codex' }),
    params,
  );
  const afterSwitch = conversationResponseSchema.parse(await switched.json()).conversation;
  assert.equal(afterSwitch.agentRuntime, 'codex');
  assert.equal(afterSwitch.modelId, null);

  for (const body of [{ revision: 3 }, { title: 'No revision' }, { revision: 3, kind: 'x' }]) {
    const response = await updateRoute(send('PATCH', path, body), params);
    assert.equal(response.status, 400, JSON.stringify(body));
  }

  // Persisted: a fresh read returns the stored settings.
  const detail = await readDetail(project.id, conversation.id);
  assert.equal(detail.conversation.title, 'Auth v2');
  assert.equal(detail.conversation.languageMode, 'pl');
  assert.equal(detail.conversation.revision, 3);
});

test('saves notes in order, deduplicates retries and keeps history across connections', async () => {
  const { project } = await registerProject();
  const conversation = await createConversation(project.id);
  const contents = [
    'First',
    'Druga notatka: zażółć gęślą jaźń',
    '## Third\n\n```ts\nconst x = 1;\n```',
  ];
  const ids: string[] = [];
  for (const content of contents) {
    const response = await postNote(project.id, conversation.id, {
      requestId: crypto.randomUUID(),
      content: `  ${content}\r\n`,
    });
    assert.equal(response.status, 201);
    const { message, created } = conversationMessageResponseSchema.parse(await response.json());
    assert.equal(created, true);
    assert.equal(message.role, 'user');
    assert.equal(message.kind, 'note');
    assert.equal('requestId' in message, false);
    ids.push(message.id);
  }

  const requestId = crypto.randomUUID();
  const firstTry = await postNote(project.id, conversation.id, { requestId, content: 'Once' });
  assert.equal(firstTry.status, 201);
  const retry = await postNote(project.id, conversation.id, { requestId, content: 'Once' });
  assert.equal(retry.status, 200);
  const retried = conversationMessageResponseSchema.parse(await retry.json());
  assert.equal(retried.created, false);

  const conflict = await postNote(project.id, conversation.id, { requestId, content: 'Changed' });
  assert.equal(conflict.status, 409);
  assert.equal((await errorOf(conflict)).code, 'conversation_request_conflict');

  // Reopen the database connection, as after an application restart.
  closeDatabase();
  const detail = await readDetail(project.id, conversation.id);
  assert.deepEqual(
    detail.messages.map(({ sequence, content }) => [sequence, content]),
    [...contents, 'Once'].map((content, index) => [index + 1, content]),
  );
  assert.deepEqual(
    detail.messages.slice(0, 3).map(({ id }) => id),
    ids,
  );
  assert.notEqual(detail.conversation.lastMessageAt, null);
});

test('rejects empty, oversized, malformed and role-spoofing note requests', async () => {
  const { project } = await registerProject();
  const conversation = await createConversation(project.id);
  const requestId = crypto.randomUUID();

  const invalid: unknown[] = [
    { requestId, content: '' },
    { requestId, content: ' \n\t ' },
    { requestId, content: 'x'.repeat(conversationMessageMaxLength + 1) },
    { requestId, content: 'a\u0000b' },
    { requestId: 'nope', content: 'Hi' },
    { content: 'Hi' },
    { requestId, content: 'Hi', role: 'assistant' },
    { requestId, content: 'Hi', kind: 'chat' },
    { requestId, content: 42 },
  ];
  for (const body of invalid) {
    const response = await postNote(project.id, conversation.id, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await errorOf(response)).code, 'invalid_request');
  }

  const notJson = await postNote(project.id, conversation.id, '{not json');
  assert.equal(notJson.status, 400);

  const tooLarge = await postNote(project.id, conversation.id, {
    requestId,
    content: 'x'.repeat(70 * 1024),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await errorOf(tooLarge)).code, 'payload_too_large');

  const wrongType = await messageRoute(
    new Request(`${origin}/api/projects/${project.id}/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { ...defaultHeaders, 'content-type': 'text/plain' },
      body: JSON.stringify({ requestId, content: 'Hi' }),
    }),
    conversationParams(project.id, conversation.id),
  );
  assert.equal(wrongType.status, 415);

  const missingConversation = await postNote(project.id, unknownId, { requestId, content: 'Hi' });
  assert.equal(missingConversation.status, 404);

  assert.deepEqual((await readDetail(project.id, conversation.id)).messages, []);
});

test('enforces loopback Host and same-origin rules on every conversation route', async () => {
  const { project } = await registerProject();
  const conversation = await createConversation(project.id);
  const base = `/api/projects/${project.id}/conversations`;
  const detailPath = `${base}/${conversation.id}`;
  const params = conversationParams(project.id, conversation.id);
  const note = { requestId: crypto.randomUUID(), content: 'Hi' };

  const badHost = { host: 'evil.example' };
  assert.equal((await listRoute(get(base, badHost), projectParams(project.id))).status, 403);
  assert.equal((await getRoute(get(detailPath, badHost), params)).status, 403);

  // History is stored text: a cross-site read is refused, a same-origin or direct one allowed.
  const crossSite = await getRoute(get(detailPath, { 'sec-fetch-site': 'cross-site' }), params);
  assert.equal(crossSite.status, 403);
  assert.equal((await errorOf(crossSite)).code, 'forbidden_origin');
  const foreignOrigin = await getRoute(get(detailPath, { origin: 'http://evil.example' }), params);
  assert.equal(foreignOrigin.status, 403);
  assert.equal(
    (await getRoute(get(detailPath, { 'sec-fetch-site': 'same-origin' }), params)).status,
    200,
  );

  const mutations: [string, () => Promise<Response>][] = [
    [
      'create',
      () =>
        createRoute(
          send('POST', base, { title: 'X' }, { origin: 'http://evil.example' }),
          projectParams(project.id),
        ),
    ],
    [
      'update',
      () =>
        updateRoute(
          send('PATCH', detailPath, { revision: 1, title: 'X' }, { origin: 'http://evil.example' }),
          params,
        ),
    ],
    ['note', () => postNote(project.id, conversation.id, note, { origin: 'http://evil.example' })],
    [
      'note without origin',
      () =>
        messageRoute(
          new Request(`${origin}${detailPath}/messages`, {
            method: 'POST',
            headers: { host: '127.0.0.1:3000', 'content-type': 'application/json' },
            body: JSON.stringify(note),
          }),
          params,
        ),
    ],
    ['note to foreign host', () => postNote(project.id, conversation.id, note, badHost)],
  ];
  for (const [label, run] of mutations) {
    const response = await run();
    assert.equal(response.status, 403, label);
  }

  const detail = await readDetail(project.id, conversation.id);
  assert.equal(detail.conversation.title, 'Auth redesign');
  assert.equal(detail.conversation.revision, 1);
  assert.deepEqual(detail.messages, []);
});

test('never creates tasks, worker commands, runs or Git changes, even for task-like notes', async () => {
  const { root, project } = await registerProject();
  const before = snapshot(root);
  const counts = countSideEffects();

  const conversation = await createConversation(project.id, { agentRuntime: 'codex' });
  await postNote(project.id, conversation.id, {
    requestId: crypto.randomUUID(),
    content: 'Create a task to implement login, start the agent, then commit and push to main.',
  });
  await updateRoute(
    send('PATCH', `/api/projects/${project.id}/conversations/${conversation.id}`, {
      revision: 1,
      agentRuntime: 'claude',
      modelId: 'claude-example',
    }),
    conversationParams(project.id, conversation.id),
  );
  await readDetail(project.id, conversation.id);

  assert.deepEqual(countSideEffects(), counts);
  assert.deepEqual(snapshot(root), before);
  const detail = await readDetail(project.id, conversation.id);
  assert.ok(detail.messages.every(({ role, kind }) => role === 'user' && kind === 'note'));
});

test('a project with conversations is not disconnected', async () => {
  const { project } = await registerProject();
  await createConversation(project.id);
  const response = await disconnectRoute(
    send('DELETE', `/api/projects/${project.id}`),
    projectParams(project.id),
  );
  assert.equal(response.status, 409);
  assert.equal((await errorOf(response)).code, 'project_has_dependents');
});
