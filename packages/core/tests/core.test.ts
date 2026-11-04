import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentRuntimeSchema,
  modelSelectionSchema,
  shutdownSignalSchema,
  workerStateSchema,
} from '../src/index.js';

test('accepts only supported agent runtimes', () => {
  assert.equal(agentRuntimeSchema.parse('claude'), 'claude');
  assert.equal(agentRuntimeSchema.parse('codex'), 'codex');
  for (const value of ['Claude', 'gemini', '', null, undefined, 1]) {
    assert.equal(agentRuntimeSchema.safeParse(value).success, false);
  }
});

test('treats null as the default model and trims explicit model identifiers', () => {
  assert.equal(modelSelectionSchema.parse(null), null);
  assert.equal(modelSelectionSchema.parse('  claude-opus-5-5 '), 'claude-opus-5-5');
  for (const value of ['', '   ', 'x'.repeat(201), undefined, 42]) {
    assert.equal(modelSelectionSchema.safeParse(value).success, false);
  }
});

test('validates worker lifecycle states and shutdown signals', () => {
  assert.equal(workerStateSchema.parse('running'), 'running');
  assert.equal(workerStateSchema.safeParse('paused').success, false);
  assert.equal(shutdownSignalSchema.parse('SIGINT'), 'SIGINT');
  assert.equal(shutdownSignalSchema.parse('SIGTERM'), 'SIGTERM');
  assert.equal(shutdownSignalSchema.safeParse('SIGKILL').success, false);
});
