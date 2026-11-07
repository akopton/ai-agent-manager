import assert from 'node:assert/strict';
import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  conversationLanguageInstructions,
  trustedLocalDisclosure,
  type AgentRuntime,
} from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  findConversationTurn,
  listConversationMessages,
  listConversationTurns,
  requestConversationTurnStop,
} from '@ai-agent-manager/database';
import { git, snapshotTree } from './execution-fixtures.js';
import { reply, scope, withFixture, type Step } from './conversation-fixtures.js';

// C2 — the worker runs conversation turns through the conversation gate and launch boundary with
// fake Claude/Codex CLIs, a disposable repository and a temporary database. No real CLI runs.

test('Claude: a multi-turn conversation carries history, language and model', async () => {
  await withFixture(async (fixture) => {
    const repositoryBefore = snapshotTree(fixture.repository.root);
    const conversationId = fixture.conversation('claude', { modelId: 'opus', languageMode: 'pl' });
    const service = fixture.service();
    await service.start();
    try {
      fixture.fakes.claude.setSteps(reply.claude('Pierwsza odpowiedź.'));
      const first = fixture.send(conversationId, 'Jak podzielić moduł auth?');
      assert.equal(await fixture.waitForTurn(first.turnId, ['completed', 'failed']), 'completed');
      fixture.fakes.claude.setSteps(reply.claude('Druga odpowiedź.'));
      const second = fixture.send(conversationId, 'A testy?');
      assert.equal(await fixture.waitForTurn(second.turnId, ['completed', 'failed']), 'completed');
    } finally {
      await service.stop();
    }
    const messages = listConversationMessages(fixture.db, scope(fixture, conversationId)) ?? [];
    assert.deepEqual(
      messages.map(({ role, kind, content }) => [role, kind, content]),
      [
        ['user', 'chat', 'Jak podzielić moduł auth?'],
        ['assistant', 'chat', 'Pierwsza odpowiedź.'],
        ['user', 'chat', 'A testy?'],
        ['assistant', 'chat', 'Druga odpowiedź.'],
      ],
    );
    const invocations = fixture.fakes.claude.invocations();
    assert.equal(invocations.length, 2);
    const [one, two] = invocations;
    assert.ok(one !== undefined && two !== undefined);
    // The second turn carries the first exchange; the language instruction is a separate section.
    assert.match(two.stdin, /<message role="user">\nJak podzielić moduł auth\?\n<\/message>/);
    assert.match(two.stdin, /<message role="assistant">\nPierwsza odpowiedź\.\n<\/message>/);
    assert.ok(
      two.stdin.includes(`<language>\n${conversationLanguageInstructions.pl}\n</language>`),
    );
    assert.ok(two.stdin.endsWith('<new_message role="user">\nA testy?\n</new_message>'));
    assert.ok(!one.stdin.includes('Project instructions are not sent'));
    // Conversation profile, model, scratch directory outside the repository, removed afterwards.
    assert.deepEqual(one.args.slice(0, 7), [
      '--print',
      '--restricted',
      '--strict-mcp-config',
      '--permission-prompts',
      'none',
      '--tools',
      '',
    ]);
    assert.ok(!one.args.includes('acceptEdits'));
    assert.equal(one.args[one.args.indexOf('--model') + 1], 'opus');
    assert.ok(one.cwd.startsWith(realpathSync(fixture.scratchRoot)));
    assert.ok(!one.cwd.startsWith(fixture.repository.root));
    assert.notEqual(one.cwd, two.cwd);
    assert.deepEqual(readdirSync(fixture.scratchRoot), []);
    const turns = listConversationTurns(fixture.db, scope(fixture, conversationId)) ?? [];
    assert.equal(turns[0]?.requestedModelId, 'opus');
    assert.equal(turns[0]?.effectiveModelId, 'claude-opus-5-5');
    assert.equal(turns[0]?.launchProfileId, 'claude-conversation-no-tools');
    assert.equal(turns[0]?.securityMode, 'trusted_local');
    const manifest = JSON.parse(turns[1]?.contextManifestJson ?? '{}') as {
      includedSequences: number[];
      languageMode: string;
    };
    assert.deepEqual(manifest.includedSequences, [1, 2]);
    assert.equal(manifest.languageMode, 'pl');
    // No repository, task, run or worker-command side effects; logs never contain the prompt.
    assert.deepEqual(snapshotTree(fixture.repository.root), repositoryBefore);
    assert.equal(git(fixture.repository.root, 'status', '--porcelain'), '');
    for (const table of ['tasks', 'task_runs', 'worker_commands', 'workspaces']) {
      const row = fixture.connection.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get();
      assert.deepEqual(row, { n: 0 }, table);
    }
    assert.ok(!fixture.logger.messages.some((message) => message.includes('moduł auth')));
  });
});

