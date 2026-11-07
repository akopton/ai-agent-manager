import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { test } from 'node:test';
import { taskProposalLanguageInstructions } from '@ai-agent-manager/core';
import {
  addConversationNote,
  findTaskProposalGenerationById,
  listConversationMessages,
  listTaskProposals,
  requestTaskProposalGenerationStop,
  requestTaskProposals,
} from '@ai-agent-manager/database';
import { git, snapshotTree } from './execution-fixtures.js';
import { reply, scope, withFixture, type Fixture, type Step } from './conversation-fixtures.js';

// C3 — the worker generates task proposals only for explicit requests, through the same
// conversation gate, launch boundary and launch profiles as C2 chat turns. Fake CLIs, a disposable
// repository and a temporary database; no real CLI runs. Proposals are validated drafts; nothing
// creates, queues or starts a task, creates a worktree or touches the repository.

const document = (proposals: unknown[], note?: string): string =>
  JSON.stringify({ proposals, ...(note === undefined ? {} : { note }) });

const twoProposals = document(
  [
    {
      title: 'Add login rate limiting',
      prompt: 'Implement rate limiting for POST /login. Add tests.',
      priority: 'high',
      rationale: 'Ochrona przed brute force.',
    },
    {
      title: 'Document the auth module',
      prompt: 'Write docs/auth.md describing the flows.',
      dependencies: 'Po pierwszym zadaniu.',
    },
  ],
  'Dwa zadania.',
);

/** The latest AI reply of the conversation, the default source of a request. */
const latestReplyId = (fixture: Fixture, conversationId: string): string => {
  const reply = (listConversationMessages(fixture.db, scope(fixture, conversationId)) ?? [])
    .filter((message) => message.role === 'assistant')
    .at(-1);
  assert.ok(reply !== undefined);
  return reply.id;
};

const requestProposals = (
  fixture: Fixture,
  conversationId: string,
  instructions = '',
  sourceMessageId = latestReplyId(fixture, conversationId),
): { generationId: string } => {
  const { generation } = requestTaskProposals(fixture.db, {
    scope: scope(fixture, conversationId),
    generationId: randomUUID(),
    input: { requestId: randomUUID(), sourceMessageId, instructions },
    now: Date.now(),
  });
  return { generationId: generation.id };
};

