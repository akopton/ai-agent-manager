import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConversationError,
  conversationDisclosure,
  conversationReplyMaxLength,
  trustedLocalDisclosure,
  type ConversationErrorCode,
} from '@ai-agent-manager/core';
import { sql } from 'drizzle-orm';
import {
  acceptConversationDisclosure,
  acceptTrustedLocal,
  addConversationNote,
  applyMigrations,
  claimConversationTurn,
  createConversation,
  createDatabase,
  createTask,
  disableConversationAi,
  expireQueuedConversationTurns,
  finishConversationTurn,
  getConversationConsent,
  insertProject,
  listConversationMessages,
  listConversationTurns,
  listRunningConversationTurns,
  requestConversationTurnStop,
  retryConversationTurn,
  sendConversationMessage,
  updateConversation,
  type DatabaseConnection,
} from '../src/index.js';

// C2 — conversation turn persistence: consent, idempotent sends, one active turn per
// conversation, claims with separate per-runtime capacity, replies only from completed turns,
// stop, retry and expiry. No process is started here.

const projectA = '00000000-0000-4000-8000-00000000000a';
const projectB = '00000000-0000-4000-8000-00000000000b';
const conversationA = '00000000-0000-4000-8000-000000000101';
const conversationB = '00000000-0000-4000-8000-000000000102';
const scopeA = { projectId: projectA, conversationId: conversationA };
const scopeB = { projectId: projectB, conversationId: conversationB };

type Db = DatabaseConnection['db'];

