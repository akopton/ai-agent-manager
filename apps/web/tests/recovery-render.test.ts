import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Task } from '@ai-agent-manager/core';
// Test-only: client components call `useRouter`, which requires the App Router context.
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { TaskExecutionPanel } from '@/components/execution/task-execution-panel';
import { TaskBoard } from '@/components/tasks/task-board';
import { TaskRecoveryActions } from '@/components/tasks/task-recovery-actions';
import type { RecoveryDecisionView, TaskRunView } from '@/lib/execution/contracts';
import { taskStatusNotes } from '@/lib/tasks/actions';
import type { TaskRecoveryOptions } from '@/lib/tasks/recovery';

const projectId = '00000000-0000-4000-8000-00000000000a';
const taskId = '00000000-0000-4000-8000-00000000000b';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

const options = (overrides: Partial<TaskRecoveryOptions> = {}): TaskRecoveryOptions => ({
  runId: id(1),
  attempt: 1,
  recovery: {
    kind: 'retry',
    available: true,
    unavailableReason: null,
    workspaceRetained: true,
    processConfirmationRequired: false,
    carriesFeedback: false,
  },
  discard: { available: true, unavailableReason: null, workspaceRetained: true },
  ...overrides,
});

const task = (overrides: Partial<Task> = {}): Task => ({
  id: taskId,
  projectId,
  title: 'Flaky task',
  prompt: 'Prompt',
  agentRuntime: 'codex',
  modelId: null,
  baseBranch: null,
  priority: 'normal',
  urgent: false,
  status: 'failed',
  queuedAt: null,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
  ...overrides,
});

const run = (attempt: number, overrides: Partial<TaskRunView> = {}): TaskRunView => ({
  id: id(attempt),
  attempt,
  status: 'failed',
  active: false,
  agentRuntime: 'codex',
  requestedModelId: null,
  effectiveModelId: null,
  securityMode: 'trusted_local',
  disclosureVersion: '1',
  cliVersion: null,
  processContainment: 'process_group_only',
  acceptedRisks: [],
  safeguards: [],
  exitCode: 3,
  signal: null,
  errorCode: 'non_zero_exit',
  errorMessage: 'boom',
  summary: null,
  stopRequestedAt: null,
  createdAt: attempt,
  startedAt: attempt,
  endedAt: attempt,
  eventsDropped: 0,
  reviewEligible: false,
  gitIntegrity: { status: 'clean', checkedAt: attempt, totalFindings: 0, findings: [] },
  ...overrides,
});

const recovery = (overrides: Partial<RecoveryDecisionView> = {}): RecoveryDecisionView => ({
  id: id(500),
  kind: 'retry',
  sourceRunId: id(1),
  sourceAttempt: 1,
  sourceStatus: 'failed',
  workspaceRetained: true,
  feedbackAttempt: null,
  processCheck: 'process_group_gone',
  createdAt: 5,
  followUpRunId: null,
  followUpAttempt: null,
  ...overrides,
});

test('Retry and Discard are offered as dialog triggers with accessible names', () => {
  const html = render(
    createElement(TaskRecoveryActions, {
      projectId,
      task: { id: taskId, title: 'Flaky task', status: 'failed' },
      options: options(),
    }),
  );
  assert.match(html, /aria-label="Retry: Flaky task"/);
  assert.match(html, /Retry…/);
  assert.match(html, /aria-label="Discard: Flaky task"/);
  assert.match(html, /Discard…/);
  assert.match(html, /aria-haspopup="dialog"/);
});

