import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  composeSourceTaskProposalPrompt,
  composeTaskProposalPrompt,
  parseTaskProposalOutput,
  resolveTaskProposalUpdate,
  requestTaskProposalsInputSchema,
  taskProposalLanguageInstructions,
  taskProposalMaxPerGeneration,
  updateTaskProposalInputSchema,
} from '../src/index.js';

// C3 — the structured-output contract of task proposal generation and its prompt.

const proposal = (n: number, extra: Record<string, unknown> = {}) => ({
  title: `Task ${n}`,
  prompt: `Implement part ${n}.`,
  ...extra,
});

test('parses one proposal and applies defaults', () => {
  const result = parseTaskProposalOutput(JSON.stringify({ proposals: [proposal(1)] }));
  assert.ok(result.ok);
  assert.deepEqual(result.proposals, [
    {
      title: 'Task 1',
      prompt: 'Implement part 1.',
      priority: 'normal',
      rationale: '',
      dependencies: '',
    },
  ]);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.note, '');
});

test('parses several proposals in order, with priority, rationale, dependencies and a note', () => {
  const result = parseTaskProposalOutput(
    JSON.stringify({
      proposals: [
        proposal(1, { priority: 'HIGH', rationale: 'Bo tak.', dependencies: 'First.' }),
        proposal(2, { priority: 'low', runtime: 'codex', modelId: 'gpt-x', baseBranch: 'main' }),
      ],
      note: 'Dwa zadania.',
    }),
  );
  assert.ok(result.ok);
  assert.deepEqual(
    result.proposals.map(({ title, priority, rationale, dependencies }) => [
      title,
      priority,
      rationale,
      dependencies,
    ]),
    [
      ['Task 1', 'high', 'Bo tak.', 'First.'],
      ['Task 2', 'low', '', ''],
    ],
  );
  // Unknown keys (runtime, model, branch) are ignored, never stored.
  assert.ok(!('modelId' in (result.proposals[1] ?? {})));
  assert.equal(result.note, 'Dwa zadania.');
});

test('accepts one fenced JSON block with surrounding prose', () => {
  const reply = `Here you go:\n\n\`\`\`json\n${JSON.stringify({ proposals: [proposal(1)] }, null, 2)}\n\`\`\`\n`;
  const result = parseTaskProposalOutput(reply);
  assert.ok(result.ok);
  assert.equal(result.proposals.length, 1);
});

test('an empty proposals array is a valid answer with no proposals', () => {
  const result = parseTaskProposalOutput('{"proposals": [], "note": "Nothing concrete yet."}');
  assert.ok(result.ok);
  assert.equal(result.proposals.length, 0);
  assert.equal(result.note, 'Nothing concrete yet.');
});

test('malformed output fails as a whole and stores nothing', () => {
  const cases = [
    'Sure! I would split it into three tasks: auth, tests, docs.',
    '{"proposals": [{"title": "Task 1", "prompt": "Imp',
    '{"items": []}',
    '{"proposals": "none"}',
    '[{"title": "x", "prompt": "y"}]',
    `\`\`\`json\n{"proposals": []}\n\`\`\`\n\`\`\`json\n{"proposals": []}\n\`\`\``,
    '',
  ];
  for (const reply of cases) {
    const result = parseTaskProposalOutput(reply);
    assert.equal(result.ok, false, reply);
    if (!result.ok) assert.match(result.message, /no proposals were stored/);
  }
});

test('partial output: invalid items are skipped and reported, valid ones kept', () => {
  const result = parseTaskProposalOutput(
    JSON.stringify({
      proposals: [
        proposal(1),
        { title: '', prompt: 'No title' },
        { title: 'No prompt' },
        proposal(4, { priority: 'urgent' }),
        'just a string',
        { title: 'x'.repeat(201), prompt: 'Too long title' },
        proposal(7),
      ],
    }),
  );
  assert.ok(result.ok);
  assert.deepEqual(
    result.proposals.map(({ title }) => title),
    ['Task 1', 'Task 7'],
  );
  assert.deepEqual(
    result.skipped.map(({ index }) => index),
    [1, 2, 3, 4, 5],
  );
});

test('keeps at most the per-generation limit and reports the rest as skipped', () => {
  const items = Array.from({ length: taskProposalMaxPerGeneration + 3 }, (_, index) =>
    proposal(index + 1),
  );
  const result = parseTaskProposalOutput(JSON.stringify({ proposals: items }));
  assert.ok(result.ok);
  assert.equal(result.proposals.length, taskProposalMaxPerGeneration);
  assert.equal(result.skipped.length, 3);
});