test('Codex: read-only conversation profile, model passed, no reported model', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('codex', {
      modelId: 'gpt-6.1-sol',
      languageMode: 'en',
    });
    fixture.fakes.codex.setSteps(reply.codex('Here is a plan.'));
    const service = fixture.service();
    await service.start();
    try {
      const { turnId } = fixture.send(conversationId, 'Plan the migration');
      assert.equal(await fixture.waitForTurn(turnId, ['completed', 'failed']), 'completed');
      const turn = findConversationTurn(fixture.db, turnId);
      assert.equal(turn?.effectiveModelId, null);
      assert.equal(turn?.launchProfileId, 'codex-conversation-read-only');
    } finally {
      await service.stop();
    }
    const [invocation] = fixture.fakes.codex.invocations();
    assert.deepEqual(invocation?.args, [
      'exec',
      '--sandbox',
      'read-only',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
      '--model',
      'gpt-6.1-sol',
      '-',
    ]);
    assert.ok(invocation?.stdin.includes(conversationLanguageInstructions.en));
  });
});

const failingCases: {
  name: string;
  runtime: AgentRuntime;
  steps: Step[];
  modelId?: string;
  code: string;
  message: RegExp;
}[] = [
  {
    name: 'Claude without a login',
    runtime: 'claude',
    steps: [
      {
        stdout: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
          error: 'authentication_failed',
        },
      },
      {
        stdout: {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'Not logged in · Please run /login',
        },
      },
      { exit: 1 },
    ],
    code: 'cli_auth_required',
    message: /sign in/,
  },
  {
    name: 'Codex with an expired login',
    runtime: 'codex',
    steps: [
      { stdout: { type: 'thread.started', thread_id: 't' } },
      {
        stdout: {
          type: 'turn.failed',
          error: { message: 'unexpected status 401 Unauthorized: Missing bearer' },
        },
      },
      { exit: 1 },
    ],
    code: 'cli_auth_required',
    message: /codex login/,
  },
  {
    name: 'Codex rejecting the model',
    runtime: 'codex',
    modelId: 'gpt-6-astra',
    steps: [
      {
        stdout: {
          type: 'turn.failed',
          error: { message: 'The model gpt-6-astra does not exist or you do not have access.' },
        },
      },
      { exit: 1 },
    ],
    code: 'model_unavailable',
    message: /Choose Default or another model/,
  },
  {
    name: 'Claude exiting successfully without a reply',
    runtime: 'claude',
    steps: [{ stdout: { type: 'result', subtype: 'success', is_error: false } }],
    code: 'empty_reply',
    message: /without a reply/,
  },
];

for (const failing of failingCases) {
  test(`${failing.name}: the turn fails visibly and no reply is stored`, async () => {
    await withFixture(async (fixture) => {
      const conversationId = fixture.conversation(failing.runtime, {
        modelId: failing.modelId ?? null,
      });
      fixture.fakes[failing.runtime].setSteps(failing.steps);
      const service = fixture.service();
      await service.start();
      try {
        const { turnId } = fixture.send(conversationId, 'Hello');
        assert.equal(await fixture.waitForTurn(turnId, ['completed', 'failed']), 'failed');
        const turn = findConversationTurn(fixture.db, turnId);
        assert.equal(turn?.errorCode, failing.code);
        assert.match(turn?.errorMessage ?? '', failing.message);
        assert.equal(turn?.assistantMessageId, null);
      } finally {
        await service.stop();
      }
      const messages = listConversationMessages(fixture.db, scope(fixture, conversationId)) ?? [];
      assert.deepEqual(
        messages.map(({ role }) => role),
        ['user'],
      );
    });
  });
}

test('a missing CLI fails with an actionable message without launching anything', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('claude');
    const service = fixture.service({
      detectionOptions: {
        claude: { executablePath: join(fixture.directory, 'missing', 'claude') },
      },
    });
    await service.start();
    try {
      const { turnId } = fixture.send(conversationId, 'Hello');
      assert.equal(await fixture.waitForTurn(turnId, ['completed', 'failed']), 'failed');
      const turn = findConversationTurn(fixture.db, turnId);
      assert.equal(turn?.errorCode, 'cli_unavailable');
      assert.match(turn?.errorMessage ?? '', /Install Claude Code/);
    } finally {
      await service.stop();
    }
  });
});

