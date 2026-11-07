import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConversationError,
  conversationDisclosure,
  TaskError,
  type ConversationErrorCode,
  type ParsedTaskProposal,
} from '@ai-agent-manager/core';
import { sql } from 'drizzle-orm';
import {
  acceptConversationDisclosure,
  addConversationNote,
  applyMigrations,
  approveTaskProposal,
  claimConversationTurn,
  claimTaskProposalGeneration,
  createConversation,
  createDatabase,
  disableConversationAi,
  expireQueuedTaskProposalGenerations,
  findTaskById,
  findTaskProposalByTask,
  finishConversationTurn,
  finishTaskProposalGeneration,
  insertProject,
  listConversationMessages,
  listTaskProposalGenerations,
  listTaskProposals,
  rejectTaskProposal,
  reopenTaskProposal,
  requestTaskProposalGenerationStop,
  requestTaskProposals,
  retryTaskProposalGeneration,
  sendConversationMessage,
  taskProposals,
  updateConversation,
  updateTaskProposal,
  type DatabaseConnection,
} from '../src/index.js';

// C3 — task proposal persistence: explicit, idempotent generation requests; one active AI request
// per conversation; shared conversation slots; drafts only from completed generations, stored
// exactly once; revision-guarded edits; reject/reopen; and atomic, idempotent approval into
// exactly one Backlog task. No process is started here.

const projectA = '00000000-0000-4000-8000-00000000000a';
const projectB = '00000000-0000-4000-8000-00000000000b';
const conversationA = '00000000-0000-4000-8000-000000000101';
const conversationB = '00000000-0000-4000-8000-000000000102';
const scopeA = { projectId: projectA, conversationId: conversationA };
const scopeB = { projectId: projectB, conversationId: conversationB };

type Db = DatabaseConnection['db'];

const withDatabase = (run: (db: Db, connection: DatabaseConnection) => void): void => {
  latestReply.clear();
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-proposals-'));
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
    acceptConversationDisclosure(connection.db, {
      input: { disclosureVersion: conversationDisclosure.version },
      now: 2_000,
    });
    run(connection.db, connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

const throwsCode = (run: () => unknown, code: ConversationErrorCode): void => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ConversationError, String(error));
    assert.equal(error.code, code);
    return true;
  });
};

const count = (db: Db, table: string): number =>
  (db.get(sql.raw(`SELECT count(*) AS n FROM ${table}`)) as { n: number }).n;

/** The latest AI reply per conversation, the default source of `request`. */
const latestReply = new Map<string, string>();

/** One answered exchange, as the worker would store it. Returns the reply's message ID. */
const answer = (
  db: Db,
  scope = scopeA,
  content = 'How do we split auth?',
  reply = 'In three parts.',
): string => {
  const { turn } = sendConversationMessage(db, {
    scope,
    messageId: randomUUID(),
    turnId: randomUUID(),
    input: { requestId: randomUUID(), content },
    now: 3_000,
  });
  const claim = claimConversationTurn(db, { workerInstanceId: 'w', now: 3_001 });
  assert.ok(claim.claimed);
  const finished = finishConversationTurn(
    db,
    turn.id,
    {
      status: 'completed',
      reply,
      effectiveModelId: null,
      exitCode: 0,
      endedAt: 3_002,
    },
    { createMessageId: randomUUID },
  );
  const replyId = finished?.assistantMessageId;
  assert.ok(typeof replyId === 'string');
  latestReply.set(scope.conversationId, replyId);
  return replyId;
};

const request = (
  db: Db,
  scope = scopeA,
  requestId = randomUUID(),
  instructions?: string,
  sourceMessageId = latestReply.get(scope.conversationId) ?? randomUUID(),
) =>
  requestTaskProposals(db, {
    scope,
    generationId: randomUUID(),
    input: { requestId, sourceMessageId, ...(instructions === undefined ? {} : { instructions }) },
    now: 4_000,
  });

const parsed = (n: number, extra: Partial<ParsedTaskProposal> = {}): ParsedTaskProposal => ({
  title: `Task ${n}`,
  prompt: `Implement part ${n}.`,
  priority: 'normal',
  rationale: '',
  dependencies: '',
  ...extra,
});

