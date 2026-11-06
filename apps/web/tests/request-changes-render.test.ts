import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Test-only: client components call `useRouter`, which requires the App Router context.
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { TaskExecutionPanel } from '@/components/execution/task-execution-panel';
import { AttemptHistory } from '@/components/review/attempt-history';
import { RequestChangesForm } from '@/components/review/request-changes-form';
import type { ReviewDecisionView, TaskRunView } from '@/lib/execution/contracts';

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

const run = (attempt: number, overrides: Partial<TaskRunView> = {}): TaskRunView => ({
  id: id(attempt),
  attempt,
  status: 'completed',
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
  exitCode: 0,
  signal: null,
  errorCode: null,
  errorMessage: null,
  summary: null,
  stopRequestedAt: null,
  createdAt: attempt,
  startedAt: attempt,
  endedAt: attempt,
  eventsDropped: 0,
  reviewEligible: true,
  gitIntegrity: { status: 'clean', checkedAt: attempt, totalFindings: 0, findings: [] },
  ...overrides,
});

const decision = (overrides: Partial<ReviewDecisionView> = {}): ReviewDecisionView => ({
  id: id(100),
  status: 'changes_requested',
  runId: id(1),
  attempt: 1,
  feedback: 'Rename <hello>.txt',
  createdAt: 5,
  followUpRunId: null,
  followUpAttempt: null,
  ...overrides,
});

test('the Request Changes form states that the task returns to Queued and needs an explicit Start', () => {
  const html = render(
    createElement(RequestChangesForm, {
      projectId,
      taskId,
      runId: id(1),
      attempt: 1,
      revision: 'rev',
    }),
  );
  assert.match(html, /Request changes/);
  assert.match(html, /returns to <span[^>]*>Queued<\/span>/);
  assert.match(html, /No agent starts automatically/);
  assert.match(html, /start attempt 2 explicitly with Start execution/);
  assert.match(html, /continues in the same task worktree and branch/);
  assert.match(html, /maxLength="10000"/);
});

test('the attempt history shows each attempt, its review outcome and the feedback', () => {
  const html = render(
    createElement(AttemptHistory, {
      attempts: [run(2), run(1)],
      decisions: [decision({ followUpRunId: id(2), followUpAttempt: 2 })],
    }),
  );
  assert.match(html, /Attempt 2/);
  assert.match(html, /Attempt 1/);
  assert.match(html, /Changes requested/);
  assert.match(html, /addressed by attempt 2/);
  assert.match(html, /Continued attempt 1 in the same worktree/);
  // Feedback is rendered as text, never as markup.
  assert.match(html, /Rename &lt;hello&gt;\.txt/);
});

test('the execution panel explains that Start continues the reviewed attempt', () => {
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
        reviews: [decision()],
        recoveries: [],
        lastCommand: null,
        events: [],
      },
    }),
  );
  assert.match(html, /Start execution/);
  assert.match(html, /Start continues attempt 1 as attempt 2/);
  assert.match(html, /reuses the existing task worktree and branch/);
  assert.match(html, /Rename &lt;hello&gt;\.txt/);
});