test('unavailable actions explain why instead of offering a button', () => {
  const html = render(
    createElement(TaskRecoveryActions, {
      projectId,
      task: { id: taskId, title: 'Flaky task', status: 'stopped' },
      options: options({
        recovery: {
          kind: 'resume',
          available: false,
          unavailableReason: 'The process group of attempt 1 (pid 42) still exists.',
          workspaceRetained: true,
          processConfirmationRequired: false,
          carriesFeedback: false,
        },
        discard: {
          available: false,
          unavailableReason: 'An Approve &amp; Push publication holds this task.',
          workspaceRetained: true,
        },
      }),
    }),
  );
  assert.ok(!html.includes('Resume…'));
  assert.ok(!html.includes('Discard…'));
  assert.match(
    html,
    /Resume unavailable: The process group of attempt 1 \(pid 42\) still exists\./,
  );
  assert.match(html, /Discard unavailable/);
  assert.equal(
    render(
      createElement(TaskRecoveryActions, {
        projectId,
        task: { id: taskId, title: 'Done task', status: 'done' },
        options: null,
      }),
    ),
    '',
  );
});

test('board cards show Resume and Discard for tasks with recovery options only', () => {
  const html = render(
    createElement(TaskBoard, {
      projectDefaultBranch: 'main',
      tasks: [
        task({ id: id(11), title: 'Stopped one', status: 'stopped' }),
        task({ id: id(12), title: 'Backlog one', status: 'backlog' }),
      ],
      recoveryOptions: {
        [id(11)]: options({
          recovery: {
            kind: 'resume',
            available: true,
            unavailableReason: null,
            workspaceRetained: true,
            processConfirmationRequired: false,
            carriesFeedback: false,
          },
        }),
      },
    }),
  );
  assert.match(html, /aria-label="Resume: Stopped one"/);
  assert.match(html, /aria-label="Discard: Stopped one"/);
  assert.ok(!html.includes('Resume: Backlog one'));
  assert.ok(!html.includes('Discard: Backlog one'));
});

test('the execution panel explains that a queued Retry continues the worktree only after Start', () => {
  const html = render(
    createElement(TaskExecutionPanel, {
      projectId,
      task: { id: taskId, status: 'queued' },
      execution: {
        runs: [run(1)],
        workspace: {
          path: '/worktrees/repo/task',
          branch: `agent/${taskId}`,
          baseBranch: 'main',
          baseSha: 'a'.repeat(40),
          createdAt: 1,
        },
        reviews: [],
        recoveries: [recovery({ feedbackAttempt: 1 })],
        lastCommand: null,
        events: [],
      },
    }),
  );
  assert.match(html, /Start execution/);
  assert.match(html, /Retry queued: Start runs attempt (<!-- -->)?2/);
  assert.match(html, /Attempt (<!-- -->)?1(<!-- -->)? failed\. Nothing runs/);
  assert.match(html, /Nothing runs until you click Start execution/);
  assert.match(html, /continues in the existing task worktree and branch/);
  assert.match(html, /tracked and untracked changes/);
  assert.match(html, /previous session is not restored/);
  assert.match(html, /review feedback on attempt 1 is sent again/);
  assert.match(html, /Retried, waiting for Start/);
});

test('history marks attempts that were retried or resumed', () => {
  const html = render(
    createElement(TaskExecutionPanel, {
      projectId,
      task: { id: taskId, status: 'review' },
      execution: {
        runs: [run(2, { status: 'completed', errorCode: null }), run(1)],
        workspace: null,
        reviews: [],
        recoveries: [recovery({ kind: 'resume', followUpRunId: id(2), followUpAttempt: 2 })],
        lastCommand: null,
        events: [],
      },
    }),
  );
  assert.match(html, /Resumed as attempt 2/);
  assert.ok(!html.includes('Retry queued'));
});

test('status notes describe the recovery actions honestly', () => {
  assert.match(taskStatusNotes.failed, /Retry queues a new attempt/);
  assert.match(taskStatusNotes.failed, /explicit Start execution/);
  assert.match(taskStatusNotes.stopped, /Resume queues a new attempt/);
  assert.match(taskStatusNotes.interrupted, /new agent session/);
  assert.match(taskStatusNotes.discarded, /kept until you remove the worktree explicitly/);
  for (const status of ['failed', 'stopped', 'interrupted', 'review'] as const) {
    assert.ok(!taskStatusNotes[status].includes('later version'), status);
  }
});
