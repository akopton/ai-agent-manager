import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeAdapter, codexAdapter } from '../src/index.js';
import type { AgentOutputEvent, AgentOutputParser } from '../src/contract.js';
import { createLineSplitter, truncateText } from '../src/line-splitter.js';
import { isModelUnavailableMessage } from '../src/output-parsing.js';

const parseAll = (parser: AgentOutputParser, lines: unknown[]): AgentOutputEvent[] =>
  lines.flatMap((line) => parser.parseLine(typeof line === 'string' ? line : JSON.stringify(line)));

// Shapes follow Claude Code `--print --output-format stream-json --verbose`.
const claudeStream = [
  { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5-5', tools: [] },
  { type: 'system', subtype: 'hook_started' },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text: 'I will create the file.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Write',
          input: { file_path: 'a.ts', content: 'SECRET' },
        },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        { type: 'text', text: 'the original prompt' },
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
      ],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Created a.ts.',
    session_id: 'sess-1',
  },
];

test('maps Claude stream-json events and reports success', () => {
  const parser = claudeAdapter.createOutputParser({ explicitModel: false });
  const events = parseAll(parser, claudeStream);
  assert.deepEqual(events, [
    { type: 'metadata', sessionId: 'sess-1', reportedModelId: 'claude-opus-5-5' },
    { type: 'message', text: 'I will create the file.', truncated: false },
    { type: 'tool_activity', phase: 'started', toolName: 'Write', toolId: 'toolu_1' },
    { type: 'tool_activity', phase: 'completed', toolName: 'Write', toolId: 'toolu_1' },
    { type: 'metadata', sessionId: 'sess-1' },
  ]);
  assert.deepEqual(parser.outcome(), { status: 'succeeded', summary: 'Created a.ts.' });
  // Tool input, thinking, and user text are never copied into events.
  const serialized = JSON.stringify(events);
  for (const hidden of ['SECRET', 'internal', 'the original prompt']) {
    assert.ok(!serialized.includes(hidden), hidden);
  }
});

test('records a Claude error result without treating it as success', () => {
  const parser = claudeAdapter.createOutputParser({ explicitModel: true });
  parseAll(parser, [
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['model: not-a-model not found'],
    },
  ]);
  const outcome = parser.outcome();
  assert.equal(outcome.status, 'failed');
  assert.match(
    outcome.status === 'failed' ? outcome.message : '',
    /error_during_execution.*not found/,
  );
  const maxTurns = claudeAdapter.createOutputParser({ explicitModel: false });
  parseAll(maxTurns, [{ type: 'result', subtype: 'success', is_error: true, result: 'API Error' }]);
  assert.equal(maxTurns.outcome().status, 'failed');
});

