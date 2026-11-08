import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  conversationDisclosure,
  trustedLocalDisclosure,
  type ParsedTaskProposal,
} from '@ai-agent-manager/core';
import {
  applyMigrations,
  claimConversationTurn,
  claimTaskProposalGeneration,
  createDatabase,
  finishConversationTurn,
  finishTaskProposalGeneration,
} from '@ai-agent-manager/database';
import { GET as getConversationRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/route';
import { POST as requestRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/proposal-generations/route';
import { GET as getGenerationRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/proposal-generations/[generationId]/route';
import { POST as retryGenerationRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/proposal-generations/[generationId]/retry/route';
import { POST as stopGenerationRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/proposal-generations/[generationId]/stop/route';
import { GET as listProposalsRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/proposals/route';
import {
  GET as getProposalRoute,
  PATCH as patchProposalRoute,
} from '@/app/api/projects/[projectId]/conversations/[conversationId]/proposals/[proposalId]/route';
import { POST as approveRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/proposals/[proposalId]/approve/route';
import { POST as rejectRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/proposals/[proposalId]/reject/route';
import { POST as reopenRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/proposals/[proposalId]/reopen/route';
import { POST as stopTurnRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/turns/[turnId]/stop/route';
import { POST as sendRoute } from '@/app/api/projects/[projectId]/conversations/[conversationId]/turns/route';
import { POST as createConversationRoute } from '@/app/api/projects/[projectId]/conversations/route';
import { GET as listTasksRoute } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as registerRoute } from '@/app/api/projects/route';
import { PUT as conversationSettingsRoute } from '@/app/api/settings/conversations/route';
import { PUT as trustedLocalRoute } from '@/app/api/settings/trusted-local/route';
import {
  approveTaskProposalResponseSchema,
  conversationDetailResponseSchema,
  conversationResponseSchema,
  sendConversationMessageResponseSchema,
  taskProposalGenerationResponseSchema,
  taskProposalListResponseSchema,
  taskProposalResponseSchema,
} from '@/lib/conversations/contracts';
import { apiErrorResponseSchema, projectResponseSchema } from '@/lib/projects/contracts';
import { closeDatabase, getDatabase } from '@/lib/server/database';
import { findTaskOrigin } from '@/lib/server/task-proposals';
import { taskListResponseSchema } from '@/lib/tasks/contracts';
import {
  createFixtureDirectory,
  createRepository,
  git,
  removeFixtureDirectory,
  snapshot,
} from './fixtures';

// C3 — task proposal API: explicit, idempotent requests under the separate AI Conversations
// consent; project-scoped proposal routes; revision-guarded edits; reject/reopen; and Approve to
// Backlog creating exactly one Backlog task, never a queue entry, worker command, run, worktree or
// Git change. No worker runs here: generations are finished through the database, as the worker
// would.

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

const send = (
  method: 'POST' | 'PUT' | 'PATCH',
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

const read = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${origin}${path}`, { headers: { host: '127.0.0.1:3000', ...headers } });

const errorOf = async (response: Response) =>
  apiErrorResponseSchema.parse(await response.json()).error;

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const enableAi = async () => {
  const response = await conversationSettingsRoute(
    send('PUT', '/api/settings/conversations', {
      enabled: true,
      disclosureVersion: conversationDisclosure.version,
    }),
  );
  assert.equal(response.status, 200);
};

const disableAi = () =>
  conversationSettingsRoute(send('PUT', '/api/settings/conversations', { enabled: false }));

type Setup = {
  root: string;
  projectId: string;
  conversationId: string;
  base: string;
  /** The latest AI reply; the default source of a proposal request (C3.1). */
  replyId?: string;
};

let counter = 0;
const setUp = async (): Promise<Setup> => {
  counter += 1;
  const name = `proposals-${counter}`;
  const root = createRepository(join(directory, name));
  git(root, 'branch', 'develop');
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
  const created = await createConversationRoute(
    send('POST', `/api/projects/${projectId}/conversations`, { title: 'Plan', modelId: 'opus' }),
    params({ projectId }),
  );
  assert.equal(created.status, 201);
  const conversationId = conversationResponseSchema.parse(await created.json()).conversation.id;
  return {
    root,
    projectId,
    conversationId,
    base: `/api/projects/${projectId}/conversations/${conversationId}`,
  };
};

/** One answered exchange, as the worker would store it. Returns the reply's message ID. */
const discuss = async (setup: Setup, reply = 'Rate limiting, then docs.'): Promise<string> => {
  const { projectId, conversationId, base } = setup;
  const sent = await sendRoute(
    send('POST', `${base}/turns`, { requestId: randomUUID(), content: 'How do we split auth?' }),
    params({ projectId, conversationId }),
  );
  assert.equal(sent.status, 202);
  const { turn } = sendConversationMessageResponseSchema.parse(await sent.json());
  const db = getDatabase();
  const claim = claimConversationTurn(db, { workerInstanceId: 'w', now: Date.now() });
  assert.ok(claim.claimed);
  assert.equal(claim.claim.turn.id, turn.id);
  const finished = finishConversationTurn(
    db,
    turn.id,
    { status: 'completed', reply, effectiveModelId: null, exitCode: 0, endedAt: Date.now() },
    { createMessageId: randomUUID },
  );
  const replyId = finished?.assistantMessageId;
  assert.ok(typeof replyId === 'string');
  setup.replyId = replyId;
  return replyId;
};

/** Adds the latest reply as the source unless the body names one (C3.1). */
const withSource = (setup: Setup, body: unknown): unknown =>
  typeof body === 'object' && body !== null && !('sourceMessageId' in body)
    ? { ...body, sourceMessageId: setup.replyId ?? randomUUID() }
    : body;

const requestProposals = (setup: Setup, body: unknown, headers: Record<string, string> = {}) =>
  requestRoute(
    send('POST', `${setup.base}/proposal-generations`, withSource(setup, body), headers),
    params({ projectId: setup.projectId, conversationId: setup.conversationId }),
  );

const parsed = (n: number): ParsedTaskProposal => ({
  title: `Task ${n}`,
  prompt: `Implement part ${n}.`,
  priority: 'normal',
  rationale: '',
  dependencies: '',
});

/** Requests proposals and completes the generation as the worker would. */
const generate = async (setup: Setup, proposals: ParsedTaskProposal[]) => {
  const response = await requestProposals(setup, { requestId: randomUUID() });
  assert.equal(response.status, 202);
  const { generation } = taskProposalGenerationResponseSchema.parse(await response.json());
  const db = getDatabase();
  const claim = claimTaskProposalGeneration(db, { workerInstanceId: 'w', now: Date.now() });
  assert.ok(claim.claimed);
  assert.equal(claim.claim.generation.id, generation.id);
  finishTaskProposalGeneration(
    db,
    generation.id,
    {
      status: 'completed',
      proposals,
      skippedCount: 0,
      note: '',
      effectiveModelId: null,
      exitCode: 0,
      endedAt: Date.now(),
    },
    { createProposalId: randomUUID },
  );
  return generation;
};

const listProposals = async (setup: Setup) => {
  const response = await listProposalsRoute(
    read(`${setup.base}/proposals`),
    params({ projectId: setup.projectId, conversationId: setup.conversationId }),
  );
  assert.equal(response.status, 200);
  return taskProposalListResponseSchema.parse(await response.json());
};

const proposalParams = (setup: Setup, proposalId: string) =>
  params({ projectId: setup.projectId, conversationId: setup.conversationId, proposalId });

const action = (
  route: typeof approveRoute,
  setup: Setup,
  proposalId: string,
  name: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  route(
    send('POST', `${setup.base}/proposals/${proposalId}/${name}`, body, headers),
    proposalParams(setup, proposalId),
  );

const countRows = (table: string): number => {
  const reader = createDatabase({ path: process.env[databaseVariable] });
  try {
    return (reader.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    reader.close();
  }
};

test('requests need the AI Conversations consent; execution consent does not count', async () => {
  const setup = await setUp();
  await enableAi();
  await discuss(setup);
  await disableAi();
  const trusted = await trustedLocalRoute(
    send('PUT', '/api/settings/trusted-local', {
      enabled: true,
      disclosureVersion: trustedLocalDisclosure.version,
      acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
    }),
  );
  assert.equal(trusted.status, 200);
  const refused = await requestProposals(setup, { requestId: randomUUID() });
  assert.equal(refused.status, 409);
  assert.equal((await errorOf(refused)).code, 'conversation_ai_disabled');
  assert.equal((await listProposals(setup)).generations.length, 0);
});

test('requests are explicit, need an answered exchange, are idempotent and guarded', async () => {
  const setup = await setUp();
  await enableAi();
  const early = await requestProposals(setup, { requestId: randomUUID() });
  assert.equal(early.status, 404);
  assert.equal((await errorOf(early)).code, 'task_proposal_source_not_found');

  const replyId = await discuss(setup);
  // Ordinary chat never created a proposal request.
  assert.equal((await listProposals(setup)).generations.length, 0);

  for (const body of [
    { requestId: randomUUID(), projectId: setup.projectId },
    { requestId: randomUUID(), status: 'approved' },
    { requestId: 'not-a-uuid' },
    { requestId: randomUUID(), instructions: 'x'.repeat(2_001) },
    // C3.1: the source text is never accepted from the browser, and an ID is required.
    { requestId: randomUUID(), sourceContent: 'Injected' },
    { requestId: randomUUID(), sourceMessageId: null },
    { requestId: randomUUID(), sourceMessageId: 'not-a-uuid' },
  ]) {
    assert.equal((await requestProposals(setup, body)).status, 400);
  }
  const foreign = await requestProposals(
    setup,
    { requestId: randomUUID() },
    { origin: 'https://evil.example' },
  );
  assert.equal(foreign.status, 403);
  const text = await requestRoute(
    new Request(`${origin}${setup.base}/proposal-generations`, {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', origin, 'content-type': 'text/plain' },
      body: JSON.stringify({ requestId: randomUUID() }),
    }),
    params({ projectId: setup.projectId, conversationId: setup.conversationId }),
  );
  assert.equal(text.status, 415);

  const requestId = randomUUID();
  const first = await requestProposals(setup, { requestId, instructions: 'Backend only' });
  assert.equal(first.status, 202);
  const { generation } = taskProposalGenerationResponseSchema.parse(await first.json());
  assert.equal(generation.status, 'queued');
  assert.equal(generation.sourceMessageId, replyId);
  assert.equal(generation.active, true);
  assert.equal(generation.requestedModelId, 'opus');
  const repeat = await requestProposals(setup, { requestId, instructions: 'Backend only' });
  assert.equal(repeat.status, 200);
  assert.equal(
    taskProposalGenerationResponseSchema.parse(await repeat.json()).generation.id,
    generation.id,
  );
  const second = await requestProposals(setup, { requestId: randomUUID() });
  assert.equal(second.status, 409);
  assert.equal((await errorOf(second)).code, 'conversation_turn_active');

  const status = await getGenerationRoute(
    read(`${setup.base}/proposal-generations/${generation.id}`),
    params({
      projectId: setup.projectId,
      conversationId: setup.conversationId,
      generationId: generation.id,
    }),
  );
  assert.equal(status.status, 200);

  // Stop (queued → cancelled at once), then an explicit retry.
  const generationParams = params({
    projectId: setup.projectId,
    conversationId: setup.conversationId,
    generationId: generation.id,
  });
  const stopped = await stopGenerationRoute(
    send('POST', `${setup.base}/proposal-generations/${generation.id}/stop`),
    generationParams,
  );
  assert.equal(stopped.status, 200);
  assert.equal(
    taskProposalGenerationResponseSchema.parse(await stopped.json()).generation.status,
    'cancelled',
  );
  const retried = await retryGenerationRoute(
    send('POST', `${setup.base}/proposal-generations/${generation.id}/retry`, {
      requestId: randomUUID(),
    }),
    generationParams,
  );
  assert.equal(retried.status, 202);
  const retry = taskProposalGenerationResponseSchema.parse(await retried.json()).generation;
  assert.equal(retry.retryOfGenerationId, generation.id);
  assert.equal(retry.instructions, 'Backend only');
  // Leave nothing queued for later tests.
  const cleanup = await stopGenerationRoute(
    send('POST', `${setup.base}/proposal-generations/${retry.id}/stop`),
    params({
      projectId: setup.projectId,
      conversationId: setup.conversationId,
      generationId: retry.id,
    }),
  );
  assert.equal(cleanup.status, 200);
});

test('proposal routes are scoped to their project and conversation', async () => {
  const first = await setUp();
  const second = await setUp();
  await enableAi();
  await discuss(first);
  await generate(first, [parsed(1)]);
  const [proposal] = (await listProposals(first)).proposals;
  assert.ok(proposal !== undefined);
  const crossed: Setup = { ...second, conversationId: first.conversationId };
  const crossList = await listProposalsRoute(
    read(`${second.base}/proposals`),
    params({ projectId: second.projectId, conversationId: first.conversationId }),
  );
  assert.equal(crossList.status, 404);
  const crossApprove = await action(approveRoute, crossed, proposal.id, 'approve', {
    revision: 1,
  });
  assert.equal(crossApprove.status, 404);
  assert.equal((await errorOf(crossApprove)).code, 'conversation_not_found');
  const otherConversation = await action(approveRoute, second, proposal.id, 'approve', {
    revision: 1,
  });
  assert.equal(otherConversation.status, 404);
  assert.equal((await errorOf(otherConversation)).code, 'task_proposal_not_found');
  // C3.1: a reply of another project's conversation is not a source here.
  const secondReply = await discuss(second);
  const foreignSource = await requestProposals(first, {
    requestId: randomUUID(),
    sourceMessageId: secondReply,
  });
  assert.equal(foreignSource.status, 404);
  assert.equal((await errorOf(foreignSource)).code, 'task_proposal_source_not_found');
  const crossRequest = await requestProposals(crossed, { requestId: randomUUID() });
  assert.equal(crossRequest.status, 404);
  assert.equal(countRows('tasks'), 0);
  // The read refuses cross-origin browser requests.
  const crossSite = await getProposalRoute(
    read(`${first.base}/proposals/${proposal.id}`, { 'sec-fetch-site': 'cross-site' }),
    proposalParams(first, proposal.id),
  );
  assert.equal(crossSite.status, 403);
});

test('drafts are edited and rejected through the API with validation', async () => {
  const setup = await setUp();
  await enableAi();
  await discuss(setup);
  await generate(setup, [parsed(1), parsed(2)]);
  const { proposals } = await listProposals(setup);
  const [first, second] = proposals;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.edited, false);
  assert.deepEqual(first.suggested, {
    title: 'Task 1',
    prompt: 'Implement part 1.',
    priority: 'normal',
    agentRuntime: 'claude',
    modelId: 'opus',
  });

  const patch = (proposalId: string, body: unknown) =>
    patchProposalRoute(
      send('PATCH', `${setup.base}/proposals/${proposalId}`, body),
      proposalParams(setup, proposalId),
    );
  const edited = await patch(first.id, {
    revision: 1,
    title: 'Edited',
    baseBranch: 'develop',
    priority: 'high',
  });
  assert.equal(edited.status, 200);
  const view = taskProposalResponseSchema.parse(await edited.json()).proposal;
  assert.equal(view.title, 'Edited');
  assert.equal(view.baseBranch, 'develop');
  assert.equal(view.edited, true);
  assert.equal(view.suggested.title, 'Task 1');
  assert.equal(view.revision, 2);

  const stale = await patch(first.id, { revision: 1, title: 'Old' });
  assert.equal(stale.status, 409);
  assert.equal((await errorOf(stale)).code, 'task_proposal_changed');
  const missingBranch = await patch(first.id, { revision: 2, baseBranch: 'does-not-exist' });
  assert.equal(missingBranch.status, 422);
  assert.equal((await errorOf(missingBranch)).code, 'base_branch_not_found');
  const wrongModel = await patch(first.id, { revision: 2, modelId: 'gpt-6.1-sol' });
  assert.equal(wrongModel.status, 400);
  const badPriority = await patch(first.id, { revision: 2, priority: 'urgent' });
  assert.equal(badPriority.status, 400);
  const statusField = await patch(first.id, { revision: 2, status: 'approved' });
  assert.equal(statusField.status, 400);
  const runtimeSwitch = await patch(first.id, { revision: 2, agentRuntime: 'codex' });
  assert.equal(runtimeSwitch.status, 200);
  assert.equal(taskProposalResponseSchema.parse(await runtimeSwitch.json()).proposal.modelId, null);

  const rejected = await action(rejectRoute, setup, second.id, 'reject', { revision: 1 });
  assert.equal(rejected.status, 200);
  assert.equal(taskProposalResponseSchema.parse(await rejected.json()).proposal.status, 'rejected');
  const approveRejected = await action(approveRoute, setup, second.id, 'approve', {
    revision: 2,
  });
  assert.equal(approveRejected.status, 409);
  assert.equal((await errorOf(approveRejected)).code, 'task_proposal_not_editable');
  const reopened = await action(reopenRoute, setup, second.id, 'reopen', { revision: 2 });
  assert.equal(reopened.status, 200);
  assert.equal(taskProposalResponseSchema.parse(await reopened.json()).proposal.status, 'draft');
  assert.equal(countRows('tasks'), 0);
});

test('Approve to Backlog creates exactly one Backlog task and never queues, runs or touches Git', async () => {
  const setup = await setUp();
  await enableAi();
  await discuss(setup);
  await generate(setup, [parsed(1)]);
  const [proposal] = (await listProposals(setup)).proposals;
  assert.ok(proposal !== undefined);
  const edited = await patchProposalRoute(
    send('PATCH', `${setup.base}/proposals/${proposal.id}`, {
      revision: 1,
      title: 'Rate limit login',
      prompt: 'Add rate limiting to POST /login with tests.',
      agentRuntime: 'codex',
      modelId: 'gpt-6.1-sol',
      priority: 'critical',
      baseBranch: 'develop',
    }),
    proposalParams(setup, proposal.id),
  );
  assert.equal(edited.status, 200);
  const before = snapshot(setup.root);
  const tasksBefore = countRows('tasks');

  const foreign = await action(
    approveRoute,
    setup,
    proposal.id,
    'approve',
    { revision: 2 },
    { origin: 'https://evil.example' },
  );
  assert.equal(foreign.status, 403);
  const stale = await action(approveRoute, setup, proposal.id, 'approve', { revision: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await errorOf(stale)).code, 'task_proposal_changed');

  // Two simultaneous approvals create one task.
  const [one, two] = await Promise.all([
    action(approveRoute, setup, proposal.id, 'approve', { revision: 2 }),
    action(approveRoute, setup, proposal.id, 'approve', { revision: 2 }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 201]);
  const results = [one, two].map(async (response) =>
    approveTaskProposalResponseSchema.parse(await response.json()),
  );
  const [a, b] = await Promise.all(results);
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(a.task.id, b.task.id);
  assert.equal(a.task.status, 'backlog');
  assert.equal(a.proposal.status, 'approved');
  assert.equal(a.proposal.taskId, a.task.id);
  assert.equal(countRows('tasks'), tasksBefore + 1);

  const again = await action(approveRoute, setup, proposal.id, 'approve', { revision: 3 });
  assert.equal(again.status, 200);
  assert.equal(approveTaskProposalResponseSchema.parse(await again.json()).task.id, a.task.id);

  // The task carries the edited values and sits in Backlog of this project.
  const listed = await listTasksRoute(
    read(`/api/projects/${setup.projectId}/tasks`),
    params({ projectId: setup.projectId }),
  );
  const tasks = taskListResponseSchema.parse(await listed.json()).tasks;
  assert.equal(tasks.length, 1);
  const [task] = tasks;
  assert.deepEqual(
    task === undefined
      ? undefined
      : [
          task.title,
          task.prompt,
          task.agentRuntime,
          task.modelId,
          task.priority,
          task.baseBranch,
          task.status,
          task.queuedAt,
          task.urgent,
        ],
    [
      'Rate limit login',
      'Add rate limiting to POST /login with tests.',
      'codex',
      'gpt-6.1-sol',
      'critical',
      'develop',
      'backlog',
      null,
      false,
    ],
  );

  // An approved proposal can no longer change.
  const lateEdit = await patchProposalRoute(
    send('PATCH', `${setup.base}/proposals/${proposal.id}`, { revision: 3, title: 'x' }),
    proposalParams(setup, proposal.id),
  );
  assert.equal(lateEdit.status, 409);
  const lateReject = await action(rejectRoute, setup, proposal.id, 'reject', { revision: 3 });
  assert.equal(lateReject.status, 409);

  // Nothing was queued, started, prepared or published, and the repository is unchanged.
  for (const table of ['worker_commands', 'task_runs', 'workspaces', 'publications']) {
    assert.equal(countRows(table), 0, table);
  }
  assert.deepEqual(snapshot(setup.root), before);
  assert.equal(git(setup.root, 'status', '--porcelain'), '');
  assert.equal(git(setup.root, 'worktree', 'list').trim().split('\n').length, 1);
  assert.deepEqual(git(setup.root, 'branch', '--format=%(refname:short)').trim().split('\n'), [
    'develop',
    'main',
  ]);

  // The conversation history is unchanged by proposals, and chat still works.
  const detail = await getConversationRoute(
    read(setup.base),
    params({ projectId: setup.projectId, conversationId: setup.conversationId }),
  );
  const body = conversationDetailResponseSchema.parse(await detail.json());
  assert.deepEqual(
    body.messages.map(({ role, kind }) => [role, kind]),
    [
      ['user', 'chat'],
      ['assistant', 'chat'],
    ],
  );
  assert.equal(body.proposals.length, 1);
  assert.equal(body.generations.length, 1);
  const chat = await sendRoute(
    send('POST', `${setup.base}/turns`, { requestId: randomUUID(), content: 'Next?' }),
    params({ projectId: setup.projectId, conversationId: setup.conversationId }),
  );
  assert.equal(chat.status, 202);
  // Leave nothing queued for later tests.
  const { turn } = sendConversationMessageResponseSchema.parse(await chat.json());
  const stopped = await stopTurnRoute(
    send('POST', `${setup.base}/turns/${turn.id}/stop`),
    params({ projectId: setup.projectId, conversationId: setup.conversationId, turnId: turn.id }),
  );
  assert.equal(stopped.status, 200);
});

test('approval re-checks an explicit base branch and leaves the draft unchanged when it is gone', async () => {
  const setup = await setUp();
  await enableAi();
  await discuss(setup);
  await generate(setup, [parsed(1)]);
  const [proposal] = (await listProposals(setup)).proposals;
  assert.ok(proposal !== undefined);
  const edited = await patchProposalRoute(
    send('PATCH', `${setup.base}/proposals/${proposal.id}`, { revision: 1, baseBranch: 'develop' }),
    proposalParams(setup, proposal.id),
  );
  assert.equal(edited.status, 200);
  git(setup.root, 'branch', '-D', 'develop');
  const refused = await action(approveRoute, setup, proposal.id, 'approve', { revision: 2 });
  assert.equal(refused.status, 422);
  assert.equal((await errorOf(refused)).code, 'base_branch_not_found');
  const [after] = (await listProposals(setup)).proposals;
  assert.equal(after?.status, 'draft');
  assert.equal(after?.taskId, null);
  const listed = await listTasksRoute(
    read(`/api/projects/${setup.projectId}/tasks`),
    params({ projectId: setup.projectId }),
  );
  assert.equal(taskListResponseSchema.parse(await listed.json()).tasks.length, 0);
});

test('C3.1: only completed AI replies are sources; regeneration from the same reply is deliberate', async () => {
  const setup = await setUp();
  await enableAi();
  const earlier = await discuss(setup, 'Earlier reply.');
  const source = await discuss(setup, 'Selected reply.');
  const detailBefore = conversationDetailResponseSchema.parse(
    await (
      await getConversationRoute(
        read(setup.base),
        params({ projectId: setup.projectId, conversationId: setup.conversationId }),
      )
    ).json(),
  );
  const userMessage = detailBefore.messages.find((message) => message.role === 'user');
  assert.ok(userMessage !== undefined);
  const fromUser = await requestProposals(setup, {
    requestId: randomUUID(),
    sourceMessageId: userMessage.id,
  });
  assert.equal(fromUser.status, 409);
  assert.equal((await errorOf(fromUser)).code, 'task_proposal_source_invalid');

  // Two batches from the selected reply (deliberate), none from the earlier one.
  await generate(setup, [parsed(1)]);
  await generate(setup, [parsed(2), parsed(3)]);
  const { generations, proposals } = await listProposals(setup);
  assert.deepEqual(
    generations.map((generation) => generation.sourceMessageId),
    [source, source],
  );
  assert.ok(!generations.some((generation) => generation.sourceMessageId === earlier));
  assert.deepEqual(
    proposals.map((proposal) => [proposal.title, proposal.generationId]),
    [
      ['Task 1', generations[0]?.id],
      ['Task 2', generations[1]?.id],
      ['Task 3', generations[1]?.id],
    ],
  );
  // The history is unchanged and nothing was created as a task.
  const detailAfter = conversationDetailResponseSchema.parse(
    await (
      await getConversationRoute(
        read(setup.base),
        params({ projectId: setup.projectId, conversationId: setup.conversationId }),
      )
    ).json(),
  );
  assert.deepEqual(detailAfter.messages, detailBefore.messages);
  assert.equal(detailAfter.generations[0]?.sourceMessageId, source);
  const listed = await listTasksRoute(
    read(`/api/projects/${setup.projectId}/tasks`),
    params({ projectId: setup.projectId }),
  );
  assert.equal(taskListResponseSchema.parse(await listed.json()).tasks.length, 0);
});

test('UI-04C: origin preview is bounded, historical, source-specific and project-scoped', async () => {
  const setup = await setUp();
  const foreign = await setUp();
  await enableAi();
  const text = 'Historical assistant content. '.repeat(100);
  const sourceMessageId = await discuss(setup, text);
  await generate(setup, [parsed(1)]);
  const [proposal] = (await listProposals(setup)).proposals;
  assert.ok(proposal);
  const approved = await action(approveRoute, setup, proposal.id, 'approve', { revision: 1 });
  const { task } = approveTaskProposalResponseSchema.parse(await approved.json());
  await discuss(setup, 'Later reply must not replace the original preview.');
  const preview = findTaskOrigin(getDatabase(), setup.projectId, task.id);
  assert.equal(preview?.sourceMessageId, sourceMessageId);
  assert.equal(preview?.excerpt, text.slice(0, 601));
  assert.equal(preview?.conversationTitle, 'Plan');
  assert.equal(findTaskOrigin(getDatabase(), foreign.projectId, task.id), undefined);
  assert.equal(findTaskOrigin(getDatabase(), setup.projectId, randomUUID()), undefined);
});
