import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  availableTaskActions,
  createTaskInputSchema,
  isTaskUpdateAllowed,
  resolveTaskTransition,
  resolveTaskUpdate,
  taskActions,
  taskSchema,
  taskStatuses,
  taskStatusLabels,
  updateTaskInputSchema,
  type TaskAction,
  type TaskStatus,
} from '../src/index.js';

const projectId = '6f1c0f3e-6a1e-4a7c-9a55-2f1f1d7c9b10';

test('keeps the documented task states and their display names', () => {
  assert.deepEqual(
    taskStatuses.map((status) => taskStatusLabels[status]),
    [
      'Backlog',
      'Queued',
      'In Progress',
      'Review',
      'Done',
      'Stopped',
      'Interrupted',
      'Failed',
      'Discarded',
    ],
  );
});

test('applies creation defaults: Default model, project base branch, Normal priority', () => {
  const parsed = createTaskInputSchema.parse({
    projectId,
    title: '  Add login  ',
    prompt: '  Implement the login form.  ',
    agentRuntime: 'claude',
  });
  assert.deepEqual(parsed, {
    projectId,
    title: 'Add login',
    prompt: 'Implement the login form.',
    agentRuntime: 'claude',
    modelId: null,
    baseBranch: null,
    priority: 'normal',
    urgent: false,
  });
  assert.equal(
    createTaskInputSchema.parse({ ...parsed, modelId: ' gpt-5.1-codex ', agentRuntime: 'codex' })
      .modelId,
    'gpt-5.1-codex',
  );
});

test('rejects invalid task input', () => {
  const valid = { projectId, title: 'T', prompt: 'P', agentRuntime: 'codex' };
  assert.equal(createTaskInputSchema.safeParse(valid).success, true);
  const invalid: Record<string, unknown>[] = [
    { ...valid, projectId: 'project-1' },
    { ...valid, title: '   ' },
    { ...valid, title: 'x'.repeat(201) },
    { ...valid, prompt: '' },
    { ...valid, prompt: 'x'.repeat(50_001) },
    { ...valid, agentRuntime: 'gemini' },
    { ...valid, modelId: '  ' },
    { ...valid, baseBranch: '' },
    { ...valid, priority: 'urgent' },
    { ...valid, urgent: 'yes' },
    { ...valid, status: 'queued' },
    { ...valid, id: '6f1c0f3e-6a1e-4a7c-9a55-2f1f1d7c9b11' },
  ];
  for (const value of invalid) {
    assert.equal(createTaskInputSchema.safeParse(value).success, false, JSON.stringify(value));
  }
});

test('requires at least one field in an update and never accepts a status or project', () => {
  assert.equal(updateTaskInputSchema.safeParse({}).success, false);
  assert.equal(updateTaskInputSchema.safeParse({ title: undefined }).success, false);
  assert.equal(updateTaskInputSchema.safeParse({ status: 'queued' }).success, false);
  assert.equal(updateTaskInputSchema.safeParse({ projectId }).success, false);
  assert.deepEqual(updateTaskInputSchema.parse({ modelId: null, urgent: true }), {
    modelId: null,
    urgent: true,
  });
});

// The documented lifecycle (SPEC §7, ARCHITECTURE §5.1), written out independently of the table.
const allowed: Record<TaskStatus, Partial<Record<TaskAction, TaskStatus>>> = {
  backlog: { queue: 'queued' },
  queued: { return_to_backlog: 'backlog', start: 'in_progress' },
  in_progress: {
    complete_execution: 'review',
    stop: 'stopped',
    fail: 'failed',
    interrupt: 'interrupted',
  },
  review: { request_changes: 'queued', discard: 'discarded', mark_done: 'done' },
  stopped: { retry: 'queued', resume: 'queued', discard: 'discarded' },
  interrupted: { retry: 'queued', resume: 'queued', discard: 'discarded' },
  failed: { retry: 'queued', discard: 'discarded' },
  discarded: {},
  done: {},
};

test('allows exactly the documented transitions for every status and action', () => {
  for (const status of taskStatuses) {
    for (const action of taskActions) {
      assert.equal(
        resolveTaskTransition(action, status),
        allowed[status][action],
        `${action} from ${status}`,
      );
    }
    assert.deepEqual(availableTaskActions(status), Object.keys(allowed[status]));
  }
});

test('reaches every status from Backlog and never leaves Done or Discarded', () => {
  const reachable = new Set<TaskStatus>(['backlog']);
  for (let changed = true; changed;) {
    changed = false;
    for (const status of [...reachable]) {
      for (const action of availableTaskActions(status)) {
        const to = resolveTaskTransition(action, status);
        if (to !== undefined && !reachable.has(to)) {
          reachable.add(to);
          changed = true;
        }
      }
    }
  }
  assert.deepEqual([...reachable].sort(), [...taskStatuses].sort());
  assert.deepEqual(availableTaskActions('done'), []);
  assert.deepEqual(availableTaskActions('discarded'), []);
});

test('allows content edits only in Backlog and reprioritizing in Backlog or Queued', () => {
  for (const status of taskStatuses) {
    assert.equal(isTaskUpdateAllowed(status, { title: 'New' }), status === 'backlog', status);
    assert.equal(isTaskUpdateAllowed(status, { modelId: null }), status === 'backlog', status);
    assert.equal(
      isTaskUpdateAllowed(status, { priority: 'high', urgent: true }),
      status === 'backlog' || status === 'queued',
      status,
    );
  }
  assert.equal(isTaskUpdateAllowed('queued', { priority: 'low', prompt: 'P' }), false);
});

test('resets the model to Default when the runtime changes without a model choice', () => {
  const current = { agentRuntime: 'claude' } as const;
  assert.deepEqual(resolveTaskUpdate(current, { agentRuntime: 'codex' }), {
    agentRuntime: 'codex',
    modelId: null,
  });
  assert.deepEqual(resolveTaskUpdate(current, { agentRuntime: 'codex', modelId: 'o3' }), {
    agentRuntime: 'codex',
    modelId: 'o3',
  });
  assert.deepEqual(resolveTaskUpdate(current, { agentRuntime: 'claude', title: 'T' }), {
    agentRuntime: 'claude',
    title: 'T',
  });
  assert.deepEqual(resolveTaskUpdate(current, { modelId: 'opus' }), { modelId: 'opus' });
});

test('describes a stored task', () => {
  const task = {
    id: '6f1c0f3e-6a1e-4a7c-9a55-2f1f1d7c9b11',
    projectId,
    title: 'T',
    prompt: 'P',
    agentRuntime: 'claude',
    modelId: null,
    baseBranch: 'develop',
    priority: 'critical',
    urgent: true,
    status: 'in_progress',
    queuedAt: 2,
    createdAt: 1,
    updatedAt: 3,
  };
  assert.deepEqual(taskSchema.parse(task), task);
  assert.equal(taskSchema.safeParse({ ...task, status: 'In Progress' }).success, false);
});
