import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessTaskArchive,
  assessWorkspaceCleanup,
  requestWorkspaceCleanupInputSchema,
  taskStatuses,
  type TaskArchiveFacts,
  type WorkspaceCleanupFacts,
} from '../src/index.js';

// TM-02 rules: which tasks may be archived, and which records allow removing a task worktree.

const baseSha = 'a'.repeat(40);
const commitSha = 'c'.repeat(40);

const facts = (overrides: Partial<WorkspaceCleanupFacts> = {}): WorkspaceCleanupFacts => ({
  taskStatus: 'done',
  workspace: { id: 'ws-1', baseSha },
  workspaceCount: 1,
  latestRun: { id: 'run-1', status: 'completed', workspaceId: 'ws-1' },
  activeRun: false,
  pendingStart: false,
  pendingFollowUp: false,
  blockingPublication: false,
  latestPublication: { runId: 'run-1', workspaceId: 'ws-1', status: 'pushed', commitSha },
  cleanup: null,
  ...overrides,
});

const code = (input: WorkspaceCleanupFacts) => {
  const result = assessWorkspaceCleanup(input);
  return result.ok ? 'ok' : result.code;
};

test('a Done task with a confirmed push of its latest attempt may remove its worktree', () => {
  assert.deepEqual(assessWorkspaceCleanup(facts()), {
    ok: true,
    basis: 'published',
    expectedCommit: commitSha,
  });
});

test('a Discarded task may remove its worktree only at the base commit', () => {
  assert.deepEqual(
    assessWorkspaceCleanup(facts({ taskStatus: 'discarded', latestPublication: null })),
    { ok: true, basis: 'discarded_unchanged', expectedCommit: baseSha },
  );
});

test('every other status keeps the worktree', () => {
  for (const status of taskStatuses) {
    if (status === 'done' || status === 'discarded') continue;
    const result = code(facts({ taskStatus: status }));
    assert.notEqual(result, 'ok', status);
  }
  assert.equal(code(facts({ taskStatus: 'review' })), 'worktree_still_needed');
  assert.equal(code(facts({ taskStatus: 'failed' })), 'worktree_still_needed');
  assert.equal(code(facts({ taskStatus: 'stopped' })), 'worktree_still_needed');
  assert.equal(code(facts({ taskStatus: 'interrupted' })), 'worktree_still_needed');
  assert.equal(code(facts({ taskStatus: 'in_progress' })), 'task_active');
  assert.equal(code(facts({ taskStatus: 'queued' })), 'task_active');
});

test('active work, pending follow-ups and publications refuse removal', () => {
  assert.equal(code(facts({ activeRun: true })), 'task_active');
  assert.equal(code(facts({ pendingStart: true })), 'task_active');
  assert.equal(
    code(facts({ latestRun: { id: 'run-1', status: 'stopping', workspaceId: 'ws-1' } })),
    'task_active',
  );
  assert.equal(code(facts({ pendingFollowUp: true })), 'worktree_still_needed');
  assert.equal(code(facts({ blockingPublication: true })), 'publication_in_progress');
});

test('an unconfirmed push or a different attempt or workspace refuses removal', () => {
  for (const status of ['approved', 'committed', 'pushing', 'failed'] as const) {
    assert.equal(
      code(
        facts({
          latestPublication: { runId: 'run-1', workspaceId: 'ws-1', status, commitSha },
        }),
      ),
      'not_published',
      status,
    );
  }
  assert.equal(code(facts({ latestPublication: null })), 'not_published');
  assert.equal(
    code(
      facts({
        latestPublication: { runId: 'run-0', workspaceId: 'ws-1', status: 'pushed', commitSha },
      }),
    ),
    'not_published',
  );
  assert.equal(
    code(
      facts({
        latestPublication: {
          runId: 'run-1',
          workspaceId: 'ws-1',
          status: 'pushed',
          commitSha: 'x',
        },
      }),
    ),
    'not_published',
  );
  assert.equal(code(facts({ workspaceCount: 2 })), 'workspace_ambiguous');
  assert.equal(
    code(facts({ latestRun: { id: 'run-1', status: 'completed', workspaceId: 'ws-2' } })),
    'workspace_not_latest',
  );
});

test('a running or completed removal refuses another one', () => {
  assert.equal(code(facts({ cleanup: { status: 'requested' } })), 'cleanup_in_progress');
  assert.equal(code(facts({ cleanup: { status: 'removing' } })), 'cleanup_in_progress');
  assert.equal(code(facts({ cleanup: { status: 'removed' } })), 'already_removed');
  assert.equal(code(facts({ cleanup: { status: 'failed' } })), 'ok');
});

test('the cleanup request names a workspace and a commit, never a path, and needs confirmation', () => {
  const valid = {
    requestId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    expectedCommit: commitSha,
    confirmed: true,
  };
  assert.equal(requestWorkspaceCleanupInputSchema.safeParse(valid).success, true);
  assert.equal(
    requestWorkspaceCleanupInputSchema.safeParse({ ...valid, confirmed: false }).success,
    false,
  );
  assert.equal(
    requestWorkspaceCleanupInputSchema.safeParse({ ...valid, path: '/tmp/x' }).success,
    false,
  );
  assert.equal(
    requestWorkspaceCleanupInputSchema.safeParse({ ...valid, expectedCommit: 'HEAD' }).success,
    false,
  );
});

const archiveFacts = (overrides: Partial<TaskArchiveFacts> = {}): TaskArchiveFacts => ({
  status: 'done',
  archived: false,
  activeRun: false,
  pendingStart: false,
  blockingPublication: false,
  pendingCleanup: false,
  ...overrides,
});

test('only inactive tasks without pending work can be archived', () => {
  for (const status of [
    'backlog',
    'done',
    'discarded',
    'failed',
    'stopped',
    'interrupted',
  ] as const) {
    assert.equal(assessTaskArchive(archiveFacts({ status })).ok, true, status);
  }
  for (const status of ['queued', 'in_progress', 'review'] as const) {
    assert.equal(assessTaskArchive(archiveFacts({ status })).ok, false, status);
  }
  for (const flag of [
    'archived',
    'activeRun',
    'pendingStart',
    'blockingPublication',
    'pendingCleanup',
  ] as const) {
    assert.equal(assessTaskArchive(archiveFacts({ [flag]: true })).ok, false, flag);
  }
});