/** Requests, claims and completes a generation with the given proposals. */
const generate = (db: Db, proposals: ParsedTaskProposal[], scope = scopeA) => {
  const { generation } = request(db, scope);
  const claim = claimTaskProposalGeneration(db, { workerInstanceId: 'w', now: 4_001 });
  assert.ok(claim.claimed);
  const finished = finishTaskProposalGeneration(
    db,
    generation.id,
    {
      status: 'completed',
      proposals,
      skippedCount: 0,
      note: '',
      effectiveModelId: null,
      exitCode: 0,
      endedAt: 4_002,
    },
    { createProposalId: randomUUID },
  );
  assert.equal(finished?.status, 'completed');
  return generation;
};

test('a proposal request needs consent and an answered exchange, and is idempotent', () => {
  withDatabase((db) => {
    disableConversationAi(db, { now: 2_500 });
    throwsCode(() => request(db), 'conversation_ai_disabled');
    acceptConversationDisclosure(db, {
      input: { disclosureVersion: conversationDisclosure.version },
      now: 2_600,
    });
    addConversationNote(db, {
      scope: scopeA,
      id: randomUUID(),
      input: { requestId: randomUUID(), content: 'A note is not an answered exchange.' },
      now: 2_700,
    });
    // C3.1: a note is not a source, and a request must name an existing reply.
    const [note] = listConversationMessages(db, scopeA) ?? [];
    assert.ok(note !== undefined);
    throwsCode(
      () => request(db, scopeA, randomUUID(), undefined, note.id),
      'task_proposal_source_invalid',
    );
    throwsCode(() => request(db), 'task_proposal_source_not_found');
    answer(db);

    const requestId = randomUUID();
    const first = request(db, scopeA, requestId, 'Backend only');
    assert.equal(first.created, true);
    assert.equal(first.generation.status, 'queued');
    assert.equal(first.generation.agentRuntime, 'claude');
    assert.equal(first.generation.requestedModelId, 'opus');
    assert.equal(first.generation.languageMode, 'pl_technical_en');
    assert.equal(first.generation.instructions, 'Backend only');
    // The source reply (sequence 3) and its snapshot are recorded.
    assert.equal(first.generation.basedOnSequence, 3);
    assert.equal(first.generation.sourceMessageId, latestReply.get(conversationA));
    assert.equal(first.generation.sourceContent, 'In three parts.');

    const repeat = request(db, scopeA, requestId, 'Backend only');
    assert.equal(repeat.created, false);
    assert.equal(repeat.generation.id, first.generation.id);
    throwsCode(
      () => request(db, scopeA, requestId, 'Other focus'),
      'conversation_request_conflict',
    );
    // One active AI request per conversation: no second generation and no chat meanwhile.
    throwsCode(() => request(db), 'conversation_turn_active');
    throwsCode(
      () =>
        sendConversationMessage(db, {
          scope: scopeA,
          messageId: randomUUID(),
          turnId: randomUUID(),
          input: { requestId: randomUUID(), content: 'More?' },
          now: 4_100,
        }),
      'conversation_turn_active',
    );
    // Notes do not affect a generation (it is based on a fixed sequence) and stay allowed.
    addConversationNote(db, {
      scope: scopeA,
      id: randomUUID(),
      input: { requestId: randomUUID(), content: 'Note while generating.' },
      now: 4_200,
    });
    assert.equal(count(db, 'task_proposal_generations'), 1);
    assert.equal(count(db, 'tasks'), 0);
  });
});

test('requests are scoped to their project and conversation', () => {
  withDatabase((db) => {
    answer(db);
    throwsCode(
      () => request(db, { projectId: projectB, conversationId: conversationA }),
      'conversation_not_found',
    );
    const { generation } = request(db);
    throwsCode(
      () =>
        requestTaskProposalGenerationStop(db, {
          scope: scopeB,
          generationId: generation.id,
          now: 1,
        }),
      'task_proposal_generation_not_found',
    );
    assert.equal(listTaskProposalGenerations(db, scopeB)?.length, 0);
    assert.equal(
      listTaskProposalGenerations(db, { projectId: projectB, conversationId: conversationA }),
      undefined,
    );
  });
});

