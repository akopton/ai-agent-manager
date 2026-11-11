import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  conversationDisclosure,
  trustedLocalDisclosure,
  type Conversation,
} from '@ai-agent-manager/core';
import {
  applyMigrations,
  claimConversationTurn,
  createDatabase,
  finishConversationTurn,
} from '@ai-agent-manager/database';
import {
  PATCH as updateNoteRoute,
  DELETE as deleteNoteRoute,
} from '@/app/api/projects/[projectId]/conversations/[conversationId]/messages/[noteId]/route';
import { POST as messageRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/messages/route';
import { GET as getRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/route';
import { POST as retryRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/turns/[turnId]/retry/route';
import { POST as stopRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/turns/[turnId]/stop/route';
import { POST as sendRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/turns/route';
import { POST as createRoute } from '@/app/api/projects/[projectId]/conversations/route';
import { POST as registerRoute } from '@/app/api/projects/route';
import {
  GET as getConversationSettingsRoute,
  PUT as conversationSettingsRoute,
} from '@/app/api/settings/conversations/route';
import { PUT as trustedLocalRoute } from '@/app/api/settings/trusted-local/route';
import {
  conversationDetailResponseSchema,
  updateConversationNoteResponseSchema,
  conversationResponseSchema,
  conversationSettingsResponseSchema,
  conversationTurnResponseSchema,
  sendConversationMessageResponseSchema,
} from '@/lib/conversations/contracts';
import { apiErrorResponseSchema, projectResponseSchema } from '@/lib/projects/contracts';
import { closeDatabase, getDatabase } from '@/lib/server/database';
import {
  createFixtureDirectory,
  createRepository,
  git,
  removeFixtureDirectory,
  snapshot,
} from './fixtures';

// C2 — conversation turn API: separate consent, Host/Origin guards, project scoping, idempotent
// sends, one active turn, stop and retry, and no task, worker-command, run or Git side effects.
// No worker runs here: turns stay queued unless the test finishes them through the database.

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

const send = (
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`${origin}${path}`, {
    method,
    headers: {
      host: '127.0.0.1:3000',
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const errorOf = async (response: Response) =>
  apiErrorResponseSchema.parse(await response.json()).error;

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let counter = 0;
const setUp = async (): Promise<{
  root: string;
  projectId: string;
  conversation: Conversation;
}> => {
  counter += 1;
  const name = `turns-${counter}`;
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
    send('POST', `/api/projects/${projectId}/conversations`, { title: 'Plan', modelId: 'opus' }),
    params({ projectId }),
  );
  assert.equal(created.status, 201);
  return {
    root,
    projectId,
    conversation: conversationResponseSchema.parse(await created.json()).conversation,
  };
};

const sendMessage = (
  projectId: string,
  conversationId: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  sendRoute(
    send('POST', `/api/projects/${projectId}/conversations/${conversationId}/turns`, body, headers),
    params({ projectId, conversationId }),
  );

const enableAi = async () => {
  const response = await conversationSettingsRoute(
    send('PUT', '/api/settings/conversations', {
      enabled: true,
      disclosureVersion: conversationDisclosure.version,
    }),
  );
  assert.equal(response.status, 200);
  return conversationSettingsResponseSchema.parse(await response.json()).settings;
};

const disableAi = () =>
  conversationSettingsRoute(send('PUT', '/api/settings/conversations', { enabled: false }));

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

test('AI replies need the separate AI Conversations consent; execution consent does not count', async () => {
  const { projectId, conversation } = await setUp();
  await disableAi();
  const trusted = await trustedLocalRoute(
    send('PUT', '/api/settings/trusted-local', {
      enabled: true,
      disclosureVersion: trustedLocalDisclosure.version,
      acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
    }),
  );
  assert.equal(trusted.status, 200);
  const refused = await sendMessage(projectId, conversation.id, {
    requestId: randomUUID(),
    content: 'Hello',
  });
  assert.equal(refused.status, 409);
  assert.equal((await errorOf(refused)).code, 'conversation_ai_disabled');
  assert.deepEqual((await detail(projectId, conversation.id)).ai, {
    enabled: false,
    reason: 'disabled',
  });

  const stale = await conversationSettingsRoute(
    send('PUT', '/api/settings/conversations', { enabled: true, disclosureVersion: 'older' }),
  );
  assert.equal(stale.status, 409);
  assert.equal((await errorOf(stale)).code, 'conversation_ai_stale');

  const settings = await enableAi();
  assert.equal(settings.current, true);
  const read = await getConversationSettingsRoute(
    new Request(`${origin}/api/settings/conversations`, { headers: { host: '127.0.0.1:3000' } }),
  );
  assert.equal(read.status, 200);
});

test('sending stores the message and a queued turn, returns at once and is idempotent', async () => {
  const { root, projectId, conversation } = await setUp();
  await enableAi();
  const before = snapshot(root);
  const requestId = randomUUID();
  const first = await sendMessage(projectId, conversation.id, { requestId, content: 'Plan it' });
  assert.equal(first.status, 202);
  const body = sendConversationMessageResponseSchema.parse(await first.json());
  assert.equal(body.message.kind, 'chat');
  assert.equal(body.message.role, 'user');
  assert.equal(body.turn.status, 'queued');
  assert.equal(body.turn.active, true);
  assert.equal(body.turn.requestedModelId, 'opus');

  const repeat = await sendMessage(projectId, conversation.id, { requestId, content: 'Plan it' });
  assert.equal(repeat.status, 200);
  assert.equal(
    sendConversationMessageResponseSchema.parse(await repeat.json()).turn.id,
    body.turn.id,
  );

  const overlapping = await sendMessage(projectId, conversation.id, {
    requestId: randomUUID(),
    content: 'Second',
  });
  assert.equal(overlapping.status, 409);
  assert.equal((await errorOf(overlapping)).code, 'conversation_turn_active');

  // Notes wait too, so they never split an exchange.
  const note = await messageRoute(
    send('POST', `/api/projects/${projectId}/conversations/${conversation.id}/messages`, {
      requestId: randomUUID(),
      content: 'A note',
    }),
    params({ projectId, conversationId: conversation.id }),
  );
  assert.equal(note.status, 409);

  const view = await detail(projectId, conversation.id);
  assert.equal(view.messages.length, 1);
  assert.equal(view.turns.length, 1);
  assert.deepEqual(snapshot(root), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
  const reader = createDatabase({ path: process.env[databaseVariable] });
  try {
    for (const table of ['tasks', 'task_runs', 'worker_commands', 'workspaces']) {
      const rows = reader.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get();
      assert.deepEqual(rows, { n: 0 }, table);
    }
  } finally {
    reader.close();
  }
});

test('send rejects role, kind and other unknown fields, and guards Host, Origin and JSON', async () => {
  const { projectId, conversation } = await setUp();
  await enableAi();
  const base = { requestId: randomUUID(), content: 'Hi' };
  for (const extra of [{ role: 'assistant' }, { kind: 'note' }, { modelId: 'x' }]) {
    const response = await sendMessage(projectId, conversation.id, { ...base, ...extra });
    assert.equal(response.status, 400);
  }
  const foreignOrigin = await sendMessage(projectId, conversation.id, base, {
    origin: 'https://evil.example',
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal((await errorOf(foreignOrigin)).code, 'forbidden_origin');
  const foreignHost = await sendMessage(projectId, conversation.id, base, {
    host: 'evil.example',
    origin: 'http://evil.example',
  });
  assert.equal(foreignHost.status, 403);
  const text = await sendRoute(
    new Request(`${origin}/api/projects/${projectId}/conversations/${conversation.id}/turns`, {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', origin, 'content-type': 'text/plain' },
      body: JSON.stringify(base),
    }),
    params({ projectId, conversationId: conversation.id }),
  );
  assert.equal(text.status, 415);
  const settingsCrossSite = await conversationSettingsRoute(
    send(
      'PUT',
      '/api/settings/conversations',
      { enabled: true, disclosureVersion: conversationDisclosure.version },
      { origin: 'https://evil.example' },
    ),
  );
  assert.equal(settingsCrossSite.status, 403);
});

test('turn routes are scoped to their project and conversation', async () => {
  const first = await setUp();
  const second = await setUp();
  await enableAi();
  const sent = sendConversationMessageResponseSchema.parse(
    await (
      await sendMessage(first.projectId, first.conversation.id, {
        requestId: randomUUID(),
        content: 'Mine',
      })
    ).json(),
  );
  const crossSend = await sendMessage(second.projectId, first.conversation.id, {
    requestId: randomUUID(),
    content: 'Not mine',
  });
  assert.equal(crossSend.status, 404);
  assert.equal((await errorOf(crossSend)).code, 'conversation_not_found');
  const crossStop = await stopRoute(
    send(
      'POST',
      `/api/projects/${second.projectId}/conversations/${second.conversation.id}/turns/${sent.turn.id}/stop`,
    ),
    params({
      projectId: second.projectId,
      conversationId: second.conversation.id,
      turnId: sent.turn.id,
    }),
  );
  assert.equal(crossStop.status, 404);
  assert.equal((await errorOf(crossStop)).code, 'conversation_turn_not_found');
  const unknown = await sendMessage(unknownId, first.conversation.id, {
    requestId: randomUUID(),
    content: 'x',
  });
  assert.equal(unknown.status, 404);
});

test('stop cancels a queued turn; retry queues a new turn only for the latest failed one', async () => {
  const { projectId, conversation } = await setUp();
  await enableAi();
  const scope = { projectId, conversationId: conversation.id };
  const sent = sendConversationMessageResponseSchema.parse(
    await (
      await sendMessage(projectId, conversation.id, { requestId: randomUUID(), content: 'Q' })
    ).json(),
  );
  const turnPath = (turnId: string, action: string) =>
    `/api/projects/${projectId}/conversations/${conversation.id}/turns/${turnId}/${action}`;
  const stopped = await stopRoute(
    send('POST', turnPath(sent.turn.id, 'stop')),
    params({ ...scope, turnId: sent.turn.id }),
  );
  assert.equal(stopped.status, 200);
  assert.equal(conversationTurnResponseSchema.parse(await stopped.json()).turn.status, 'cancelled');

  const requestId = randomUUID();
  const retried = await retryRoute(
    send('POST', turnPath(sent.turn.id, 'retry'), { requestId }),
    params({ ...scope, turnId: sent.turn.id }),
  );
  assert.equal(retried.status, 202);
  const retry = conversationTurnResponseSchema.parse(await retried.json()).turn;
  assert.equal(retry.retryOfTurnId, sent.turn.id);
  assert.equal(retry.status, 'queued');
  const repeated = await retryRoute(
    send('POST', turnPath(sent.turn.id, 'retry'), { requestId }),
    params({ ...scope, turnId: sent.turn.id }),
  );
  assert.equal(repeated.status, 200);

  // Finish the retry as the worker would, then stop and retry are refused.
  const db = getDatabase();
  assert.ok(claimConversationTurn(db, { workerInstanceId: 'w', now: Date.now() }).claimed);
  finishConversationTurn(
    db,
    retry.id,
    {
      status: 'completed',
      reply: 'Answer',
      effectiveModelId: null,
      exitCode: 0,
      endedAt: Date.now(),
    },
    { createMessageId: randomUUID },
  );
  const lateStop = await stopRoute(
    send('POST', turnPath(retry.id, 'stop')),
    params({ ...scope, turnId: retry.id }),
  );
  assert.equal(lateStop.status, 409);
  assert.equal((await errorOf(lateStop)).code, 'conversation_turn_not_active');
  const lateRetry = await retryRoute(
    send('POST', turnPath(retry.id, 'retry'), { requestId: randomUUID() }),
    params({ ...scope, turnId: retry.id }),
  );
  assert.equal(lateRetry.status, 409);
  assert.equal((await errorOf(lateRetry)).code, 'conversation_turn_not_retryable');

  const view = await detail(projectId, conversation.id);
  assert.deepEqual(
    view.messages.map(({ role, kind }) => [role, kind]),
    [
      ['user', 'chat'],
      ['assistant', 'chat'],
    ],
  );
  assert.equal(view.turns.at(-1)?.assistantMessageId, view.messages[1]?.id);
});

test('a model of the other provider is refused; switching runtime resets the model', async () => {
  const { projectId } = await setUp();
  const wrong = await createRoute(
    send('POST', `/api/projects/${projectId}/conversations`, {
      title: 'Wrong',
      agentRuntime: 'claude',
      modelId: 'gpt-6.1-sol',
    }),
    params({ projectId }),
  );
  assert.equal(wrong.status, 400);
  assert.match((await errorOf(wrong)).message, /Codex model/);
  const custom = await createRoute(
    send('POST', `/api/projects/${projectId}/conversations`, {
      title: 'Custom',
      agentRuntime: 'claude',
      modelId: 'claude-future-9',
    }),
    params({ projectId }),
  );
  assert.equal(custom.status, 201);
  assert.equal(
    conversationResponseSchema.parse(await custom.json()).conversation.modelId,
    'claude-future-9',
  );
});

test('references accept IDs only, expose bounded provenance and preserve request idempotency', async () => {
  const { projectId, conversation } = await setUp();
  await enableAi();
  const noteId = randomUUID();
  const { addConversationNote } = await import('@ai-agent-manager/database');
  addConversationNote(getDatabase(), {
    scope: { projectId, conversationId: conversation.id },
    id: noteId,
    input: { requestId: randomUUID(), content: 'Explicit note '.repeat(80) },
    now: Date.now(),
  });
  const input = { requestId: randomUUID(), content: 'Consider this note', referenceIds: [noteId] };
  const result = await sendMessage(projectId, conversation.id, input);
  assert.equal(result.status, 202);
  const payload = sendConversationMessageResponseSchema.parse(await result.json());
  assert.equal(payload.turn.references?.[0]?.sourceId, noteId);
  assert.equal(payload.turn.references?.[0]?.preview.length, 240);
  assert.equal('content' in (payload.turn.references?.[0] ?? {}), false);
  const repeated = await sendMessage(projectId, conversation.id, input);
  assert.equal(repeated.status, 200);
  assert.equal(
    sendConversationMessageResponseSchema.parse(await repeated.json()).turn.id,
    payload.turn.id,
  );
  const changed = await sendMessage(projectId, conversation.id, { ...input, referenceIds: [] });
  assert.equal((await errorOf(changed)).code, 'conversation_request_conflict');
  const textInjection = await sendMessage(projectId, conversation.id, {
    ...input,
    referenceIds: [{ sourceId: noteId, content: 'Client supplied' }],
  });
  assert.equal(textInjection.status, 400);
});

test('note API revisions, deletion and historical source availability stay scoped and guarded', async () => {
  const own = await setUp();
  const foreign = await setUp();
  await enableAi();
  const { addConversationNote } = await import('@ai-agent-manager/database');
  const note = addConversationNote(getDatabase(), {
    scope: { projectId: own.projectId, conversationId: own.conversation.id },
    id: randomUUID(),
    input: { requestId: randomUUID(), content: 'Original historical note' },
    now: Date.now(),
  }).message;
  const scope = { projectId: own.projectId, conversationId: own.conversation.id, noteId: note.id };
  const path = `/api/projects/${scope.projectId}/conversations/${scope.conversationId}/messages/${note.id}`;
  const original = await sendMessage(scope.projectId, scope.conversationId, {
    requestId: randomUUID(),
    content: 'Use original',
    referenceIds: [note.id],
  });
  assert.equal(original.status, 202);
  const queued = sendConversationMessageResponseSchema.parse(await original.json());
  const { requestConversationTurnStop } = await import('@ai-agent-manager/database');
  requestConversationTurnStop(getDatabase(), { scope, turnId: queued.turn.id, now: Date.now() });
  const updated = await updateNoteRoute(
    send('PATCH', path, { revision: 1, content: 'Edited current note' }),
    params(scope),
  );
  assert.equal(updated.status, 200);
  assert.equal(
    updateConversationNoteResponseSchema.parse(await updated.json()).message.content,
    'Edited current note',
  );
  const current = (await detail(scope.projectId, scope.conversationId)).messages.find(
    (item) => item.id === note.id,
  );
  assert.equal(current?.content, 'Edited current note');
  assert.equal(current?.revision, 2);
  assert.equal(current?.createdAt, note.createdAt);
  const stale = await updateNoteRoute(
    send('PATCH', path, { revision: 1, content: 'Stale edit' }),
    params(scope),
  );
  assert.equal(stale.status, 409);
  assert.equal((await errorOf(stale)).code, 'conversation_note_changed');
  for (const route of [updateNoteRoute, deleteNoteRoute]) {
    const method = route === updateNoteRoute ? 'PATCH' : 'DELETE';
    const body = route === updateNoteRoute ? { revision: 2, content: 'Blocked' } : { revision: 2 };
    const cross = await route(
      send(method, path, body),
      params({ ...scope, projectId: foreign.projectId, conversationId: foreign.conversation.id }),
    );
    assert.equal(cross.status, 404);
    const crossConversation = await route(
      send(method, path, body),
      params({ ...scope, conversationId: foreign.conversation.id }),
    );
    assert.equal(crossConversation.status, 404);
    const originBlocked = await route(
      send(method, path, body, { origin: 'https://untrusted.example' }),
      params(scope),
    );
    assert.equal(originBlocked.status, 403);
    const hostBlocked = await route(
      send(method, path, body, { host: 'untrusted.example' }),
      params(scope),
    );
    assert.equal(hostBlocked.status, 403);
    const contentType = await route(
      send(method, path, body, { 'content-type': 'text/plain' }),
      params(scope),
    );
    assert.equal(contentType.status, 415);
    const tooLarge = await route(
      send(method, path, { ...body, extra: 'x'.repeat(70_000) }),
      params(scope),
    );
    assert.equal(tooLarge.status, 413);
  }
  for (const content of ['', 'x'.repeat(20_001)])
    assert.equal(
      (await updateNoteRoute(send('PATCH', path, { revision: 2, content }), params(scope))).status,
      400,
    );
  const before = (await detail(scope.projectId, scope.conversationId)).turns.find(
    (turn) => turn.id === queued.turn.id,
  );
  assert.equal(before?.references?.[0]?.preview, 'Original historical note');
  assert.equal(before?.references?.[0]?.sourceAvailable, true);
  assert.equal(
    (await deleteNoteRoute(send('DELETE', path, { revision: 2 }), params(scope))).status,
    200,
  );
  assert.equal(
    (await deleteNoteRoute(send('DELETE', path, { revision: 2 }), params(scope))).status,
    200,
  );
  assert.equal(
    (
      await updateNoteRoute(
        send('PATCH', path, { revision: 2, content: 'Resurrect' }),
        params(scope),
      )
    ).status,
    404,
  );
  const after = await detail(scope.projectId, scope.conversationId);
  assert.equal(
    after.messages.some((item) => item.id === note.id),
    false,
  );
  const historical = after.turns.find((turn) => turn.id === queued.turn.id);
  assert.equal(historical?.references?.[0]?.preview, 'Original historical note');
  assert.equal(historical?.references?.[0]?.sourceAvailable, false);
  const rejected = await sendMessage(scope.projectId, scope.conversationId, {
    requestId: randomUUID(),
    content: 'Unsent deleted reference',
    referenceIds: [note.id],
  });
  assert.equal(rejected.status, 400);
});
