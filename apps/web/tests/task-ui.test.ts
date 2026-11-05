import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskActions, taskStatuses, type Task } from '@ai-agent-manager/core';
import {
  availableUserTaskActions,
  taskEditability,
  taskStatusNotes,
  userTaskActions,
} from '@/lib/tasks/actions';
import {
  describeBaseBranch,
  describeModel,
  emptyTaskCounts,
  groupTasksByStatus,
  primaryBoardStatuses,
  secondaryBoardStatuses,
  summarizeTaskCounts,
} from '@/lib/tasks/board';
import { createdTaskUrl, readTaskFeedback, savedTaskUrl } from '@/lib/tasks/feedback';
import {
  buildCreateTaskRequest,
  buildTaskUpdate,
  changeRuntime,
  newTaskFormValues,
  taskFormValuesFromTask,
} from '@/lib/tasks/form';

const projectId = '00000000-0000-4000-8000-00000000000a';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const task = (overrides: Partial<Task> = {}): Task => ({
  id: id(1),
  projectId,
  title: 'Add login',
  prompt: 'Implement the login form.',
  agentRuntime: 'claude',
  modelId: null,
  baseBranch: null,
  priority: 'normal',
  urgent: false,
  status: 'backlog',
  queuedAt: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

test('the board shows every documented status exactly once', () => {
  const shown = [...primaryBoardStatuses, ...secondaryBoardStatuses];
  assert.deepEqual([...shown].sort(), [...taskStatuses].sort());
  assert.equal(new Set(shown).size, taskStatuses.length);
  assert.deepEqual(primaryBoardStatuses, ['backlog', 'queued', 'in_progress', 'review', 'done']);
});

test('groups tasks by status and orders queued tasks like the scheduler', () => {
  const groups = groupTasksByStatus([
    task({ id: id(1), status: 'queued', priority: 'low', queuedAt: 1 }),
    task({ id: id(2), status: 'queued', priority: 'critical', queuedAt: 5 }),
    task({ id: id(3), status: 'queued', priority: 'low', queuedAt: 2, urgent: true }),
    task({ id: id(4), status: 'queued', priority: 'critical', queuedAt: 3 }),
    task({ id: id(5), status: 'backlog', priority: 'high', createdAt: 9 }),
    task({ id: id(6), status: 'backlog', priority: 'high', createdAt: 2 }),
    task({ id: id(7), status: 'failed', updatedAt: 1 }),
    task({ id: id(8), status: 'failed', updatedAt: 7 }),
  ]);
  assert.deepEqual(Object.keys(groups).sort(), [...taskStatuses].sort());
  assert.deepEqual(
    groups.queued.map(({ id: taskId }) => taskId),
    [id(3), id(4), id(2), id(1)],
  );
  assert.deepEqual(
    groups.backlog.map(({ id: taskId }) => taskId),
    [id(6), id(5)],
  );
  assert.deepEqual(
    groups.failed.map(({ id: taskId }) => taskId),
    [id(8), id(7)],
  );
  assert.deepEqual(groups.done, []);
});

test('exposes only Queue and Return to Backlog, as the domain allows them', () => {
  assert.deepEqual(availableUserTaskActions('backlog'), ['queue']);
  assert.deepEqual(availableUserTaskActions('queued'), ['return_to_backlog']);
  for (const status of taskStatuses.filter((value) => value !== 'backlog' && value !== 'queued')) {
    assert.deepEqual(availableUserTaskActions(status), [], status);
  }
  assert.ok(userTaskActions.every((action) => taskActions.includes(action)));
  for (const workerOnly of ['start', 'complete_execution', 'mark_done', 'retry', 'resume']) {
    assert.ok(!(userTaskActions as readonly string[]).includes(workerOnly));
  }
});

test('derives editability from the domain and describes every status', () => {
  assert.deepEqual(taskEditability('backlog'), { content: true, priority: true });
  assert.deepEqual(taskEditability('queued'), { content: false, priority: true });
  for (const status of ['in_progress', 'review', 'done', 'discarded', 'failed'] as const) {
    assert.deepEqual(taskEditability(status), { content: false, priority: false });
  }
  for (const status of taskStatuses) {
    assert.ok(taskStatusNotes[status].length > 0);
  }
});

test('describes models, base branches and task counts', () => {
  assert.equal(describeModel(null), 'Default');
  assert.equal(describeModel('opus'), 'opus');
  assert.equal(describeBaseBranch(null, 'main'), 'main (project default)');
  assert.equal(describeBaseBranch('develop', 'main'), 'develop');

  const counts = emptyTaskCounts();
  assert.equal(summarizeTaskCounts(counts), 'No tasks');
  counts.total = 5;
  counts.byStatus.backlog = 2;
  counts.byStatus.queued = 1;
  counts.byStatus.failed = 1;
  counts.byStatus.interrupted = 1;
  assert.equal(summarizeTaskCounts(counts), '5 tasks · 1 queued · 2 need attention');
  assert.equal(
    summarizeTaskCounts({ total: 1, byStatus: { ...emptyTaskCounts().byStatus, backlog: 1 } }),
    '1 task',
  );
});

test('builds create requests with the domain schema and defaults', () => {
  const values = newTaskFormValues();
  assert.equal(values.agentRuntime, 'claude');
  assert.equal(values.priority, 'normal');

  const empty = buildCreateTaskRequest(values);
  assert.equal(empty.ok, false);
  assert.ok(!empty.ok && empty.fields.title !== undefined && empty.fields.prompt !== undefined);

  assert.deepEqual(
    buildCreateTaskRequest({ ...values, title: ' Add login ', prompt: 'Do it.', modelId: '  ' }),
    {
      ok: true,
      request: {
        title: 'Add login',
        prompt: 'Do it.',
        agentRuntime: 'claude',
        modelId: null,
        baseBranch: null,
        priority: 'normal',
        urgent: false,
      },
    },
  );
  const explicit = buildCreateTaskRequest({
    ...values,
    title: 'T',
    prompt: 'P',
    agentRuntime: 'codex',
    modelId: ' gpt-5.1-codex ',
    baseBranch: 'develop',
    priority: 'critical',
    urgent: true,
  });
  assert.ok(explicit.ok);
  assert.equal(explicit.request.modelId, 'gpt-5.1-codex');
  assert.equal(explicit.request.baseBranch, 'develop');
});

test('switching the runtime resets the model to Default', () => {
  const values = { ...newTaskFormValues(), modelId: 'opus' };
  assert.equal(changeRuntime(values, 'claude'), values);
  assert.deepEqual(changeRuntime(values, 'codex'), {
    ...values,
    agentRuntime: 'codex',
    modelId: '',
  });
});

test('sends only changed and editable fields when editing', () => {
  const stored = task({ modelId: 'opus', baseBranch: 'develop' });
  const values = taskFormValuesFromTask(stored);
  const full = taskEditability('backlog');
  assert.deepEqual(buildTaskUpdate(stored, values, full), { ok: true, update: null });
  assert.deepEqual(buildTaskUpdate(stored, { ...values, title: ' Add login ' }, full), {
    ok: true,
    update: null,
  });
  assert.deepEqual(
    buildTaskUpdate(stored, { ...changeRuntime(values, 'codex'), baseBranch: '' }, full),
    { ok: true, update: { agentRuntime: 'codex', modelId: null, baseBranch: null } },
  );
  const invalid = buildTaskUpdate(stored, { ...values, prompt: '' }, full);
  assert.ok(!invalid.ok && invalid.fields.prompt !== undefined);

  // While queued, content changes are ignored and never sent; priority still is.
  const queued = task({ status: 'queued', queuedAt: 5 });
  const queuedValues = taskFormValuesFromTask(queued);
  assert.deepEqual(
    buildTaskUpdate(
      queued,
      { ...queuedValues, title: '', prompt: 'Changed', priority: 'high', urgent: true },
      taskEditability('queued'),
    ),
    { ok: true, update: { priority: 'high', urgent: true } },
  );
});

test('passes one-time task feedback through the URL', () => {
  assert.equal(createdTaskUrl(projectId, id(1)), `/projects/${projectId}/tasks/${id(1)}?created=1`);
  assert.equal(savedTaskUrl(projectId, id(1)), `/projects/${projectId}/tasks/${id(1)}?saved=1`);
  assert.equal(readTaskFeedback({ created: '1' }), 'created');
  assert.equal(readTaskFeedback({ saved: '1' }), 'saved');
  assert.equal(readTaskFeedback({ saved: ['1'] }), undefined);
  assert.equal(readTaskFeedback({}), undefined);
});