test('a completed generation stores drafts exactly once, in order, without touching history', () => {
  withDatabase((db) => {
    answer(db);
    const before = listConversationMessages(db, scopeA);
    const generation = generate(db, [parsed(1, { priority: 'high', rationale: 'Why' }), parsed(2)]);
    // A late or repeated finish writes nothing.
    assert.equal(
      finishTaskProposalGeneration(
        db,
        generation.id,
        {
          status: 'completed',
          proposals: [parsed(9)],
          skippedCount: 0,
          note: '',
          effectiveModelId: null,
          exitCode: 0,
          endedAt: 5_000,
        },
        { createProposalId: randomUUID },
      ),
      undefined,
    );
    const proposals = listTaskProposals(db, scopeA) ?? [];
    assert.deepEqual(
      proposals.map(({ position, title, status, priority, agentRuntime, modelId, baseBranch }) => [
        position,
        title,
        status,
        priority,
        agentRuntime,
        modelId,
        baseBranch,
      ]),
      [
        [1, 'Task 1', 'draft', 'high', 'claude', 'opus', null],
        [2, 'Task 2', 'draft', 'normal', 'claude', 'opus', null],
      ],
    );
    assert.equal(proposals[0]?.projectId, projectA);
    assert.equal(proposals[0]?.rationale, 'Why');
    assert.equal(proposals[0]?.suggestedTitle, 'Task 1');
    assert.deepEqual(listConversationMessages(db, scopeA), before);
    assert.equal(listTaskProposals(db, scopeB)?.length, 0);
    assert.equal(count(db, 'tasks'), 0);
    assert.equal(count(db, 'worker_commands'), 0);
  });
});

test('failed, stopped and interrupted generations store no proposals; retry is explicit', () => {
  withDatabase((db) => {
    answer(db);
    // Queued Stop cancels at once.
    const queued = request(db).generation;
    const cancelled = requestTaskProposalGenerationStop(db, {
      scope: scopeA,
      generationId: queued.id,
      now: 4_100,
    });
    assert.equal(cancelled.status, 'cancelled');
    throwsCode(
      () =>
        retryTaskProposalGeneration(db, {
          scope: scopeA,
          generationId: randomUUID(),
          newGenerationId: randomUUID(),
          input: { requestId: randomUUID() },
          now: 4_150,
        }),
      'task_proposal_generation_not_found',
    );

    const retryRequest = randomUUID();
    const retried = retryTaskProposalGeneration(db, {
      scope: scopeA,
      generationId: queued.id,
      newGenerationId: randomUUID(),
      input: { requestId: retryRequest },
      now: 4_200,
    });
    assert.equal(retried.created, true);
    assert.equal(retried.generation.retryOfGenerationId, queued.id);
    const repeated = retryTaskProposalGeneration(db, {
      scope: scopeA,
      generationId: queued.id,
      newGenerationId: randomUUID(),
      input: { requestId: retryRequest },
      now: 4_210,
    });
    assert.equal(repeated.created, false);
    assert.equal(repeated.generation.id, retried.generation.id);

    // Running Stop → stopping; the worker records cancelled.
    assert.ok(claimTaskProposalGeneration(db, { workerInstanceId: 'w', now: 4_300 }).claimed);
    assert.equal(
      requestTaskProposalGenerationStop(db, {
        scope: scopeA,
        generationId: retried.generation.id,
        now: 4_400,
      }).status,
      'stopping',
    );
    finishTaskProposalGeneration(
      db,
      retried.generation.id,
      {
        status: 'cancelled',
        errorCode: null,
        errorMessage: 'Stopped by you. No proposals were stored.',
        exitCode: null,
        signal: 'SIGTERM',
        effectiveModelId: null,
        endedAt: 4_500,
      },
      { createProposalId: randomUUID },
    );
    // Stop of a cancelled generation is harmless.
    assert.equal(
      requestTaskProposalGenerationStop(db, {
        scope: scopeA,
        generationId: retried.generation.id,
        now: 4_600,
      }).status,
      'cancelled',
    );
    // Only the latest one is retryable.
    throwsCode(
      () =>
        retryTaskProposalGeneration(db, {
          scope: scopeA,
          generationId: queued.id,
          newGenerationId: randomUUID(),
          input: { requestId: randomUUID() },
          now: 4_700,
        }),
      'task_proposal_generation_not_retryable',
    );

    // A failed (malformed) generation, then an expired queued one.
    const malformed = retryTaskProposalGeneration(db, {
      scope: scopeA,
      generationId: retried.generation.id,
      newGenerationId: randomUUID(),
      input: { requestId: randomUUID() },
      now: 4_800,
    }).generation;
    assert.ok(claimTaskProposalGeneration(db, { workerInstanceId: 'w', now: 4_900 }).claimed);
    finishTaskProposalGeneration(
      db,
      malformed.id,
      {
        status: 'failed',
        errorCode: 'malformed_output',
        errorMessage: 'Not JSON.',
        exitCode: 0,
        signal: null,
        effectiveModelId: null,
        endedAt: 5_000,
      },
      { createProposalId: randomUUID },
    );
    throwsCode(
      () =>
        requestTaskProposalGenerationStop(db, {
          scope: scopeA,
          generationId: malformed.id,
          now: 5_050,
        }),
      'task_proposal_generation_not_active',
    );
    const stale = retryTaskProposalGeneration(db, {
      scope: scopeA,
      generationId: malformed.id,
      newGenerationId: randomUUID(),
      input: { requestId: randomUUID() },
      now: 5_100,
    }).generation;
    assert.equal(expireQueuedTaskProposalGenerations(db, { olderThan: 6_000, now: 6_000 }), 1);
    const statuses = (listTaskProposalGenerations(db, scopeA) ?? []).map(
      ({ id, status, errorCode }) => [id, status, errorCode],
    );
    assert.deepEqual(statuses.at(-1), [stale.id, 'failed', 'request_expired']);
    assert.equal(count(db, 'task_proposals'), 0);
  });
});

