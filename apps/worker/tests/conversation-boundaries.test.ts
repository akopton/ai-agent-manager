import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// C2 architecture check (`IMPLEMENTATION_PLAN.md` §9.3 test 8): conversation code cannot obtain
// or use an execution authorization, create worktrees, run Git, touch tasks or publish. A static
// check of imports and identifiers, in addition to the separate authorization types.

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

const conversationFiles = [
  ...readdirSync(join(repositoryRoot, 'apps/worker/src/conversations')).map((name) =>
    join(repositoryRoot, 'apps/worker/src/conversations', name),
  ),
  join(repositoryRoot, 'packages/orchestrator/src/conversation-gate.ts'),
  join(repositoryRoot, 'packages/agents/src/conversation-launch.ts'),
  join(repositoryRoot, 'packages/agents/src/conversation-profiles.ts'),
  join(repositoryRoot, 'packages/agents/src/conversation-issuance.ts'),
  join(repositoryRoot, 'packages/database/src/conversation-turns.ts'),
  // C3: proposal generation runs in the worker and may only store drafts.
  join(repositoryRoot, 'packages/database/src/task-proposal-generations.ts'),
  join(repositoryRoot, 'packages/core/src/task-proposal.ts'),
];

const forbidden: readonly RegExp[] = [
  /@ai-agent-manager\/git/,
  /@ai-agent-manager\/agents\/(?:diagnostics|trusted-local-issuer)/,
  /node:child_process/,
  /\b(?:startAgentExecution|authorizeTrustedLocalExecution|authorizeAgentExecution)\b/,
  /\b(?:createTaskWorktree|verifyWorkspace|captureGitIntegritySnapshot|verifyGitIntegrity)\b/,
  /\b(?:createTask|transitionTask|updateTask|requestTaskExecution|claimStartCommand)\b/,
  /\b(?:createPublication|approvePublication|requestWorkspaceCleanup)\b/,
  /\b(?:workerCommands|taskRuns|workspaces|publications)\b/,
  /from '\.\.\/(?:execution|publication|workspace)\//,
  /trusted-local-gate|execution-gate\.js'.*verifyWorkspace/,
];

/** Source without comments, so documentation may name what the code must not use. */
const code = (file: string): string =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('conversation code has no path to execution authorizations, Git, tasks or publishing', () => {
  assert.ok(conversationFiles.length >= 8);
  for (const file of conversationFiles) {
    const source = code(file);
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} must not match ${pattern}`);
    }
  }
});

test('the execution path does not import the conversation launch boundary or issuer', () => {
  const executionFiles = [
    join(repositoryRoot, 'apps/worker/src/execution/run-executor.ts'),
    join(repositoryRoot, 'packages/agents/src/execution-launch.ts'),
    join(repositoryRoot, 'packages/orchestrator/src/trusted-local-gate.ts'),
  ];
  for (const file of executionFiles) {
    const source = code(file);
    assert.doesNotMatch(
      source,
      /startConversationTurn|conversation-issuer|claimConversationIssuer/,
    );
  }
});

test('C3: the worker has no approval or proposal-editing capability', () => {
  for (const file of conversationFiles) {
    assert.doesNotMatch(
      code(file),
      /\b(?:approveTaskProposal|updateTaskProposal|rejectTaskProposal|reopenTaskProposal)\b|task-proposals\.js/,
      `${file} must not reach operator proposal commands`,
    );
  }
});

test('C3: approval creates a task through createTask only and never queues, starts or runs Git', () => {
  const approval = code(join(repositoryRoot, 'packages/database/src/task-proposals.ts'));
  assert.match(approval, /\bcreateTask\(tx,/);
  for (const pattern of [
    /\b(?:transitionTask|requestTaskExecution|claimStartCommand|requestTaskRecovery)\b/,
    /\b(?:workerCommands|taskRuns|workspaces|publications|workspaceCleanups)\b/,
    /\b(?:createPublication|requestWorkspaceCleanup|createTaskWorktree)\b/,
    /@ai-agent-manager\/(?:git|agents|orchestrator)/,
    /node:child_process/,
    /status: 'queued'/,
  ]) {
    assert.doesNotMatch(approval, pattern);
  }
  // The web side of approval only adds a read-only branch check.
  const web = code(join(repositoryRoot, 'apps/web/lib/server/task-proposals.ts'));
  for (const pattern of [
    /@ai-agent-manager\/(?:git|agents|orchestrator)/,
    /lib\/server\/(?:execution|review|publication|recovery|workspace|tasks)\b/,
    /\b(?:transitionTask|requestTaskExecution|createTask)\b/,
  ]) {
    assert.doesNotMatch(web, pattern);
  }
});