const withDatabase = (run: (db: Db, connection: DatabaseConnection) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-turns-'));
  const connection = createDatabase({ path: join(directory, 'database.sqlite') });
  try {
    applyMigrations(connection);
    for (const [id, name] of [
      [projectA, 'website'],
      [projectB, 'api'],
    ] as const) {
      insertProject(connection.db, {
        id,
        name,
        localPath: `/repos/${name}`,
        gitCommonDir: `/repos/${name}/.git`,
        remoteName: 'origin',
        defaultBaseBranch: 'main',
        createdAt: 1_000,
        updatedAt: 1_000,
      });
    }
    createConversation(connection.db, {
      id: conversationA,
      input: { projectId: projectA, title: 'Planning', agentRuntime: 'claude', modelId: 'opus' },
      now: 2_000,
    });
    createConversation(connection.db, {
      id: conversationB,
      input: { projectId: projectB, title: 'Other', agentRuntime: 'codex', languageMode: 'en' },
      now: 2_000,
    });
    run(connection.db, connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

const throwsCode = (run: () => unknown, code: ConversationErrorCode): void => {
  assert.throws(
    run,
    (error: unknown) => error instanceof ConversationError && error.code === code,
    `expected ${code}`,
  );
};

const enable = (db: Db, now = 3_000) =>
  acceptConversationDisclosure(db, {
    input: { disclosureVersion: conversationDisclosure.version },
    now,
  });

const send = (db: Db, content: string, scope = scopeA, requestId = randomUUID(), now = 4_000) =>
  sendConversationMessage(db, {
    scope,
    messageId: randomUUID(),
    turnId: randomUUID(),
    input: { requestId, content },
    now,
  });

const complete = (db: Db, turnId: string, reply: string, now = 6_000) =>
  finishConversationTurn(
    db,
    turnId,
    { status: 'completed', reply, effectiveModelId: 'claude-opus-5-5', exitCode: 0, endedAt: now },
    { createMessageId: randomUUID },
  );

test('AI replies need the separate AI Conversations acceptance', () => {
  withDatabase((db) => {
    throwsCode(() => send(db, 'Hello'), 'conversation_ai_disabled');
    // Trusted Local execution consent does not enable conversations.
    acceptTrustedLocal(db, {
      input: {
        disclosureVersion: trustedLocalDisclosure.version,
        acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
      },
      now: 2_500,
    });
    throwsCode(() => send(db, 'Hello'), 'conversation_ai_disabled');
    throwsCode(
      () => acceptConversationDisclosure(db, { input: { disclosureVersion: 'old' }, now: 1 }),
      'conversation_ai_stale',
    );
    enable(db);
    assert.equal(getConversationConsent(db).enabled, true);
    const result = send(db, 'Hello');
    assert.equal(result.created, true);
    assert.equal(result.message.kind, 'chat');
    assert.equal(result.message.role, 'user');
    assert.equal(result.turn.status, 'queued');
    assert.equal(result.turn.requestedModelId, 'opus');
    disableConversationAi(db, { now: 5_000 });
    // A queued turn fails visibly on the next claim instead of starting.
    assert.deepEqual(claimConversationTurn(db, { workerInstanceId: 'w', now: 5_100 }), {
      claimed: false,
    });
    const [turn] = listConversationTurns(db, scopeA) ?? [];
    assert.equal(turn?.status, 'failed');
    assert.equal(turn?.errorCode, 'conversation_ai_disabled');
  });
});

test('a repeated send is idempotent and a conflicting reuse is refused', () => {
  withDatabase((db) => {
    enable(db);
    const requestId = randomUUID();
    const first = send(db, 'Plan the API', scopeA, requestId);
    const again = send(db, 'Plan the API', scopeA, requestId);
    assert.equal(again.created, false);
    assert.equal(again.turn.id, first.turn.id);
    assert.equal(listConversationMessages(db, scopeA)?.length, 1);
    throwsCode(
      () => send(db, 'Different text', scopeA, requestId),
      'conversation_request_conflict',
    );
    throwsCode(() => send(db, 'Plan the API', scopeB, requestId), 'conversation_request_conflict');
  });
});

test('one active turn per conversation; notes wait until the reply finished', () => {
  withDatabase((db) => {
    enable(db);
    const first = send(db, 'First');
    throwsCode(() => send(db, 'Second'), 'conversation_turn_active');
    throwsCode(
      () =>
        addConversationNote(db, {
          scope: scopeA,
          id: randomUUID(),
          input: { requestId: randomUUID(), content: 'A note' },
          now: 4_100,
        }),
      'conversation_turn_active',
    );
    // Another conversation is independent.
    assert.equal(send(db, 'Elsewhere', scopeB).created, true);
    // The partial unique index enforces it in SQLite as well.
    assert.throws(() =>
      db.run(
        sql`INSERT INTO conversation_turns (id, conversation_id, user_message_id, request_id, status, agent_runtime, language_mode, created_at, updated_at) VALUES (${randomUUID()}, ${conversationA}, ${first.message.id}, ${randomUUID()}, 'queued', 'claude', 'pl', 1, 1)`,
      ),
    );
  });
});

test('claims respect a separate conversation slot per runtime and carry completed history', () => {
  withDatabase((db) => {
    enable(db);
    const first = send(db, 'Question one');
    const other = send(db, 'Codex question', scopeB, randomUUID(), 4_100);
    const claimed = claimConversationTurn(db, { workerInstanceId: 'w1', now: 4_500 });
    assert.ok(claimed.claimed);
    if (!claimed.claimed) return;
    assert.equal(claimed.claim.turn.id, first.turn.id);
    assert.equal(claimed.claim.turn.status, 'running');
    assert.equal(claimed.claim.history.length, 0);
    // A Claude turn runs; the Codex turn still has its own slot.
    const second = claimConversationTurn(db, { workerInstanceId: 'w1', now: 4_600 });
    assert.ok(second.claimed);
    if (second.claimed) assert.equal(second.claim.turn.id, other.turn.id);

    const finished = complete(db, first.turn.id, 'Answer one');
    assert.equal(finished?.status, 'completed');
    assert.ok(finished?.assistantMessageId);
    // A turn finishes exactly once.
    assert.equal(complete(db, first.turn.id, 'Duplicate'), undefined);

    addConversationNote(db, {
      scope: scopeA,
      id: randomUUID(),
      input: { requestId: randomUUID(), content: 'Private note' },
      now: 6_500,
    });
    // Settings changes apply to later turns only.
    updateConversation(db, {
      scope: scopeA,
      input: { revision: 1, agentRuntime: 'codex', languageMode: 'en' },
      now: 6_600,
    });
    const next = send(db, 'Question two', scopeA, randomUUID(), 7_000);
    assert.equal(next.turn.agentRuntime, 'codex');
    assert.equal(next.turn.requestedModelId, null);
    assert.equal(next.turn.languageMode, 'en');
    // The Codex slot is busy with conversation B.
    assert.deepEqual(claimConversationTurn(db, { workerInstanceId: 'w1', now: 7_100 }), {
      claimed: false,
    });
    finishConversationTurn(
      db,
      other.turn.id,
      {
        status: 'failed',
        errorCode: 'provider_error',
        errorMessage: 'boom',
        exitCode: 1,
        signal: null,
        effectiveModelId: null,
        endedAt: 7_200,
      },
      { createMessageId: randomUUID },
    );
    const third = claimConversationTurn(db, { workerInstanceId: 'w1', now: 7_300 });
    assert.ok(third.claimed);
    if (!third.claimed) return;
    assert.deepEqual(
      third.claim.history.map(({ role, content }) => [role, content]),
      [
        ['user', 'Question one'],
        ['assistant', 'Answer one'],
      ],
    );
    assert.equal(third.claim.notesExcluded, 1);
    const messages = listConversationMessages(db, scopeA) ?? [];
    assert.deepEqual(
      messages.map(({ sequence, role, kind }) => [sequence, role, kind]),
      [
        [1, 'user', 'chat'],
        [2, 'assistant', 'chat'],
        [3, 'user', 'note'],
        [4, 'user', 'chat'],
      ],
    );
  });
});

test('a failed turn stores no reply; retry creates a new turn for the same message', () => {
  withDatabase((db) => {
    enable(db);
    const sent = send(db, 'Will fail');
    claimConversationTurn(db, { workerInstanceId: 'w', now: 4_500 });
    const failed = finishConversationTurn(
      db,
      sent.turn.id,
      {
        status: 'failed',
        errorCode: 'cli_auth_required',
        errorMessage: 'Not logged in',
        exitCode: 1,
        signal: null,
        effectiveModelId: null,
        endedAt: 5_000,
      },
      { createMessageId: randomUUID },
    );
    assert.equal(failed?.assistantMessageId, null);
    assert.equal(listConversationMessages(db, scopeA)?.length, 1);
    // A completed reply can never be attached to a failed turn (CHECK constraint).
    assert.throws(() =>
      db.run(
        sql`UPDATE conversation_turns SET assistant_message_id = ${sent.message.id} WHERE id = ${sent.turn.id}`,
      ),
    );

    const requestId = randomUUID();
    const retried = retryConversationTurn(db, {
      scope: scopeA,
      turnId: sent.turn.id,
      newTurnId: randomUUID(),
      input: { requestId },
      now: 5_500,
    });
    assert.equal(retried.created, true);
    assert.equal(retried.turn.userMessageId, sent.message.id);
    assert.equal(retried.turn.retryOfTurnId, sent.turn.id);
    const repeated = retryConversationTurn(db, {
      scope: scopeA,
      turnId: sent.turn.id,
      newTurnId: randomUUID(),
      input: { requestId },
      now: 5_600,
    });
    assert.equal(repeated.created, false);
    assert.equal(repeated.turn.id, retried.turn.id);
    // The old turn is no longer the latest.
    throwsCode(
      () =>
        retryConversationTurn(db, {
          scope: scopeA,
          turnId: sent.turn.id,
          newTurnId: randomUUID(),
          input: { requestId: randomUUID() },
          now: 5_700,
        }),
      'conversation_turn_not_retryable',
    );
  });
});

test('stop cancels a queued turn at once and marks a running one as stopping', () => {
  withDatabase((db) => {
    enable(db);
    const queued = send(db, 'Never mind');
    const cancelled = requestConversationTurnStop(db, {
      scope: scopeA,
      turnId: queued.turn.id,
      now: 4_100,
    });
    assert.equal(cancelled.status, 'cancelled');
    // Idempotent.
    assert.equal(
      requestConversationTurnStop(db, { scope: scopeA, turnId: queued.turn.id, now: 4_200 }).status,
      'cancelled',
    );
    const running = send(db, 'Long one', scopeA, randomUUID(), 4_300);
    claimConversationTurn(db, { workerInstanceId: 'w', now: 4_400 });
    assert.equal(
      requestConversationTurnStop(db, { scope: scopeA, turnId: running.turn.id, now: 4_500 })
        .status,
      'stopping',
    );
    // Another project cannot see or stop it.
    throwsCode(
      () =>
        requestConversationTurnStop(db, {
          scope: { projectId: projectB, conversationId: conversationA },
          turnId: running.turn.id,
          now: 4_600,
        }),
      'conversation_not_found',
    );
    finishConversationTurn(
      db,
      running.turn.id,
      {
        status: 'cancelled',
        errorCode: null,
        errorMessage: 'Stopped.',
        exitCode: null,
        signal: 'SIGTERM',
        effectiveModelId: null,
        endedAt: 4_700,
      },
      { createMessageId: randomUUID },
    );
    throwsCode(
      () => requestConversationTurnStop(db, { scope: scopeA, turnId: sent(db).turn.id, now: 9 }),
      'conversation_turn_not_active',
    );
    assert.equal(listRunningConversationTurns(db).length, 0);
  });
});

/** A completed turn, for the "already finished" case. */
const sent = (db: Db) => {
  const result = send(db, 'Quick', scopeA, randomUUID(), 5_000);
  claimConversationTurn(db, { workerInstanceId: 'w', now: 5_001 });
  complete(db, result.turn.id, 'Done', 5_002);
  return result;
};

test('stale queued turns expire instead of starting late; long replies are truncated', () => {
  withDatabase((db) => {
    enable(db);
    const stale = send(db, 'Old', scopeA, randomUUID(), 4_000);
    assert.equal(expireQueuedConversationTurns(db, { olderThan: 10_000, now: 10_000 }), 1);
    const [expired] = listConversationTurns(db, scopeA) ?? [];
    assert.equal(expired?.id, stale.turn.id);
    assert.equal(expired?.errorCode, 'request_expired');

    const fresh = send(db, 'New', scopeA, randomUUID(), 11_000);
    claimConversationTurn(db, { workerInstanceId: 'w', now: 11_001 });
    const finished = complete(db, fresh.turn.id, 'x'.repeat(conversationReplyMaxLength + 50));
    assert.equal(finished?.replyTruncated, true);
    const reply = (listConversationMessages(db, scopeA) ?? []).at(-1);
    assert.equal(reply?.content.length, conversationReplyMaxLength);
  });
});

test('conversation turns never touch tasks, runs or worker commands', () => {
  withDatabase((db, connection) => {
    enable(db);
    createTask(db, {
      id: randomUUID(),
      input: { projectId: projectA, title: 'Existing', prompt: 'Do it', agentRuntime: 'claude' },
      now: 1_500,
    });
    const counts = () =>
      ['tasks', 'task_runs', 'worker_commands', 'workspaces'].map(
        (table) =>
          (connection.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
            .n,
      );
    const before = counts();
    const result = send(db, 'Plan');
    claimConversationTurn(db, { workerInstanceId: 'w', now: 4_500 });
    complete(db, result.turn.id, 'Plan reply');
    assert.deepEqual(counts(), before);
  });
});