const waitForGeneration = async (
  fixture: Fixture,
  generationId: string,
  statuses: string[],
): Promise<string> => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const status = findTaskProposalGenerationById(fixture.db, generationId)?.status;
    if (status !== undefined && statuses.includes(status)) return status;
    if (Date.now() > deadline) {
      throw new Error(
        `Generation ${generationId} did not reach ${statuses.join('/')} (now ${status}).\n${fixture.logger.messages.join('\n')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const count = (fixture: Fixture, table: string): number =>
  (fixture.connection.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
    .n;

/** One answered chat exchange; returns the AI reply's message ID (a possible task source). */
const discuss = async (
  fixture: Fixture,
  conversationId: string,
  runtime: 'claude' | 'codex',
  question = 'Jak zabezpieczyć logowanie?',
  answer = 'Podzielmy to na limitowanie i dokumentację.',
): Promise<string> => {
  fixture.fakes[runtime].setSteps(reply[runtime](answer));
  const { turnId } = fixture.send(conversationId, question);
  assert.equal(await fixture.waitForTurn(turnId, ['completed', 'failed']), 'completed');
  return latestReplyId(fixture, conversationId);
};

test('Claude: an explicit request stores validated drafts and changes nothing else', async () => {
  await withFixture(async (fixture) => {
    const repositoryBefore = snapshotTree(fixture.repository.root);
    const conversationId = fixture.conversation('claude', { modelId: 'opus' });
    const service = fixture.service();
    await service.start();
    try {
      await discuss(fixture, conversationId, 'claude', 'Earlier question?', 'Earlier reply.');
      const sourceId = await discuss(fixture, conversationId, 'claude');
      addConversationNote(fixture.db, {
        scope: scope(fixture, conversationId),
        id: randomUUID(),
        input: { requestId: randomUUID(), content: 'Private note, never sent.' },
        now: Date.now(),
      });
      // Ordinary chat never produces proposals by itself.
      assert.equal(count(fixture, 'task_proposal_generations'), 0);
      assert.equal(count(fixture, 'task_proposals'), 0);
      await discuss(fixture, conversationId, 'claude', 'Later question?', 'Later reply.');
      const historyBefore = listConversationMessages(fixture.db, scope(fixture, conversationId));

      fixture.fakes.claude.setSteps(reply.claude(twoProposals));
      // C3.1: generated from the middle reply, explicitly selected.
      const { generationId } = requestProposals(
        fixture,
        conversationId,
        'Tylko backend.',
        sourceId,
      );
      assert.equal(
        await waitForGeneration(fixture, generationId, ['completed', 'failed']),
        'completed',
      );
      const generation = findTaskProposalGenerationById(fixture.db, generationId);
      assert.equal(generation?.proposalCount, 2);
      assert.equal(generation?.skippedCount, 0);
      assert.equal(generation?.outputNote, 'Dwa zadania.');
      assert.equal(generation?.launchProfileId, 'claude-conversation-no-tools');
      assert.equal(generation?.effectiveModelId, 'claude-opus-5-5');
      assert.equal(generation?.securityMode, 'trusted_local');

      const proposals = listTaskProposals(fixture.db, scope(fixture, conversationId)) ?? [];
      assert.deepEqual(
        proposals.map(
          ({ position, status, title, priority, agentRuntime, modelId, baseBranch }) => [
            position,
            status,
            title,
            priority,
            agentRuntime,
            modelId,
            baseBranch,
          ],
        ),
        [
          [1, 'draft', 'Add login rate limiting', 'high', 'claude', 'opus', null],
          [2, 'draft', 'Document the auth module', 'normal', 'claude', 'opus', null],
        ],
      );
      assert.equal(proposals[0]?.rationale, 'Ochrona przed brute force.');
      assert.equal(proposals[1]?.dependencies, 'Po pierwszym zadaniu.');

      // The prompt: conversation history, contract, English titles/prompts, focus; no notes.
      const invocation = fixture.fakes.claude.invocations().at(-1);
      assert.ok(invocation !== undefined);
      assert.match(invocation.stdin, /<output_contract>/);
      assert.ok(invocation.stdin.includes(taskProposalLanguageInstructions.pl_technical_en));
      // C3.1: exactly the selected reply; no other reply, user message, note or history.
      assert.ok(
        invocation.stdin.includes(
          '<source_response>\nPodzielmy to na limitowanie i dokumentację.\n</source_response>',
        ),
      );
      for (const excluded of [
        'Jak zabezpieczyć logowanie',
        'Earlier question',
        'Earlier reply',
        'Later question',
        'Later reply',
        '<conversation_history>',
        '<message role=',
      ]) {
        assert.ok(!invocation.stdin.includes(excluded), excluded);
      }
      assert.equal(generation?.sourceMessageId, sourceId);
      assert.ok(proposals.every((proposal) => proposal.generationId === generationId));
      assert.ok(
        invocation.stdin.endsWith('<developer_request>\nTylko backend.\n</developer_request>'),
      );
      assert.ok(!invocation.stdin.includes('Private note'));
      assert.ok(!invocation.stdin.includes(fixture.repository.root));
      // Same conversation profile as chat: tools disabled, scratch directory outside the repo.
      assert.deepEqual(invocation.args.slice(0, 7), [
        '--print',
        '--restricted',
        '--strict-mcp-config',
        '--permission-prompts',
        'none',
        '--tools',
        '',
      ]);
      assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'opus');
      assert.ok(invocation.cwd.startsWith(realpathSync(fixture.scratchRoot)));
      assert.deepEqual(readdirSync(fixture.scratchRoot), []);

      // History, repository, tasks and execution state are untouched.
      assert.deepEqual(
        listConversationMessages(fixture.db, scope(fixture, conversationId)),
        historyBefore,
      );
      for (const table of ['tasks', 'task_runs', 'worker_commands', 'workspaces', 'publications']) {
        assert.equal(count(fixture, table), 0, table);
      }
    } finally {
      await service.stop();
    }
    assert.deepEqual(snapshotTree(fixture.repository.root), repositoryBefore);
    assert.equal(git(fixture.repository.root, 'status', '--porcelain'), '');
    assert.equal(git(fixture.repository.root, 'branch', '--list').trim(), '* main');
  });
});

test('Codex: one fenced proposal in English mode, read-only conversation profile', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('codex', {
      modelId: 'gpt-6.1-sol',
      languageMode: 'en',
    });
    const service = fixture.service();
    await service.start();
    try {
      await discuss(fixture, conversationId, 'codex');
      fixture.fakes.codex.setSteps(
        reply.codex(
          `Here is the document:\n\n\`\`\`json\n${document([{ title: 'Add tests', prompt: 'Add unit tests for auth.' }])}\n\`\`\``,
        ),
      );
      const { generationId } = requestProposals(fixture, conversationId);
      assert.equal(
        await waitForGeneration(fixture, generationId, ['completed', 'failed']),
        'completed',
      );
      const [proposal] = listTaskProposals(fixture.db, scope(fixture, conversationId)) ?? [];
      assert.equal(proposal?.title, 'Add tests');
      assert.equal(proposal?.agentRuntime, 'codex');
      assert.equal(proposal?.modelId, 'gpt-6.1-sol');
      const invocation = fixture.fakes.codex.invocations().at(-1);
      assert.deepEqual(invocation?.args.slice(0, 4), [
        'exec',
        '--sandbox',
        'read-only',
        '--ignore-user-config',
      ]);
      assert.ok(invocation?.stdin.includes(taskProposalLanguageInstructions.en));
      assert.equal(
        findTaskProposalGenerationById(fixture.db, generationId)?.launchProfileId,
        'codex-conversation-read-only',
      );
    } finally {
      await service.stop();
    }
  });
});