test('without consent at claim time, queued generations fail instead of starting', () => {
  withDatabase((db) => {
    answer(db);
    const { generation } = request(db);
    disableConversationAi(db, { now: 4_500 });
    assert.equal(
      claimTaskProposalGeneration(db, { workerInstanceId: 'w', now: 4_600 }).claimed,
      false,
    );
    const [stored] = listTaskProposalGenerations(db, scopeA) ?? [];
    assert.equal(stored?.id, generation.id);
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.errorCode, 'conversation_ai_disabled');
  });
});

test('chat turns and generations share one conversation slot per CLI', () => {
  withDatabase((db) => {
    answer(db);
    answer(db, scopeB, 'Codex question');
    // A Claude generation runs …
    request(db);
    assert.ok(claimTaskProposalGeneration(db, { workerInstanceId: 'w', now: 4_100 }).claimed);
    // … so a Claude chat turn of another conversation waits, while Codex work proceeds.
    const other = '00000000-0000-4000-8000-000000000103';
    createConversation(db, {
      id: other,
      input: { projectId: projectA, title: 'Second', agentRuntime: 'claude' },
      now: 4_150,
    });
    sendConversationMessage(db, {
      scope: { projectId: projectA, conversationId: other },
      messageId: randomUUID(),
      turnId: randomUUID(),
      input: { requestId: randomUUID(), content: 'Waiting' },
      now: 4_200,
    });
    assert.equal(claimConversationTurn(db, { workerInstanceId: 'w', now: 4_300 }).claimed, false);
    request(db, scopeB);
    const codex = claimTaskProposalGeneration(db, { workerInstanceId: 'w', now: 4_400 });
    assert.ok(codex.claimed);
    assert.equal(codex.claim.generation.agentRuntime, 'codex');
    // C3.1: the claim carries only the source reply's snapshot, no history.
    assert.deepEqual(codex.claim.history, []);
    assert.equal(codex.claim.generation.sourceContent, 'In three parts.');
  });
});

