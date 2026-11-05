import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { taskStatusLabels, taskStatuses, type Task } from '@ai-agent-manager/core';
// Test-only: client components call `useRouter`, which requires the App Router context.
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { TaskBoard } from '@/components/tasks/task-board';

const projectId = '00000000-0000-4000-8000-00000000000a';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const task = (overrides: Partial<Task>): Task => ({
  id: id(1),
  projectId,
  title: 'Task',
  prompt: 'Prompt',
  agentRuntime: 'claude',
  modelId: null,
  baseBranch: null,
  priority: 'normal',
  urgent: false,
  status: 'backlog',
  queuedAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

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

const columnHtml = (html: string, status: string): string => {
  const start = html.indexOf(`aria-labelledby="column-${status}"`);
  assert.notEqual(start, -1, `column ${status} is rendered`);
  return html.slice(start, html.indexOf('</section>', start));
};

test('renders every state as a column, with task metadata and honest actions', () => {
  const html = render(
    createElement(TaskBoard, {
      projectDefaultBranch: 'main',
      tasks: [
        task({ id: id(1), title: 'Write docs' }),
        task({
          id: id(2),
          title: 'Fix <script>bug</script>',
          status: 'queued',
          queuedAt: 2,
          agentRuntime: 'codex',
          modelId: 'gpt-5.1-codex',
          baseBranch: 'develop',
          priority: 'critical',
          urgent: true,
        }),
        task({ id: id(3), title: 'Broken run', status: 'failed' }),
      ],
    }),
  );

  for (const status of taskStatuses) {
    assert.ok(html.includes(`>${taskStatusLabels[status]}</h3>`), status);
  }

  const backlog = columnHtml(html, 'backlog');
  assert.match(backlog, /Write docs/);
  assert.match(backlog, /Claude Code · Default/);
  assert.match(backlog, /Normal priority/);
  assert.match(backlog, /main \(default\)/);
  assert.match(backlog, />Queue</);
  assert.doesNotMatch(backlog, /Return to Backlog/);

  const queued = columnHtml(html, 'queued');
  assert.match(queued, /Codex · gpt-5\.1-codex/);
  assert.match(queued, /Critical priority/);
  assert.match(queued, /Urgent/);
  assert.match(queued, /develop/);
  assert.match(queued, />Return to Backlog</);
  // Titles are text, never markup.
  assert.match(queued, /Fix &lt;script&gt;bug&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);

  const failed = columnHtml(html, 'failed');
  assert.match(failed, /Broken run/);
  assert.doesNotMatch(failed, /<button/, 'no actions are offered before run history exists');

  for (const status of ['in_progress', 'review', 'done', 'stopped', 'interrupted', 'discarded']) {
    assert.match(columnHtml(html, status), /No tasks/, status);
  }
  assert.doesNotMatch(html, /Retry|Resume|Request Changes|Mark Done|Start/);
  assert.match(html, new RegExp(`href="/projects/${projectId}/tasks/${id(1)}"`));
});
