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
  assert.ok(conversationFiles.length >= 6);
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
