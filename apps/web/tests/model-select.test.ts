import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  describeModelSelectionProblem,
  findCatalogModel,
  modelCatalog,
  type Task,
} from '@ai-agent-manager/core';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { ModelSelect } from '@/components/models/model-select';
import { TaskForm } from '@/components/tasks/task-form';
import {
  customModelOption,
  defaultModelOption,
  describeModelChoice,
  modelChoiceFor,
  selectValueFor,
  valueForSelection,
} from '@/lib/models/model-selection';
import {
  buildCreateTaskRequest,
  buildTaskUpdate,
  changeRuntime,
  newTaskFormValues,
  taskFormValuesFromTask,
} from '@/lib/tasks/form';
import { taskEditability } from '@/lib/tasks/actions';

// Provider-specific model selection (C2): Default first, the selected runtime's catalog only,
// custom IDs preserved, the exact CLI identifier stored, cross-provider IDs refused, and the
// runtime switch resetting to Default for tasks and conversations alike.

const noop = () => undefined;
const router: AppRouterInstance = {
  bfcacheId: 'test',
  back: noop,
  forward: noop,
  refresh: noop,
  push: noop,
  replace: noop,
  prefetch: noop,
};
const render = (element: ReactElement): string =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));

const projectId = '00000000-0000-4000-8000-00000000000a';

test('the catalog is provider-specific, unique and stores exact CLI identifiers', () => {
  for (const runtime of ['claude', 'codex'] as const) {
    const ids = modelCatalog[runtime].map((model) => model.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const model of modelCatalog[runtime]) {
      assert.equal(model.runtime, runtime);
      assert.equal(describeModelSelectionProblem(runtime, model.id), null);
    }
  }
  assert.equal(findCatalogModel('claude', 'gpt-6.1-sol'), undefined);
  assert.match(describeModelSelectionProblem('claude', 'gpt-6.1-sol') ?? '', /Codex model/);
  assert.match(describeModelSelectionProblem('codex', 'opus') ?? '', /Claude Code model/);
  assert.equal(describeModelSelectionProblem('codex', 'gpt-future-1'), null);
  assert.match(describeModelSelectionProblem('claude', '--model') ?? '', /must start/);
  assert.equal(describeModelSelectionProblem('claude', null), null);
});

test('the selector state maps Default, catalog entries and custom IDs', () => {
  assert.deepEqual(modelChoiceFor('claude', ''), { kind: 'default' });
  assert.equal(modelChoiceFor('claude', 'opus').kind, 'catalog');
  assert.deepEqual(modelChoiceFor('claude', 'claude-next'), {
    kind: 'custom',
    modelId: 'claude-next',
  });
  assert.equal(selectValueFor('claude', '', false), defaultModelOption);
  assert.equal(selectValueFor('claude', '', true), customModelOption);
  assert.equal(selectValueFor('claude', 'sonnet', false), 'sonnet');
  assert.equal(selectValueFor('claude', 'claude-next', false), customModelOption);
  // Choosing "Custom" keeps a custom value being edited, otherwise starts empty.
  assert.equal(valueForSelection('claude', 'claude-next', customModelOption), 'claude-next');
  assert.equal(valueForSelection('claude', 'opus', customModelOption), '');
  assert.equal(valueForSelection('claude', 'opus', defaultModelOption), '');
  assert.equal(valueForSelection('codex', '', 'gpt-6-luna'), 'gpt-6-luna');
  assert.equal(describeModelChoice('claude', null), 'Default');
  assert.equal(describeModelChoice('claude', 'opus'), 'Opus (latest) (opus)');
  assert.equal(describeModelChoice('codex', 'my-model'), 'my-model (custom)');
});

test('the selector renders Default first and only the selected runtime’s models', () => {
  const html = render(
    createElement(ModelSelect, { id: 'm', runtime: 'codex', value: '', onChange: noop }),
  );
  const firstOption = /<option[^>]*>([^<]*)</.exec(html)?.[1];
  assert.match(firstOption ?? '', /^Default \(recommended\)/);
  assert.match(html, /GPT-6.1-Sol · gpt-6.1-sol/);
  assert.doesNotMatch(html, /opus|sonnet|claude-/i);
  assert.match(html, /not guaranteed to be available to your account/);
  assert.doesNotMatch(html, /aria-label="Custom model ID"/);
});

const task = (overrides: Partial<Task> = {}): Task => ({
  id: '00000000-0000-4000-8000-000000000001',
  projectId,
  title: 'Add login',
  prompt: 'Implement it.',
  agentRuntime: 'claude',
  modelId: null,
  baseBranch: null,
  priority: 'normal',
  urgent: false,
  status: 'backlog',
  queuedAt: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

test('the task form uses the same selector and shows a saved custom ID', () => {
  const project = { id: projectId, name: 'Website', defaultBaseBranch: 'main' };
  const html = render(
    createElement(TaskForm, {
      project,
      branches: ['main'],
      task: task({ modelId: 'claude-legacy-x' }),
    } as Parameters<typeof TaskForm>[0]),
  );
  assert.match(html, /<option value="__custom__" selected="">Custom model ID…/);
  assert.match(html, /value="claude-legacy-x"/);
  assert.match(html, /<option value="opus">Opus \(latest\) · opus<\/option>/);
});

test('task forms refuse another provider’s model but keep stored custom IDs editable', () => {
  const values = { ...newTaskFormValues(), title: 'T', prompt: 'P', modelId: 'gpt-6.1-sol' };
  const refused = buildCreateTaskRequest(values);
  assert.ok(!refused.ok && refused.fields.modelId !== undefined);
  // Switching the runtime resets to Default.
  assert.equal(changeRuntime({ ...values, agentRuntime: 'codex' }, 'claude').modelId, '');

  const stored = task({ modelId: 'not a valid id' });
  const editability = taskEditability('backlog');
  const titleOnly = buildTaskUpdate(
    stored,
    { ...taskFormValuesFromTask(stored), title: 'Renamed' },
    editability,
  );
  assert.deepEqual(titleOnly, { ok: true, update: { title: 'Renamed' } });
  const switched = buildTaskUpdate(
    stored,
    { ...taskFormValuesFromTask(stored), modelId: 'opus' },
    editability,
  );
  assert.deepEqual(switched, { ok: true, update: { modelId: 'opus' } });
});