const outcomes: {
  name: string;
  steps: Step[];
  status: 'completed' | 'failed';
  code: string | null;
  proposals: number;
  skipped?: number;
  message?: RegExp;
}[] = [
  {
    name: 'malformed (prose) output',
    steps: reply.claude('I would split it into three tasks: auth, tests and docs.'),
    status: 'failed',
    code: 'malformed_output',
    proposals: 0,
    message: /not a single JSON proposal document/,
  },
  {
    name: 'truncated JSON',
    steps: reply.claude('{"proposals": [{"title": "Add rate limiting", "prompt": "Imp'),
    status: 'failed',
    code: 'malformed_output',
    proposals: 0,
    message: /not valid JSON/,
  },
  {
    name: 'partially valid items',
    steps: reply.claude(
      document([{ title: 'Valid', prompt: 'Do it.' }, { title: '', prompt: 'x' }, { prompt: 'y' }]),
    ),
    status: 'completed',
    code: null,
    proposals: 1,
    skipped: 2,
  },
  {
    name: 'no proposals with a note',
    steps: reply.claude(document([], 'Nothing concrete yet.')),
    status: 'completed',
    code: null,
    proposals: 0,
  },
  {
    name: 'a CLI without a login',
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
    status: 'failed',
    code: 'cli_auth_required',
    proposals: 0,
    message: /sign in/,
  },
  {
    name: 'an empty reply',
    steps: [{ stdout: { type: 'result', subtype: 'success', is_error: false } }],
    status: 'failed',
    code: 'empty_reply',
    proposals: 0,
    message: /No proposals were stored/,
  },
];

for (const outcome of outcomes) {
  test(`a generation with ${outcome.name} is recorded honestly`, async () => {
    await withFixture(async (fixture) => {
      const conversationId = fixture.conversation('claude');
      const service = fixture.service();
      await service.start();
      try {
        await discuss(fixture, conversationId, 'claude');
        fixture.fakes.claude.setSteps(outcome.steps);
        const { generationId } = requestProposals(fixture, conversationId);
        assert.equal(
          await waitForGeneration(fixture, generationId, ['completed', 'failed']),
          outcome.status,
        );
        const generation = findTaskProposalGenerationById(fixture.db, generationId);
        assert.equal(generation?.errorCode, outcome.code);
        if (outcome.message !== undefined) {
          assert.match(generation?.errorMessage ?? '', outcome.message);
        }
        assert.equal(generation?.proposalCount, outcome.proposals);
        assert.equal(generation?.skippedCount, outcome.skipped ?? 0);
        assert.equal(
          listTaskProposals(fixture.db, scope(fixture, conversationId))?.length,
          outcome.proposals,
        );
        assert.equal(count(fixture, 'tasks'), 0);
        // The conversation stays usable for chat afterwards.
        fixture.fakes.claude.setSteps(reply.claude('Still here.'));
        const next = fixture.send(conversationId, 'Next question');
        assert.equal(await fixture.waitForTurn(next.turnId, ['completed', 'failed']), 'completed');
      } finally {
        await service.stop();
      }
    });
  });
}

