import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addConversationNoteInputSchema,
  conversationLanguageModeDefault,
  conversationLanguageModes,
  conversationMessageContentSchema,
  conversationMessageKinds,
  conversationMessageMaxLength,
  conversationMessageRoles,
  conversationRuntimeDefault,
  conversationTitleMaxLength,
  createConversationInputSchema,
  resolveConversationUpdate,
  updateConversationInputSchema,
} from '../src/index.js';

const projectId = '6f1c0f3e-6a1e-4a7c-9a55-2f1f1d7c9b10';
const requestId = '0b1c0f3e-6a1e-4a7c-9a55-2f1f1d7c9b11';

test('defines the three language modes with Polish + technical English as the default', () => {
  assert.deepEqual(conversationLanguageModes, ['pl_technical_en', 'pl', 'en']);
  assert.equal(conversationLanguageModeDefault, 'pl_technical_en');
});

test('reserves user/assistant roles and note/chat kinds for future exchanges', () => {
  assert.deepEqual(conversationMessageRoles, ['user', 'assistant']);
  assert.deepEqual(conversationMessageKinds, ['note', 'chat']);
});

test('applies defaults to a new conversation: runtime default, model Default, language default', () => {
  const parsed = createConversationInputSchema.parse({ projectId, title: '  Auth redesign  ' });
  assert.deepEqual(parsed, {
    projectId,
    title: 'Auth redesign',
    agentRuntime: conversationRuntimeDefault,
    modelId: null,
    languageMode: 'pl_technical_en',
  });
});

test('rejects invalid conversation settings', () => {
  const invalid: unknown[] = [
    { projectId, title: '   ' },
    { projectId, title: 'x'.repeat(conversationTitleMaxLength + 1) },
    { projectId, title: 'T', agentRuntime: 'gemini' },
    { projectId, title: 'T', modelId: '   ' },
    { projectId, title: 'T', modelId: 'm'.repeat(201) },
    { projectId, title: 'T', languageMode: 'de' },
    { projectId: 'not-a-uuid', title: 'T' },
    { projectId, title: 'T', status: 'archived' },
  ];
  for (const value of invalid) {
    assert.equal(createConversationInputSchema.safeParse(value).success, false, String(value));
  }
  assert.equal(
    createConversationInputSchema.safeParse({
      projectId,
      title: 'T',
      agentRuntime: 'codex',
      modelId: 'gpt-x',
      languageMode: 'en',
    }).success,
    true,
  );
});

test('requires a revision and at least one setting in an update', () => {
  assert.equal(updateConversationInputSchema.safeParse({ title: 'New' }).success, false);
  assert.equal(updateConversationInputSchema.safeParse({ revision: 1 }).success, false);
  assert.equal(updateConversationInputSchema.safeParse({ revision: 0, title: 'x' }).success, false);
  assert.equal(
    updateConversationInputSchema.safeParse({ revision: 1, projectId, title: 'x' }).success,
    false,
  );
  assert.equal(
    updateConversationInputSchema.safeParse({ revision: 2, modelId: null }).success,
    true,
  );
});

test('resets the model to Default when the runtime changes without a model', () => {
  const current = { agentRuntime: 'claude' as const };
  assert.deepEqual(resolveConversationUpdate(current, { revision: 1, agentRuntime: 'codex' }), {
    revision: 1,
    agentRuntime: 'codex',
    modelId: null,
  });
  assert.deepEqual(
    resolveConversationUpdate(current, { revision: 1, agentRuntime: 'codex', modelId: 'x' }),
    { revision: 1, agentRuntime: 'codex', modelId: 'x' },
  );
  assert.deepEqual(resolveConversationUpdate(current, { revision: 1, agentRuntime: 'claude' }), {
    revision: 1,
    agentRuntime: 'claude',
  });
});

test('normalizes message content and rejects empty, oversized and invalid messages', () => {
  assert.equal(conversationMessageContentSchema.parse('  a\r\nb\rc  \n'), 'a\nb\nc');
  assert.equal(conversationMessageContentSchema.parse('# Plan\n\n- `code`'), '# Plan\n\n- `code`');
  assert.equal(conversationMessageContentSchema.safeParse('').success, false);
  assert.equal(conversationMessageContentSchema.safeParse(' \n\t ').success, false);
  assert.equal(conversationMessageContentSchema.safeParse('a\0b').success, false);
  assert.equal(conversationMessageContentSchema.safeParse(42).success, false);
  assert.equal(
    conversationMessageContentSchema.safeParse('x'.repeat(conversationMessageMaxLength)).success,
    true,
  );
  assert.equal(
    conversationMessageContentSchema.safeParse('x'.repeat(conversationMessageMaxLength + 1))
      .success,
    false,
  );
});

test('requires a UUID request ID and no extra fields on a note', () => {
  assert.equal(
    addConversationNoteInputSchema.safeParse({ requestId, content: 'Hi' }).success,
    true,
  );
  assert.equal(addConversationNoteInputSchema.safeParse({ content: 'Hi' }).success, false);
  assert.equal(
    addConversationNoteInputSchema.safeParse({ requestId: 'x', content: 'Hi' }).success,
    false,
  );
  assert.equal(
    addConversationNoteInputSchema.safeParse({ requestId, content: 'Hi', role: 'assistant' })
      .success,
    false,
  );
});
