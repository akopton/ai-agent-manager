import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter, codexAdapter } from '@ai-agent-manager/agents';
import { replayCapturedOutput, ReplayInputError, type ReplayOptions } from '../src/index.js';

const secret = 'SYNTHETIC-SECRET-PROMPT-TEXT';
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const claude = {
  init: line({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-x' }),
  message: line({ type: 'assistant', message: { content: [{ type: 'text', text: secret }] } }),
  tool: line({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { content: secret } }],
    },
  }),
  success: line({ type: 'result', subtype: 'success', is_error: false, result: secret }),
  failure: line({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: secret,
  }),
  modelError: line({
    type: 'result',
    subtype: 'error',
    is_error: true,
    result: 'model not found: aam-nonexistent-model-000',
  }),
};

const codex = {
  init: line({ type: 'thread.started', thread_id: 't-1' }),
  command: line({
    type: 'item.started',
    item: { id: 'i1', type: 'command_execution', command: `echo ${secret}`, status: 'in_progress' },
  }),
  message: line({
    type: 'item.completed',
    item: { id: 'i2', type: 'agent_message', text: secret },
  }),
  success: line({ type: 'turn.completed', usage: {} }),
  failure: line({ type: 'turn.failed', error: { message: secret } }),
};

const withCapture = async (
  content: string | Buffer,
  run: (path: string, directory: string) => Promise<void>,
): Promise<void> => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'aam-replay-test-')));
  try {
    const path = join(directory, 'events.jsonl');
    writeFileSync(path, content);
    await run(path, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const replay = (
  adapter: ReplayOptions['adapter'],
  eventsFile: string,
  extra: Partial<ReplayOptions> = {},
) =>
  replayCapturedOutput({
    adapter,
    eventsFile,
    termination: { kind: 'exited', exitCode: 0 },
    ...extra,
  });

test('replays Claude output in order with production outcome semantics and no content', async () => {
  await withCapture(claude.init + claude.message + claude.tool + claude.success, async (path) => {
    const result = await replay(claudeAdapter, path);
    assert.equal(result.kind, 'offline_replay');
    assert.equal(result.verification, 'parser_only');
    assert.deepEqual(result.outcome, { status: 'completed', code: null });
    assert.equal(result.sessionIdReported, true);
    assert.equal(result.reportedModelId, 'claude-x');
    assert.deepEqual(
      result.events.map((event) => event.type),
      ['metadata', 'message', 'tool_activity'],
    );
    assert.deepEqual(
      result.events.map((event) => event.sequence),
      [1, 2, 3],
    );
    assert.equal(result.events[2]?.toolName, 'Write');
    assert.ok(!JSON.stringify(result).includes(secret), 'replay output must not contain content');
    assert.ok(result.limitations.some((note) => note.includes('no process was started')));
  });
});

test('replays Codex output without exposing command text', async () => {
  await withCapture(codex.init + codex.command + codex.message + codex.success, async (path) => {
    const result = await replay(codexAdapter, path);
    assert.deepEqual(result.outcome, { status: 'completed', code: null });
    assert.equal(result.eventCounts.tool_activity, 1);
    assert.ok(!JSON.stringify(result).includes(secret));
  });
});

test('handles partial lines like the supervisor: a complete unterminated line is still parsed', async () => {
  await withCapture(claude.init + claude.success.trimEnd(), async (path) => {
    const result = await replay(claudeAdapter, path);
    assert.deepEqual(result.outcome, { status: 'completed', code: null });
  });
  // A line cut in the middle of the final result is malformed, and the run is incomplete.
  await withCapture(claude.init + claude.success.slice(0, 30), async (path) => {
    const result = await replay(claudeAdapter, path);
    assert.ok(result.diagnosticCodes.includes('malformed_output'));
    assert.deepEqual(result.outcome, { status: 'failed', code: 'incomplete_output' });
  });
  // A large line split across read chunks is reassembled.
  const large = line({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x'.repeat(200_000) }] },
  });
  await withCapture(claude.init + large + claude.success, async (path) => {
    const result = await replay(claudeAdapter, path);
    assert.deepEqual(result.diagnosticCodes, []);
    assert.equal(
      result.events[1]?.truncated,
      true,
      'messages over 64 KiB are truncated by the parser',
    );
    assert.deepEqual(result.outcome, { status: 'completed', code: null });
  });
});

test('reports malformed and unrecognized events without stopping', async () => {
  const content = `${claude.init}{not json\n[1,2]\n${line({ type: 'synthetic.unknown' })}\n${claude.success}`;
  await withCapture(content, async (path) => {
    const result = await replay(claudeAdapter, path);
    assert.deepEqual(result.diagnosticCodes, ['malformed_output', 'unrecognized_event']);
    assert.deepEqual(result.outcome, { status: 'completed', code: null });
  });
});

test('missing final result: incomplete output on exit 0, non-zero exit otherwise', async () => {
  await withCapture(codex.init + codex.message, async (path) => {
    assert.deepEqual((await replay(codexAdapter, path)).outcome, {
      status: 'failed',
      code: 'incomplete_output',
    });
    const exited = await replay(codexAdapter, path, {
      termination: { kind: 'exited', exitCode: 1 },
    });
    assert.deepEqual(exited.outcome, { status: 'failed', code: 'non_zero_exit' });
  });
});

test('classifies provider failures, refused models, stops and foreign signals', async () => {
  await withCapture(codex.init + codex.failure, async (path) => {
    const result = await replay(codexAdapter, path, {
      termination: { kind: 'exited', exitCode: 1 },
    });
    assert.deepEqual(result.outcome, { status: 'failed', code: 'provider_error' });
    assert.ok(!JSON.stringify(result).includes(secret));
  });
  await withCapture(claude.init + claude.modelError, async (path) => {
    const explicit = await replay(claudeAdapter, path, { explicitModel: true });
    assert.deepEqual(explicit.outcome, { status: 'failed', code: 'model_unavailable' });
    const byDefault = await replay(claudeAdapter, path);
    assert.deepEqual(byDefault.outcome, { status: 'failed', code: 'provider_error' });
  });
  await withCapture(claude.init + claude.success, async (path) => {
    const stopped = await replay(claudeAdapter, path, {
      termination: { kind: 'stop_requested', exitCode: 143, signal: null },
    });
    assert.deepEqual(stopped.outcome, { status: 'stopped', code: null });
    const killed = await replay(claudeAdapter, path, {
      termination: { kind: 'signaled', signal: 'SIGKILL' },
    });
    assert.deepEqual(killed.outcome, { status: 'failed', code: 'terminated_by_signal' });
  });
});

test('enforces the output and line limits like the production launch path', async () => {
  const filler = line({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'y'.repeat(1000) }] },
  });
  await withCapture(claude.init + filler.repeat(200) + claude.success, async (path) => {
    const result = await replay(claudeAdapter, path, { maxStdoutBytes: 64 * 1024 });
    assert.equal(result.input.outputLimitReached, true);
    assert.ok(result.input.bytesRead <= 128 * 1024, 'reading stops at the limit');
    assert.deepEqual(result.outcome, { status: 'failed', code: 'output_limit_exceeded' });
  });
  await withCapture(claude.init + `${'z'.repeat(5000)}\n` + claude.success, async (path) => {
    const result = await replay(claudeAdapter, path, { maxLineBytes: 1024 });
    assert.ok(result.diagnosticCodes.includes('line_truncated'));
    assert.deepEqual(result.outcome, { status: 'completed', code: null });
  });
});

test('refuses unsafe inputs: relative, missing, symlinked and non-regular files', async () => {
  await withCapture(claude.success, async (path, directory) => {
    const link = join(directory, 'link.jsonl');
    symlinkSync(path, link);
    const folder = join(directory, 'folder');
    mkdirSync(folder);
    for (const eventsFile of ['events.jsonl', join(directory, 'missing.jsonl'), link, folder]) {
      await assert.rejects(replay(claudeAdapter, eventsFile), ReplayInputError, eventsFile);
    }
    await assert.rejects(replay(claudeAdapter, path, { maxStdoutBytes: 0 }), ReplayInputError);
  });
});