test('Stop terminates a running generation; nothing is stored', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('claude');
    const service = fixture.service();
    await service.start();
    try {
      await discuss(fixture, conversationId, 'claude');
      fixture.fakes.claude.setSteps([{ hang: true }]);
      const { generationId } = requestProposals(fixture, conversationId);
      const deadline = Date.now() + 10_000;
      while (findTaskProposalGenerationById(fixture.db, generationId)?.pid == null) {
        if (Date.now() > deadline) throw new Error(fixture.logger.messages.join('\n'));
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      requestTaskProposalGenerationStop(fixture.db, {
        scope: scope(fixture, conversationId),
        generationId,
        now: Date.now(),
      });
      assert.equal(
        await waitForGeneration(fixture, generationId, ['cancelled', 'failed', 'completed']),
        'cancelled',
      );
      const generation = findTaskProposalGenerationById(fixture.db, generationId);
      const pid = generation?.pid ?? null;
      assert.ok(pid !== null && pid > 0);
      assert.throws(() => process.kill(pid, 0));
      assert.match(generation?.errorMessage ?? '', /No proposals were stored/);
      assert.equal(count(fixture, 'task_proposals'), 0);
    } finally {
      await service.stop();
    }
  });
});

test('after a worker restart, an unfinished generation is interrupted and never relaunched', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('claude');
    const first = fixture.service({ workerInstanceId: 'worker-a' });
    await first.start();
    try {
      await discuss(fixture, conversationId, 'claude');
    } finally {
      await first.stop();
    }
    const invocationsBefore = fixture.fakes.claude.invocations().length;
    fixture.fakes.claude.setSteps(reply.claude(twoProposals));
    const { generationId } = requestProposals(fixture, conversationId);
    fixture.connection.sqlite
      .prepare(
        "UPDATE task_proposal_generations SET status = 'running', worker_instance_id = 'crashed-worker', pid = 999999, claimed_at = ?, started_at = ? WHERE id = ?",
      )
      .run(Date.now(), Date.now(), generationId);
    const service = fixture.service({ workerInstanceId: 'worker-b' });
    await service.start();
    try {
      const generation = findTaskProposalGenerationById(fixture.db, generationId);
      assert.equal(generation?.status, 'interrupted');
      assert.equal(generation?.errorCode, 'worker_restarted');
      assert.match(generation?.errorMessage ?? '', /not retried automatically/);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(fixture.fakes.claude.invocations().length, invocationsBefore);
      assert.equal(count(fixture, 'task_proposals'), 0);
    } finally {
      await service.stop();
    }
  });
});

test('a graceful worker shutdown interrupts a running generation without storing proposals', async () => {
  await withFixture(async (fixture) => {
    const conversationId = fixture.conversation('claude');
    const service = fixture.service();
    await service.start();
    let generationId = '';
    try {
      await discuss(fixture, conversationId, 'claude');
      fixture.fakes.claude.setSteps([{ hang: true }]);
      generationId = requestProposals(fixture, conversationId).generationId;
      const deadline = Date.now() + 10_000;
      while (findTaskProposalGenerationById(fixture.db, generationId)?.pid == null) {
        if (Date.now() > deadline) throw new Error(fixture.logger.messages.join('\n'));
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await service.stop();
    }
    const generation = findTaskProposalGenerationById(fixture.db, generationId);
    assert.equal(generation?.status, 'interrupted');
    assert.equal(generation?.errorCode, 'worker_shutdown');
    assert.equal(count(fixture, 'task_proposals'), 0);
  });
});