test('Stop terminates a running turn; it is cancelled without a reply', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('claude');
    fixture.fakes.claude.setSteps([{ hang: true }]);
    const service = fixture.service();
    await service.start();
    try {
      const { turnId } = fixture.send(conversationId, 'Long question');
      const deadline = Date.now() + 10_000;
      while (
        findConversationTurn(fixture.db, turnId)?.pid == null ||
        fixture.fakes.claude.invocations().length === 0
      ) {
        if (Date.now() > deadline) throw new Error(fixture.logger.messages.join('\n'));
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      requestConversationTurnStop(fixture.db, {
        scope: scope(fixture, conversationId),
        turnId,
        now: Date.now(),
      });
      assert.equal(await fixture.waitForTurn(turnId, ['cancelled', 'failed']), 'cancelled');
      const pid = findConversationTurn(fixture.db, turnId)?.pid ?? null;
      assert.ok(pid !== null && pid > 0);
      assert.equal(fixture.fakes.claude.invocations()[0]?.pid, pid);
      assert.throws(() => process.kill(pid, 0));
      assert.equal(findConversationTurn(fixture.db, turnId)?.assistantMessageId, null);
    } finally {
      await service.stop();
    }
  });
});

test('a turn that exceeds its timeout fails without a reply', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('codex');
    fixture.fakes.codex.setSteps([{ hang: true }]);
    const service = fixture.service({ conversationTurnTimeoutMs: 400 });
    await service.start();
    try {
      const { turnId } = fixture.send(conversationId, 'Hello');
      assert.equal(await fixture.waitForTurn(turnId, ['failed', 'completed']), 'failed');
      assert.equal(findConversationTurn(fixture.db, turnId)?.errorCode, 'timeout');
    } finally {
      await service.stop();
    }
  });
});

test('after a worker restart, an unfinished turn is interrupted and never relaunched', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('claude');
    fixture.fakes.claude.setSteps(reply.claude('Should never run'));
    const { turnId } = fixture.send(conversationId, 'Hello');
    // As a crashed worker leaves it: claimed and running, with a recorded PID.
    fixture.connection.sqlite
      .prepare(
        "UPDATE conversation_turns SET status = 'running', worker_instance_id = 'crashed-worker', pid = 999999, claimed_at = ?, started_at = ? WHERE id = ?",
      )
      .run(Date.now(), Date.now(), turnId);
    const service = fixture.service({ workerInstanceId: 'worker-b' });
    await service.start();
    try {
      const turn = findConversationTurn(fixture.db, turnId);
      assert.equal(turn?.status, 'interrupted');
      assert.equal(turn?.errorCode, 'worker_restarted');
      assert.match(turn?.errorMessage ?? '', /not retried automatically/);
      assert.match(turn?.errorMessage ?? '', /was not signalled/);
      assert.equal(turn?.assistantMessageId, null);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(fixture.fakes.claude.invocations().length, 0);
      // A new message in the same conversation works normally afterwards.
      const next = fixture.send(conversationId, 'Again');
      assert.equal(await fixture.waitForTurn(next.turnId, ['completed', 'failed']), 'completed');
    } finally {
      await service.stop();
    }
  });
});

test('no turn starts without the AI Conversations acceptance, even with execution consent', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('claude');
    const { turnId } = fixture.send(conversationId, 'Hello');
    // Replace consent: execution consent only.
    fixture.connection.sqlite.prepare('DELETE FROM conversation_settings').run();
    acceptTrustedLocal(fixture.db, {
      input: {
        disclosureVersion: trustedLocalDisclosure.version,
        acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
      },
      now: Date.now() - 1_000,
    });
    const service = fixture.service();
    await service.start();
    try {
      assert.equal(await fixture.waitForTurn(turnId, ['failed', 'completed']), 'failed');
      assert.equal(findConversationTurn(fixture.db, turnId)?.errorCode, 'conversation_ai_disabled');
      assert.equal(fixture.fakes.claude.invocations().length, 0);
    } finally {
      await service.stop();
    }
  });
});

test('without a scratch root the worker processes no conversation turns', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('claude');
    fixture.fakes.claude.setSteps(reply.claude('Hi'));
    const service = fixture.service({ conversationScratchRoot: undefined });
    await service.start();
    try {
      const { turnId } = fixture.send(conversationId, 'Hello');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(findConversationTurn(fixture.db, turnId)?.status, 'queued');
      assert.equal(fixture.fakes.claude.invocations().length, 0);
    } finally {
      await service.stop();
    }
  });
});