test('drafts are edited with a revision; approved and rejected ones are protected', () => {
  withDatabase((db) => {
    answer(db);
    generate(db, [parsed(1), parsed(2)]);
    const [first, second] = listTaskProposals(db, scopeA) ?? [];
    assert.ok(first !== undefined && second !== undefined);

    const edited = updateTaskProposal(db, {
      scope: scopeA,
      proposalId: first.id,
      input: { revision: 1, title: 'Edited title', priority: 'critical', baseBranch: 'develop' },
      now: 5_000,
    });
    assert.equal(edited.revision, 2);
    assert.equal(edited.title, 'Edited title');
    assert.equal(edited.suggestedTitle, 'Task 1');
    assert.equal(edited.baseBranch, 'develop');
    // Stale revision: never overwrites newer edits.
    throwsCode(
      () =>
        updateTaskProposal(db, {
          scope: scopeA,
          proposalId: first.id,
          input: { revision: 1, title: 'Old' },
          now: 5_100,
        }),
      'task_proposal_changed',
    );
    // Runtime switch resets the model; a model of the other runtime is refused.
    const switched = updateTaskProposal(db, {
      scope: scopeA,
      proposalId: first.id,
      input: { revision: 2, agentRuntime: 'codex' },
      now: 5_200,
    });
    assert.equal(switched.agentRuntime, 'codex');
    assert.equal(switched.modelId, null);
    throwsCode(
      () =>
        updateTaskProposal(db, {
          scope: scopeA,
          proposalId: first.id,
          input: { revision: 3, modelId: 'opus' },
          now: 5_300,
        }),
      'invalid_conversation_input',
    );
    throwsCode(
      () =>
        updateTaskProposal(db, {
          scope: scopeA,
          proposalId: first.id,
          input: { revision: 3, priority: 'urgent' as never },
          now: 5_300,
        }),
      'invalid_conversation_input',
    );
    // Cross-project access is reported as missing.
    throwsCode(
      () =>
        updateTaskProposal(db, {
          scope: { projectId: projectB, conversationId: conversationA },
          proposalId: first.id,
          input: { revision: 3, title: 'x' },
          now: 5_400,
        }),
      'conversation_not_found',
    );
    throwsCode(
      () =>
        updateTaskProposal(db, {
          scope: scopeB,
          proposalId: first.id,
          input: { revision: 3, title: 'x' },
          now: 5_400,
        }),
      'task_proposal_not_found',
    );

    // Reject → cannot edit or approve; reopen → draft again.
    const rejected = rejectTaskProposal(db, {
      scope: scopeA,
      proposalId: second.id,
      input: { revision: 1 },
      now: 5_500,
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(
      rejectTaskProposal(db, {
        scope: scopeA,
        proposalId: second.id,
        input: { revision: 1 },
        now: 5_510,
      }).revision,
      2,
    );
    throwsCode(
      () =>
        updateTaskProposal(db, {
          scope: scopeA,
          proposalId: second.id,
          input: { revision: 2, title: 'x' },
          now: 5_600,
        }),
      'task_proposal_not_editable',
    );
    throwsCode(
      () =>
        approveTaskProposal(db, {
          scope: scopeA,
          proposalId: second.id,
          taskId: randomUUID(),
          input: { revision: 2 },
          now: 5_600,
        }),
      'task_proposal_not_editable',
    );
    const reopened = reopenTaskProposal(db, {
      scope: scopeA,
      proposalId: second.id,
      input: { revision: 2 },
      now: 5_700,
    });
    assert.equal(reopened.status, 'draft');
    assert.equal(reopened.rejectedAt, null);
    assert.equal(count(db, 'tasks'), 0);
  });
});

test('approval creates exactly one Backlog task with the edited values, atomically and idempotently', () => {
  withDatabase((db) => {
    answer(db);
    generate(db, [parsed(1)]);
    const [proposal] = listTaskProposals(db, scopeA) ?? [];
    assert.ok(proposal !== undefined);
    const edited = updateTaskProposal(db, {
      scope: scopeA,
      proposalId: proposal.id,
      input: {
        revision: 1,
        title: 'Approved title',
        prompt: 'Approved prompt',
        agentRuntime: 'codex',
        modelId: 'gpt-6.1-sol',
        priority: 'high',
      },
      now: 5_000,
    });
    // A stale revision is refused and creates nothing.
    throwsCode(
      () =>
        approveTaskProposal(db, {
          scope: scopeA,
          proposalId: proposal.id,
          taskId: randomUUID(),
          input: { revision: 1 },
          now: 5_100,
        }),
      'task_proposal_changed',
    );
    // Cross-project approval is refused.
    throwsCode(
      () =>
        approveTaskProposal(db, {
          scope: { projectId: projectB, conversationId: conversationA },
          proposalId: proposal.id,
          taskId: randomUUID(),
          input: { revision: 2 },
          now: 5_100,
        }),
      'conversation_not_found',
    );
    assert.equal(count(db, 'tasks'), 0);

    const taskId = randomUUID();
    const approved = approveTaskProposal(db, {
      scope: scopeA,
      proposalId: proposal.id,
      taskId,
      input: { revision: edited.revision },
      now: 5_200,
    });
    assert.equal(approved.created, true);
    assert.equal(approved.task.id, taskId);
    assert.deepEqual(
      {
        projectId: approved.task.projectId,
        title: approved.task.title,
        prompt: approved.task.prompt,
        agentRuntime: approved.task.agentRuntime,
        modelId: approved.task.modelId,
        priority: approved.task.priority,
        baseBranch: approved.task.baseBranch,
        urgent: approved.task.urgent,
        status: approved.task.status,
        queuedAt: approved.task.queuedAt,
      },
      {
        projectId: projectA,
        title: 'Approved title',
        prompt: 'Approved prompt',
        agentRuntime: 'codex',
        modelId: 'gpt-6.1-sol',
        priority: 'high',
        baseBranch: null,
        urgent: false,
        status: 'backlog',
        queuedAt: null,
      },
    );
    assert.equal(approved.proposal.status, 'approved');
    assert.equal(approved.proposal.taskId, taskId);
    assert.equal(findTaskProposalByTask(db, taskId)?.id, proposal.id);

    // Repeats return the same task, whatever task ID or revision they carry.
    const again = approveTaskProposal(db, {
      scope: scopeA,
      proposalId: proposal.id,
      taskId: randomUUID(),
      input: { revision: 1 },
      now: 5_300,
    });
    assert.equal(again.created, false);
    assert.equal(again.task.id, taskId);
    // An approved proposal cannot change, be rejected or reopened.
    throwsCode(
      () =>
        updateTaskProposal(db, {
          scope: scopeA,
          proposalId: proposal.id,
          input: { revision: 3, title: 'x' },
          now: 5_400,
        }),
      'task_proposal_not_editable',
    );
    throwsCode(
      () =>
        rejectTaskProposal(db, {
          scope: scopeA,
          proposalId: proposal.id,
          input: { revision: 3 },
          now: 5_400,
        }),
      'task_proposal_not_editable',
    );
    throwsCode(
      () =>
        reopenTaskProposal(db, {
          scope: scopeA,
          proposalId: proposal.id,
          input: { revision: 3 },
          now: 5_400,
        }),
      'task_proposal_not_editable',
    );
    assert.equal(count(db, 'tasks'), 1);
    // Approval never queues, starts or prepares execution.
    for (const table of ['worker_commands', 'task_runs', 'workspaces', 'publications']) {
      assert.equal(count(db, table), 0, table);
    }
  });
});

test('a failing task creation rolls the approval back completely', () => {
  withDatabase((db, connection) => {
    answer(db);
    generate(db, [parsed(1)]);
    const [proposal] = listTaskProposals(db, scopeA) ?? [];
    assert.ok(proposal !== undefined);
    // Simulate a value the task domain refuses (a model listed for the other runtime).
    connection.sqlite
      .prepare(`UPDATE task_proposals SET model_id = 'gpt-6.1-sol' WHERE id = ?`)
      .run(proposal.id);
    assert.throws(
      () =>
        approveTaskProposal(db, {
          scope: scopeA,
          proposalId: proposal.id,
          taskId: randomUUID(),
          input: { revision: 1 },
          now: 5_000,
        }),
      (error: unknown) => error instanceof TaskError && error.code === 'invalid_task_input',
    );
    const [after] = listTaskProposals(db, scopeA) ?? [];
    assert.equal(after?.status, 'draft');
    assert.equal(after?.taskId, null);
    assert.equal(after?.revision, 1);
    assert.equal(count(db, 'tasks'), 0);

    // With a valid model, the same proposal approves normally.
    connection.sqlite
      .prepare(`UPDATE task_proposals SET model_id = NULL WHERE id = ?`)
      .run(proposal.id);
    const first = approveTaskProposal(db, {
      scope: scopeA,
      proposalId: proposal.id,
      taskId: randomUUID(),
      input: { revision: 1 },
      now: 5_100,
    });
    assert.ok(findTaskById(db, first.task.id) !== undefined);
  });
});

test('database constraints keep approval and rejection states consistent', () => {
  withDatabase((db, connection) => {
    answer(db);
    generate(db, [parsed(1)]);
    const [proposal] = listTaskProposals(db, scopeA) ?? [];
    assert.ok(proposal !== undefined);
    assert.throws(() =>
      connection.sqlite
        .prepare(`UPDATE task_proposals SET status = 'approved' WHERE id = ?`)
        .run(proposal.id),
    );
    assert.throws(() =>
      connection.sqlite
        .prepare(`UPDATE task_proposals SET status = 'rejected' WHERE id = ?`)
        .run(proposal.id),
    );
    assert.equal(db.select().from(taskProposals).all().length, 1);
  });
});

test('changing conversation settings does not change existing proposals', () => {
  withDatabase((db) => {
    answer(db);
    generate(db, [parsed(1)]);
    updateConversation(db, {
      scope: scopeA,
      input: { revision: 1, agentRuntime: 'codex' },
      now: 6_000,
    });
    const [proposal] = listTaskProposals(db, scopeA) ?? [];
    assert.equal(proposal?.agentRuntime, 'claude');
    assert.equal(proposal?.modelId, 'opus');
  });
});

// ---------------------------------------------------------------------------------------------
// C3.1 — generation from one AI reply
// ---------------------------------------------------------------------------------------------

test('C3.1: the source must be a completed AI reply of this conversation and project', () => {
  withDatabase((db) => {
    const replyA = answer(db, scopeA, 'Question A', 'Reply A');
    const replyB = answer(db, scopeB, 'Question B', 'Reply B');
    const [userMessage] = listConversationMessages(db, scopeA) ?? [];
    assert.ok(userMessage !== undefined);
    // A user message is not a source.
    throwsCode(
      () => request(db, scopeA, randomUUID(), undefined, userMessage.id),
      'task_proposal_source_invalid',
    );
    // Another conversation's (and project's) reply is reported as missing here.
    throwsCode(
      () => request(db, scopeA, randomUUID(), undefined, replyB),
      'task_proposal_source_not_found',
    );
    // A conversation of another project is not found at all.
    throwsCode(
      () =>
        request(
          db,
          { projectId: projectB, conversationId: conversationA },
          randomUUID(),
          '',
          replyA,
        ),
      'conversation_not_found',
    );
    // Malformed IDs are refused by the schema.
    throwsCode(
      () => request(db, scopeA, randomUUID(), undefined, 'not-a-uuid'),
      'invalid_conversation_input',
    );
    assert.equal(count(db, 'task_proposal_generations'), 0);
  });
});

test('C3.1: only the source reply is claimed; no history or notes are loaded', () => {
  withDatabase((db) => {
    answer(db, scopeA, 'First question', 'Earlier reply');
    addConversationNote(db, {
      scope: scopeA,
      id: randomUUID(),
      input: { requestId: randomUUID(), content: 'Private note.' },
      now: 3_500,
    });
    const source = answer(db, scopeA, 'Second question', 'Selected reply');
    answer(db, scopeA, 'Third question', 'Later reply');
    const { generation } = request(db, scopeA, randomUUID(), 'Backend', source);
    assert.equal(generation.sourceMessageId, source);
    assert.equal(generation.sourceContent, 'Selected reply');
    const claim = claimTaskProposalGeneration(db, { workerInstanceId: 'w', now: 4_100 });
    assert.ok(claim.claimed);
    assert.deepEqual(claim.claim.history, []);
    assert.equal(claim.claim.notesExcluded, 0);
    assert.equal(claim.claim.generation.sourceContent, 'Selected reply');
  });
});

test('C3.1: retries reuse the source snapshot; repeats are idempotent; regeneration is deliberate', () => {
  withDatabase((db, connection) => {
    const source = answer(db, scopeA, 'Question', 'Original reply text');
    const requestId = randomUUID();
    const first = request(db, scopeA, requestId, '', source).generation;
    // Same request ID: the same generation. Same ID for another source: conflict.
    assert.equal(request(db, scopeA, requestId, '', source).generation.id, first.id);
    const other = answer(db, scopeB, 'Q', 'R');
    throwsCode(() => request(db, scopeA, requestId, '', other), 'conversation_request_conflict');
    // While it is active, a second click with a new request ID is refused (no accidental duplicate).
    throwsCode(() => request(db, scopeA, randomUUID(), '', source), 'conversation_turn_active');
    requestTaskProposalGenerationStop(db, { scope: scopeA, generationId: first.id, now: 4_100 });

    // Even if the stored text changed, the retry uses the snapshot taken at request time.
    connection.sqlite
      .prepare(`UPDATE conversation_messages SET content = 'Tampered' WHERE id = ?`)
      .run(source);
    const retried = retryTaskProposalGeneration(db, {
      scope: scopeA,
      generationId: first.id,
      newGenerationId: randomUUID(),
      input: { requestId: randomUUID() },
      now: 4_200,
    }).generation;
    assert.equal(retried.sourceMessageId, source);
    assert.equal(retried.sourceContent, 'Original reply text');
    assert.equal(retried.retryOfGenerationId, first.id);

    // After it completes, a new click is a deliberate, separate generation from the same reply.
    assert.ok(claimTaskProposalGeneration(db, { workerInstanceId: 'w', now: 4_300 }).claimed);
    finishTaskProposalGeneration(
      db,
      retried.id,
      {
        status: 'completed',
        proposals: [parsed(1)],
        skippedCount: 0,
        note: '',
        effectiveModelId: null,
        exitCode: 0,
        endedAt: 4_400,
      },
      { createProposalId: randomUUID },
    );
    const again = request(db, scopeA, randomUUID(), '', source).generation;
    assert.notEqual(again.id, retried.id);
    assert.equal(again.sourceMessageId, source);
    assert.equal(
      (listTaskProposalGenerations(db, scopeA) ?? []).filter((g) => g.sourceMessageId === source)
        .length,
      3,
    );
    // Only drafts of the completed generation exist; nothing was created as a task.
    assert.equal(listTaskProposals(db, scopeA)?.length, 1);
    assert.equal(count(db, 'tasks'), 0);
  });
});

test('C3.1: retry is scoped to the latest request of the same source reply', () => {
  withDatabase((db) => {
    const sourceOne = answer(db, scopeA, 'Q1', 'Reply one');
    const sourceTwo = answer(db, scopeA, 'Q2', 'Reply two');
    const one = request(db, scopeA, randomUUID(), '', sourceOne).generation;
    requestTaskProposalGenerationStop(db, { scope: scopeA, generationId: one.id, now: 4_100 });
    const two = request(db, scopeA, randomUUID(), '', sourceTwo).generation;
    requestTaskProposalGenerationStop(db, { scope: scopeA, generationId: two.id, now: 4_200 });
    // The first reply's request is still the latest for its own source, so it can be retried.
    const retried = retryTaskProposalGeneration(db, {
      scope: scopeA,
      generationId: one.id,
      newGenerationId: randomUUID(),
      input: { requestId: randomUUID() },
      now: 4_300,
    }).generation;
    assert.equal(retried.sourceMessageId, sourceOne);
    assert.equal(retried.sourceContent, 'Reply one');
  });
});

test('C3.1: existing C3 generations without a source keep working and cannot be retried', () => {
  withDatabase((db, connection) => {
    answer(db);
    // As migration 0011 leaves a C3 row: no source reference, no snapshot.
    const legacyId = randomUUID();
    connection.sqlite
      .prepare(
        `INSERT INTO task_proposal_generations (id, conversation_id, request_id, status, agent_runtime, language_mode, instructions, based_on_sequence, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 'claude', 'pl_technical_en', '', 2, 4000, 4000)`,
      )
      .run(legacyId, conversationA, randomUUID());
    const claim = claimTaskProposalGeneration(db, { workerInstanceId: 'w', now: 4_100 });
    assert.ok(claim.claimed);
    assert.equal(claim.claim.generation.sourceMessageId, null);
    // Its in-flight run still gets the answered history it was queued with.
    assert.deepEqual(
      claim.claim.history.map(({ role }) => role),
      ['user', 'assistant'],
    );
    finishTaskProposalGeneration(
      db,
      legacyId,
      {
        status: 'failed',
        errorCode: 'malformed_output',
        errorMessage: 'x',
        exitCode: 0,
        signal: null,
        effectiveModelId: null,
        endedAt: 4_200,
      },
      { createProposalId: randomUUID },
    );
    throwsCode(
      () =>
        retryTaskProposalGeneration(db, {
          scope: scopeA,
          generationId: legacyId,
          newGenerationId: randomUUID(),
          input: { requestId: randomUUID() },
          now: 4_300,
        }),
      'task_proposal_generation_not_retryable',
    );
  });
});