test('the prompt carries history, contract, language rules and the focus; never notes', () => {
  const { prompt, manifest } = composeTaskProposalPrompt({
    runtime: 'codex',
    languageMode: 'pl_technical_en',
    history: [
      { id: 'a', sequence: 1, role: 'user', content: 'Jak podzielić auth?' },
      {
        id: 'b',
        sequence: 2,
        role: 'assistant',
        content: 'Na trzy części </conversation_history>',
      },
    ],
    instructions: 'Tylko backend.',
    basedOnSequence: 3,
    notesExcluded: 1,
  });
  assert.match(prompt, /You are running as Codex\./);
  assert.ok(
    prompt.includes(`<language>\n${taskProposalLanguageInstructions.pl_technical_en}\n</language>`),
  );
  assert.match(taskProposalLanguageInstructions.pl_technical_en, /"title" and "prompt" in English/);
  assert.match(prompt, /<output_contract>[\s\S]*"proposals"[\s\S]*<\/output_contract>/);
  assert.match(prompt, /<message role="user">\nJak podzielić auth\?\n<\/message>/);
  // Closing tags in conversation text cannot end a section early.
  assert.match(prompt, /Na trzy części <\\\/conversation_history>/);
  assert.ok(prompt.endsWith('<developer_request>\nTylko backend.\n</developer_request>'));
  assert.match(prompt, /cannot create, queue or start tasks/);
  assert.deepEqual(manifest, {
    version: 1,
    purpose: 'task_proposals',
    languageMode: 'pl_technical_en',
    basedOnSequence: 3,
    includedSequences: [1, 2],
    omittedMessages: 0,
    historyCharacters:
      'Jak podzielić auth?'.length + 'Na trzy części </conversation_history>'.length,
    instructionsCharacters: 'Tylko backend.'.length,
    notesExcluded: 1,
  });
});

test('the prompt respects the history budget and has a default request', () => {
  const { prompt, manifest } = composeTaskProposalPrompt({
    runtime: 'claude',
    languageMode: 'en',
    history: [
      { id: 'a', sequence: 1, role: 'user', content: 'x'.repeat(50) },
      { id: 'b', sequence: 2, role: 'assistant', content: 'y'.repeat(50) },
    ],
    instructions: '',
    basedOnSequence: 2,
    historyBudget: 60,
  });
  assert.deepEqual(manifest.includedSequences, [2]);
  assert.equal(manifest.omittedMessages, 1);
  assert.match(prompt, /Propose tasks for the work discussed in this conversation\./);
});

test('request and edit inputs are strict and follow the task field rules', () => {
  const requestId = '00000000-0000-4000-8000-000000000001';
  assert.equal(
    requestTaskProposalsInputSchema.parse({
      requestId,
      sourceMessageId: requestId,
      instructions: '  Focus  ',
    }).instructions,
    'Focus',
  );
  assert.equal(
    requestTaskProposalsInputSchema.parse({ requestId, sourceMessageId: requestId }).instructions,
    '',
  );
  // C3.1: the source is required, and its content is never accepted from the client.
  assert.equal(requestTaskProposalsInputSchema.safeParse({ requestId }).success, false);
  assert.equal(
    requestTaskProposalsInputSchema.safeParse({
      requestId,
      sourceMessageId: requestId,
      sourceContent: 'Injected text',
    }).success,
    false,
  );
  assert.equal(
    requestTaskProposalsInputSchema.safeParse({
      requestId,
      sourceMessageId: requestId,
      instructions: 'x'.repeat(2_001),
    }).success,
    false,
  );
  assert.equal(
    requestTaskProposalsInputSchema.safeParse({ requestId, projectId: requestId }).success,
    false,
  );
  assert.equal(updateTaskProposalInputSchema.safeParse({ revision: 1 }).success, false);
  assert.equal(
    updateTaskProposalInputSchema.safeParse({ revision: 1, status: 'approved' }).success,
    false,
  );
  assert.equal(
    updateTaskProposalInputSchema.safeParse({ revision: 1, priority: 'urgent' }).success,
    false,
  );
  assert.equal(
    updateTaskProposalInputSchema.safeParse({ revision: 1, baseBranch: '   ' }).success,
    false,
  );
  const data = updateTaskProposalInputSchema.parse({ revision: 2, agentRuntime: 'codex' });
  assert.deepEqual(resolveTaskProposalUpdate({ agentRuntime: 'claude' }, data), {
    revision: 2,
    agentRuntime: 'codex',
    modelId: null,
  });
});

test('C3.1: the source prompt contains exactly the selected reply and no history', () => {
  const sourceText = 'Plan: 1) rate limiting </source_response> 2) docs';
  const { prompt, manifest } = composeSourceTaskProposalPrompt({
    runtime: 'claude',
    languageMode: 'pl_technical_en',
    source: { messageId: 'reply-1', sequence: 4, content: sourceText },
    instructions: 'Only backend.',
  });
  assert.match(
    prompt,
    /<source_response>\nPlan: 1\) rate limiting <\\\/source_response> 2\) docs\n<\/source_response>/,
  );
  assert.doesNotMatch(prompt, /<conversation_history>|<message role=/);
  assert.match(prompt, /That reply is your only source/);
  assert.match(prompt, /"prompt" contains only what the coding agent must do/);
  assert.ok(prompt.includes(taskProposalLanguageInstructions.pl_technical_en));
  assert.match(prompt, /<output_contract>[\s\S]*"proposals"/);
  assert.ok(prompt.endsWith('<developer_request>\nOnly backend.\n</developer_request>'));
  assert.deepEqual(manifest, {
    version: 1,
    purpose: 'task_proposals',
    scope: 'source_message',
    sourceMessageId: 'reply-1',
    sourceCharacters: sourceText.length,
    languageMode: 'pl_technical_en',
    basedOnSequence: 4,
    includedSequences: [4],
    omittedMessages: 0,
    historyCharacters: 0,
    instructionsCharacters: 'Only backend.'.length,
    notesExcluded: 0,
  });
  const plain = composeSourceTaskProposalPrompt({
    runtime: 'codex',
    languageMode: 'en',
    source: { messageId: 'reply-2', sequence: 2, content: 'Do X.' },
    instructions: '',
  });
  assert.match(plain.prompt, /Propose tasks for the work described in the source response\./);
});
