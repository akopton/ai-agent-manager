import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  addConversationNote,
  claimConversationTurn,
  findConversationTurn,
  listConversationMessages,
  retryConversationTurn,
  sendConversationMessage,
  updateConversationNote,
  deleteConversationNote,
} from '@ai-agent-manager/database';
import { reply, scope, withFixture } from './conversation-fixtures.js';
import { snapshotTree } from './execution-fixtures.js';

for (const runtime of ['claude', 'codex'] as const) {
  test(`${runtime}: explicit references reach fake CLI; unselected notes stay private through restart and Retry`, async () => {
    await withFixture(async (fixture) => {
      const { db, connection } = fixture;
      const conversationId = fixture.conversation(runtime);
      const target = scope(fixture, conversationId);
      const before = snapshotTree(fixture.repository.root);
      const saved = addConversationNote(db, {
        scope: target,
        id: randomUUID(),
        input: { requestId: randomUUID(), content: 'EXPLICIT_PRIVATE_NOTE' },
        now: Date.now(),
      }).message;
      addConversationNote(db, {
        scope: target,
        id: randomUUID(),
        input: { requestId: randomUUID(), content: 'UNSELECTED_SECRET_NOTE' },
        now: Date.now(),
      });
      const first = fixture.send(conversationId, 'Ordinary question');
      fixture.fakes[runtime].setSteps(reply[runtime]('Ordinary answer'));
      let service = fixture.service();
      await service.start();
      await fixture.waitForTurn(first.turnId, ['completed']);
      await service.stop();
      assert.doesNotMatch(
        fixture.fakes[runtime].invocations()[0]?.stdin ?? '',
        /EXPLICIT_PRIVATE_NOTE|UNSELECTED_SECRET_NOTE/,
      );
      const messages = listConversationMessages(db, target) ?? [];
      const user = messages.find((message) => message.kind === 'chat' && message.role === 'user');
      const assistant = messages.find((message) => message.role === 'assistant');
      assert.ok(user && assistant);
      const selected = sendConversationMessage(db, {
        scope: target,
        messageId: randomUUID(),
        turnId: randomUUID(),
        input: {
          requestId: randomUUID(),
          content: 'Use these references',
          referenceIds: [user.id, assistant.id, saved.id],
        },
        now: Date.now(),
      });
      // Simulate a dead worker claim. Restart must interrupt it without any CLI launch.
      const claim = claimConversationTurn(db, { workerInstanceId: randomUUID(), now: Date.now() });
      assert.equal(claim.claimed, true);
      updateConversationNote(db, {
        scope: target,
        noteId: saved.id,
        input: { revision: 1, content: 'SOURCE_CHANGED_AFTER_SEND' },
        now: Date.now(),
      });
      deleteConversationNote(db, {
        scope: target,
        noteId: saved.id,
        input: { revision: 2 },
        now: Date.now(),
      });
      service = fixture.service();
      await service.start();
      try {
        assert.equal(await fixture.waitForTurn(selected.turn.id, ['interrupted']), 'interrupted');
        assert.equal(fixture.fakes[runtime].invocations().length, 1);
        const retry = retryConversationTurn(db, {
          scope: target,
          turnId: selected.turn.id,
          newTurnId: randomUUID(),
          input: { requestId: randomUUID() },
          now: Date.now(),
        });
        assert.equal(retry.turn.referencesJson, selected.turn.referencesJson);
        assert.equal(
          await fixture.waitForTurn(retry.turn.id, ['completed', 'failed']),
          'completed',
        );
        const prompt = fixture.fakes[runtime].invocations().at(-1)?.stdin ?? '';
        assert.match(prompt, /<explicit_references trust="untrusted">/);
        assert.match(prompt, /EXPLICIT_PRIVATE_NOTE/);
        assert.doesNotMatch(prompt, /UNSELECTED_SECRET_NOTE|SOURCE_CHANGED_AFTER_SEND/);
        const snapshots = JSON.parse(
          prompt
            .split('<explicit_references trust="untrusted">\n')[1]
            ?.split('\n</explicit_references>')[0] ?? '[]',
        );
        assert.deepEqual(
          snapshots.map((item: { sourceId: string }) => item.sourceId),
          [user.id, assistant.id, saved.id],
        );
        const manifest = JSON.parse(
          findConversationTurn(db, retry.turn.id)?.contextManifestJson ?? '{}',
        );
        assert.equal(manifest.notesExcluded, 1);
      } finally {
        await service.stop();
      }
      assert.deepEqual(snapshotTree(fixture.repository.root), before);
      for (const table of ['tasks', 'task_runs', 'worker_commands', 'workspaces', 'publications'])
        assert.equal(connection.sqlite.prepare(`SELECT count(*) FROM ${table}`).pluck().get(), 0);
    });
  });
}