// Shapes follow `codex exec --json` (thread/turn/item events).
const codexStream = [
  { type: 'thread.started', thread_id: 'thread-1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } },
  {
    type: 'item.started',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: 'bash -lc ls',
      status: 'in_progress',
    },
  },
  {
    type: 'item.updated',
    item: { id: 'item_1', type: 'command_execution', aggregated_output: 'a' },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: 'bash -lc ls',
      exit_code: 2,
      status: 'failed',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_2',
      type: 'file_change',
      changes: [{ path: 'a.ts', kind: 'add' }],
      status: 'completed',
    },
  },
  { type: 'error', message: 'Reconnecting... 1/5' },
  { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Done.' } },
  { type: 'item.completed', item: { id: 'item_4', type: 'future_item_type' } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
];

test('maps Codex JSONL events and reports success', () => {
  const parser = codexAdapter.createOutputParser({ explicitModel: false });
  assert.deepEqual(parseAll(parser, codexStream), [
    { type: 'metadata', sessionId: 'thread-1' },
    {
      type: 'tool_activity',
      phase: 'started',
      toolName: 'command',
      toolId: 'item_1',
      detail: 'bash -lc ls',
    },
    {
      type: 'tool_activity',
      phase: 'failed',
      toolName: 'command',
      toolId: 'item_1',
      detail: 'bash -lc ls',
    },
    {
      type: 'tool_activity',
      phase: 'completed',
      toolName: 'file_change',
      toolId: 'item_2',
      detail: 'add a.ts',
    },
    { type: 'provider_notice', message: 'Reconnecting... 1/5' },
    { type: 'message', text: 'Done.', truncated: false },
  ]);
  assert.deepEqual(parser.outcome(), { status: 'succeeded', summary: 'Done.' });
  assert.equal(parser.lastNotice(), 'Reconnecting... 1/5');
});

test('records a failed Codex turn', () => {
  const parser = codexAdapter.createOutputParser({ explicitModel: true });
  parseAll(parser, [
    {
      type: 'turn.failed',
      error: { message: "The 'x' model is not supported when using Codex with a ChatGPT account." },
    },
  ]);
  const outcome = parser.outcome();
  assert.equal(outcome.status, 'failed');
  assert.ok(outcome.status === 'failed' && isModelUnavailableMessage(outcome.message));
});

test('handles malformed and unexpected output without throwing', () => {
  for (const adapter of [claudeAdapter, codexAdapter]) {
    const parser = adapter.createOutputParser({ explicitModel: false });
    const events = parseAll(parser, [
      '',
      '{"type":"assistant", "message": {',
      'plain text with a secret',
      '[1,2,3]',
      '"string"',
      '{"no_type":true}',
      { type: 'brand_new_event' },
      { type: 'brand_new_event' },
      { type: 'assistant', message: 'not an object' },
      { type: 'item.completed', item: null },
      { type: 'result' },
    ]);
    const codes = events.map((event) => (event.type === 'diagnostic' ? event.code : event.type));
    assert.deepEqual(codes.slice(0, 5), [
      'malformed_output',
      'malformed_output',
      'malformed_output',
      'malformed_output',
      'malformed_output',
    ]);
    // Unknown event types are reported once.
    assert.equal(
      codes.filter((code) => code === 'unrecognized_event').length,
      adapter === claudeAdapter ? 2 : 3,
    );
    assert.ok(!JSON.stringify(events).includes('secret'), 'diagnostics never contain line content');
  }
});

test('suppresses repeated malformed-output diagnostics', () => {
  const parser = claudeAdapter.createOutputParser({ explicitModel: false });
  const events = parseAll(
    parser,
    Array.from({ length: 50 }, () => 'not json'),
  );
  assert.equal(events.length, 20);
});

test('truncates very long messages', () => {
  const parser = codexAdapter.createOutputParser({ explicitModel: false });
  const [event] = parseAll(parser, [
    { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'x'.repeat(100_000) } },
  ]);
  assert.equal(event?.type, 'message');
  assert.ok(event?.type === 'message' && event.truncated && event.text.length === 64 * 1024);
});

test('splits partial chunks into lines, including multi-byte characters', () => {
  const splitter = createLineSplitter(1024);
  const bytes = Buffer.from('{"a":"zażółć"}\r\n{"b":', 'utf8');
  const lines = [
    ...splitter.push(bytes.subarray(0, 9)),
    ...splitter.push(bytes.subarray(9, 12)),
    ...splitter.push(bytes.subarray(12)),
  ];
  assert.deepEqual(lines, [{ text: '{"a":"zażółć"}', truncated: false }]);
  assert.deepEqual(splitter.push(Buffer.from('2}\n\n')), [
    { text: '{"b":2}', truncated: false },
    { text: '', truncated: false },
  ]);
  assert.equal(splitter.flush(), null);
  splitter.push(Buffer.from('partial'));
  assert.deepEqual(splitter.flush(), { text: 'partial', truncated: false });
});

test('truncates overlong lines and resumes at the next newline', () => {
  const splitter = createLineSplitter(4);
  assert.deepEqual(splitter.push(Buffer.from('abcdefgh')), []);
  assert.deepEqual(splitter.push(Buffer.from('ij\nok\n')), [
    { text: 'abcd', truncated: true },
    { text: 'ok', truncated: false },
  ]);
  assert.deepEqual(truncateText('a😀', 2), { text: 'a', truncated: true });
});

test('model-unavailable heuristic', () => {
  for (const message of [
    'model: claude-foo not found',
    'The requested model is not available for your account',
    "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.",
    'invalid model name',
  ]) {
    assert.ok(isModelUnavailableMessage(message), message);
  }
  for (const message of ['rate limit exceeded', 'authentication failed', 'file not found']) {
    assert.ok(!isModelUnavailableMessage(message), message);
  }
});
