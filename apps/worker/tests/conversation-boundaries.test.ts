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
  // C4: project-aware retrieval and its persistence.
  join(repositoryRoot, 'packages/core/src/project-context.ts'),
  join(repositoryRoot, 'packages/database/src/project-source-access.ts'),
];

const forbidden: readonly RegExp[] = [
  // C4: only the read-only source-context subpath of the Git package is allowed.
  /@ai-agent-manager\/git(?!\/source-context')/,
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

test('C4: the source-context module runs only read-only Git subcommands and never the filesystem', () => {
  const source = code(join(repositoryRoot, 'packages/git/src/source-context.ts'));
  const subcommands = new Set(
    [...source.matchAll(/runGit(?:Checked)?\(\s*\[\s*'([a-z-]+)'/g)].map((match) => match[1]),
  );
  assert.deepEqual([...subcommands].sort(), [
    'cat-file',
    'grep',
    'ls-files',
    'ls-tree',
    'rev-parse',
    'symbolic-ref',
  ]);
  for (const pattern of [
    /node:fs|node:child_process|from 'fs'/,
    /\b(?:writeFile|appendFile|mkdir|rmSync|unlink|rename|copyFile|symlink)\b/,
    /indexFile|GIT_INDEX_FILE/,
    /'(?:add|commit|push|fetch|pull|checkout|switch|reset|restore|worktree|update-ref|update-index|config|gc|stash|branch|tag|merge|rebase|clean|apply)'/,
  ]) {
    assert.doesNotMatch(source, pattern);
  }
  // Its only local imports are the hardened process runner, errors and repository validation.
  assert.deepEqual([...source.matchAll(/from '(\.[^']+)'/g)].map((match) => match[1]).sort(), [
    './errors.js',
    './process.js',
    './repository.js',
  ]);
  // Worker retrieval reads the repository only through this module.
  const retrieval = code(
    join(repositoryRoot, 'apps/worker/src/conversations/repository-context.ts'),
  );
  assert.match(retrieval, /from '@ai-agent-manager\/git\/source-context'/);
  assert.doesNotMatch(retrieval, /node:fs|node:child_process|@ai-agent-manager\/git'/);
});
