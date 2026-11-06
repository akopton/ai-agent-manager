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
import { TaskArchiveActions } from '@/components/tasks/task-archive-actions';
import { ArchivedTaskList, TaskBoard } from '@/components/tasks/task-board';
import { TaskWorkspacePanel } from '@/components/tasks/task-workspace-panel';
import { partitionArchivedTasks } from '@/lib/tasks/board';
import type { WorkspacePanel } from '@/lib/tasks/workspace';

// TM-02 UI: the workspace panel, Archive/Restore controls and the Archived tasks view render the
// server-derived state honestly, and Archive, Discard and Remove local worktree stay distinct.

const projectId = '00000000-0000-4000-8000-00000000000a';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const commit = 'c'.repeat(40);

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

const task = (overrides: Partial<Task> = {}): Task => ({
  id: id(1),
  projectId,
  title: 'Finished task',
  prompt: 'Prompt',
  agentRuntime: 'claude',
  modelId: null,
  baseBranch: null,
  priority: 'normal',
  urgent: false,
  status: 'done',
  queuedAt: null,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
  ...overrides,
});

const panel = (overrides: Partial<WorkspacePanel> = {}): WorkspacePanel => ({
  state: 'retained',
  workspace: {
    id: id(50),
    path: '/data/worktrees/website-0123/task',
    branch: `agent/${id(1)}`,
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    createdAt: 1,
  },
  git: {
    registered: true,
    pathExists: true,
    locked: true,
    managedLock: true,
    branchCommit: commit,
    headCommit: commit,
    identityVerified: true,
    identityReason: null,
    workingTree: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    ignoredCount: 0,
  },
  cleanup: { available: true, expectedCommit: commit, basis: 'published', reasons: [] },
  current: null,
  history: [],
  ...overrides,
});

const renderPanel = (value: WorkspacePanel) =>
  render(
    createElement(TaskWorkspacePanel, {
      projectId,
      task: { id: id(1), title: 'Finished task' },
      panel: value,
    }),
  );

test('a removable worktree shows its path, branch and lock, and a separate confirmation trigger', () => {
  const html = renderPanel(panel());
  assert.match(html, /Local worktree/);
  assert.match(html, /Retained/);
  assert.match(html, /\/data\/worktrees\/website-0123\/task/);
  assert.match(html, /agent\/00000000-0000-4000-8000-000000000001/);
  assert.match(html, /Locked by AI Agent Manager/);
  assert.match(html, /Clean \(no uncommitted or untracked files\)/);
  assert.match(html, /aria-label="Remove local worktree: Finished task"/);
  assert.match(html, /Remove local worktree…/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /Archive and Discard never remove it/);
});

test('an unavailable removal lists every reason and offers no button', () => {
  const html = renderPanel(
    panel({
      git: {
        ...panel().git!,
        workingTree: { clean: false, staged: 0, unstaged: 1, untracked: 2, conflicted: 0 },
      },
      cleanup: {
        available: false,
        expectedCommit: null,
        basis: null,
        reasons: [
          'The worktree has uncommitted or untracked files (1 changed path, 2 untracked paths).',
        ],
      },
    }),
  );
  assert.match(html, /Remove local worktree unavailable/);
  assert.match(html, /1 changed, 2 untracked/);
  assert.match(html, /2 untracked paths/);
  assert.doesNotMatch(html, /aria-label="Remove local worktree/);
});

test('a requested, failed or completed removal is shown as such', () => {
  const base = {
    id: id(60),
    basis: 'published' as const,
    expectedCommit: commit,
    branchCommit: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  };
  const requested = renderPanel(
    panel({
      current: { ...base, status: 'requested' },
      cleanup: { available: false, expectedCommit: null, basis: null, reasons: ['In progress.'] },
    }),
  );
  assert.match(requested, /role="status"/);
  assert.match(requested, /Removal requested, waiting for the worker/);
  assert.doesNotMatch(requested, /Remove local worktree…/);

  const failed = renderPanel(
    panel({
      current: { ...base, status: 'failed', errorMessage: 'Untracked files. Nothing was removed.' },
    }),
  );
  assert.match(failed, /The last removal did not complete/);
  assert.match(failed, /Nothing was removed/);

  const removed = renderPanel(
    panel({
      state: 'removed',
      git: null,
      current: { ...base, status: 'removed', branchCommit: commit, removedAt: 2 },
      cleanup: { available: false, expectedCommit: null, basis: null, reasons: [] },
    }),
  );
  assert.match(removed, /Local worktree removed/);
  assert.match(removed, /task branch was kept at cccccccccccc/);
  assert.match(removed, /records are kept/);
  assert.doesNotMatch(removed, /Remove local worktree…/);
});

test('Archive and Restore are plain, reversible actions distinct from Discard and removal', () => {
  const archive = render(
    createElement(TaskArchiveActions, {
      projectId,
      task: { id: id(1), title: 'Finished task' },
      option: { archived: false, available: true, reason: null },
    }),
  );
  assert.match(archive, /aria-label="Archive: Finished task"/);
  assert.match(archive, /Nothing is deleted/);
  assert.doesNotMatch(archive, /Discard|Remove/);

  const restore = render(
    createElement(TaskArchiveActions, {
      projectId,
      task: { id: id(1), title: 'Finished task' },
      option: { archived: true, available: false, reason: null },
    }),
  );
  assert.match(restore, /aria-label="Restore: Finished task"/);

  const unavailable = { archived: false, available: false, reason: 'An attempt is active.' };
  const props = { projectId, task: { id: id(1), title: 'Finished task' }, option: unavailable };
  assert.equal(render(createElement(TaskArchiveActions, props)), '');
  assert.match(
    render(createElement(TaskArchiveActions, { ...props, showUnavailableReason: true })),
    /Archive unavailable: An attempt is active\./,
  );
});

test('the default board excludes archived tasks; the archived view lists them with Restore', () => {
  const active = task({ id: id(1), title: 'Active done task' });
  const archived = task({ id: id(2), title: 'Archived task', archivedAt: 5 });
  const views = partitionArchivedTasks([active, archived]);
  const board = render(
    createElement(TaskBoard, {
      tasks: views.active,
      projectDefaultBranch: 'main',
      archiveOptions: { [active.id]: { archived: false, available: true, reason: null } },
    }),
  );
  assert.match(board, /Active done task/);
  assert.doesNotMatch(board, /Archived task/);
  assert.match(board, /aria-label="Archive: Active done task"/);

  const list = render(
    createElement(ArchivedTaskList, {
      tasks: views.archived,
      projectDefaultBranch: 'main',
      archiveOptions: { [archived.id]: { archived: true, available: false, reason: null } },
    }),
  );
  assert.match(list, /Archived task/);
  assert.match(list, />Archived</);
  assert.match(list, /aria-label="Restore: Archived task"/);
  // Lifecycle actions are not offered for an archived task.
  assert.doesNotMatch(list, /Queue|Retry|Discard/);
});
