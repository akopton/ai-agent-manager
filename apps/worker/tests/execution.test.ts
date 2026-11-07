import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { codexAdapter, getRuntimeSecurityProfile } from '@ai-agent-manager/agents';
import { defaultExecutionSecurityPolicy, isRunReviewEligible } from '@ai-agent-manager/core';
import {
  disableTrustedLocal,
  findLatestTaskCommand,
  findTaskById,
  listRunEvents,
  listTaskRuns,
  listTaskWorkspaces,
  requestRunStop,
  workerCommands,
} from '@ai-agent-manager/database';
import { captureGitIntegritySnapshot, createTaskWorktree } from '@ai-agent-manager/git';
import { authorizeAgentExecution } from '@ai-agent-manager/orchestrator';
import { WorkerLeaseUnavailableError } from '../src/execution/execution-service.js';
import { git, snapshotTree, waitFor, withExecutionFixture } from './execution-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

const sourceFiles = (repositoryRoot: string) =>
  [...snapshotTree(repositoryRoot).entries()].filter(([path]) => !path.startsWith('.git/'));

test('a queued Codex task runs in its own worktree and reaches Review only with a clean integrity check', async () => {
  await withExecutionFixture(async (fixture) => {
    const { db, repository } = fixture;
    // A disposable local bare remote, to show that nothing is pushed.
    const remote = join(fixture.directory, 'remote.git');
    git(fixture.directory, 'init', '--quiet', '--bare', remote);
    git(repository.root, 'remote', 'add', 'origin', remote);
    git(repository.root, 'push', '--quiet', 'origin', 'main');
    const remoteRefsBefore = git(remote, 'for-each-ref');
    const mainBefore = git(repository.root, 'rev-parse', 'main').trim();
    const sourceBefore = sourceFiles(repository.root);

    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const service = fixture.service();
    await service.start();
    try {
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(taskId, ['review', 'failed']), 'review');
    } finally {
      await service.stop();
    }

    const [run] = listTaskRuns(db, taskId);
    assert.ok(run);
    assert.equal(run.status, 'completed');
    assert.equal(run.attempt, 1);
    assert.equal(run.securityMode, 'trusted_local');
    assert.equal(run.processContainment, 'process_group_only');
    assert.equal(run.gitIntegrityStatus, 'clean');
    assert.equal(isRunReviewEligible(run), true);
    assert.equal(run.sessionId, 'thread-1');
    assert.equal(run.summary, 'Done.');
    assert.ok(run.authorizationId);
    // Honest safeguards: the post-run check is applied by the worker but not claimed by the gate.
    assert.ok(!JSON.parse(run.safeguardsJson ?? '[]').includes('post_run_git_integrity_check'));
    assert.equal(JSON.parse(run.acceptedRisksJson ?? '[]').length, 7);
    assert.equal(findLatestTaskCommand(db, taskId)?.status, 'accepted');

    const [workspace] = listTaskWorkspaces(db, taskId);
    assert.ok(workspace);
    assert.equal(workspace.branch, `agent/${taskId}`);
    assert.equal(workspace.baseBranch, 'main');
    assert.equal(workspace.baseSha, mainBefore);
    assert.equal(workspace.repositoryRoot, repository.root);
    assert.equal(workspace.gitCommonDir, repository.commonDir);
    assert.ok(workspace.path.startsWith(fixture.worktreeRoot));
    // The agent's file is retained, uncommitted; nothing was committed or pushed.
    assert.equal(readFileSync(join(workspace.path, 'feature.txt'), 'utf8'), 'implemented\n');
    assert.equal(git(repository.root, 'rev-parse', workspace.branch).trim(), mainBefore);
    assert.match(git(workspace.path, 'status', '--porcelain'), /\?\? feature.txt/);
    assert.equal(git(remote, 'for-each-ref'), remoteRefsBefore);
    // The source checkout is untouched.
    assert.equal(git(repository.root, 'rev-parse', 'main').trim(), mainBefore);
    assert.equal(git(repository.root, 'status', '--porcelain'), '');
    assert.deepEqual(sourceFiles(repository.root), sourceBefore);

    // The CLI got the composed prompt on stdin in the worktree; events never contain the prompt.
    const [invocation] = fixture.clis.codex.invocations();
    assert.equal(invocation?.cwd, workspace.path);
    assert.match(invocation?.stdin ?? '', /Project instructions:\nKeep changes small\./);
    assert.match(invocation?.stdin ?? '', /Secret prompt text/);
    const events = listRunEvents(db, run.id);
    const kinds = events.map((event) => event.kind);
    for (const kind of [
      'run_claimed',
      'worktree_created',
      'authorized',
      'agent_started',
      'agent_completed',
      'git_integrity',
      'run_finished',
    ]) {
      assert.ok(kinds.includes(kind), `missing event ${kind}`);
    }
    assert.ok(!JSON.stringify(events).includes('Secret prompt text'));
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_, index) => index + 1),
    );
  });
});

test('a failing CLI fails the task, keeps the worktree and still records the integrity check', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    fixture.clis.codex.setSteps([
      { writeFile: 'partial.txt', content: 'partial\n' },
      { stderr: 'something broke' },
      { exit: 3 },
    ]);
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const service = fixture.service();
    await service.start();
    try {
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(taskId, ['failed', 'review']), 'failed');
    } finally {
      await service.stop();
    }
    const [run] = listTaskRuns(fixture.db, taskId);
    assert.equal(run?.status, 'failed');
    assert.equal(run?.exitCode, 3);
    assert.ok(run?.errorCode === 'non_zero_exit' || run?.errorCode === 'provider_error');
    assert.equal(run?.gitIntegrityStatus, 'clean');
    const [workspace] = listTaskWorkspaces(fixture.db, taskId);
    assert.ok(workspace && existsSync(join(workspace.path, 'partial.txt')));
  });
});

test('Stop persists intent, stops the process group, retains partial files and frees the slot', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    fixture.clis.codex.setSteps([
      { stdout: { type: 'thread.started', thread_id: 'thread-stop' } },
      { writeFile: 'partial.txt', content: 'partial\n' },
      { hang: true },
    ]);
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const service = fixture.service();
    await service.start();
    try {
      await service.tick();
      await waitFor(() => listTaskRuns(fixture.db, taskId)[0]?.status === 'running');
      await waitFor(() => fixture.clis.codex.invocations().length === 1);
      // Launch is recorded before the fake CLI executes its steps. Stop only once there
      // is partial output to preserve, rather than racing its first write under load.
      await waitFor(() => {
        const [workspace] = listTaskWorkspaces(fixture.db, taskId);
        return workspace !== undefined && existsSync(join(workspace.path, 'partial.txt'));
      });
      requestRunStop(fixture.db, { taskId, now: Date.now() });
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(taskId, ['stopped', 'failed']), 'stopped');
    } finally {
      await service.stop();
    }
    const [run] = listTaskRuns(fixture.db, taskId);
    assert.equal(run?.status, 'stopped');
    assert.ok(run?.stopRequestedAt !== null);
    assert.equal(run?.gitIntegrityStatus, 'clean');
    const [workspace] = listTaskWorkspaces(fixture.db, taskId);
    assert.ok(workspace && existsSync(join(workspace.path, 'partial.txt')));
    // The runtime slot is free again.
    const next = fixture.queuedTask('codex');
    fixture.requestStart(next);
    fixture.clis.codex.setSteps([{ exit: 0 }]);
    const again = fixture.service();
    await again.start();
    try {
      await again.tick();
      assert.ok(
        ['review', 'failed'].includes(await fixture.waitForTaskStatus(next, ['review', 'failed'])),
      );
    } finally {
      await again.stop();
    }
  });
});

test('the mandatory timeout fails the run and terminates the process group', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    fixture.clis.codex.setSteps([{ hang: true }]);
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const service = fixture.service({ runTimeoutMs: 500 });
    await service.start();
    try {
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(taskId, ['failed', 'review']), 'failed');
    } finally {
      await service.stop();
    }
    const [run] = listTaskRuns(fixture.db, taskId);
    assert.equal(run?.errorCode, 'timeout');
    assert.equal(run?.timeoutMs, 500);
  });
});

test('an agent commit is a Git integrity violation: the task fails and is not review-eligible', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    fixture.clis.codex.setSteps([
      { writeFile: 'feature.txt', content: 'x\n' },
      { gitCommit: 'Agent commit' },
      { stdout: { type: 'turn.completed', usage: {} } },
    ]);
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const service = fixture.service();
    await service.start();
    try {
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(taskId, ['failed', 'review']), 'failed');
    } finally {
      await service.stop();
    }
    const [run] = listTaskRuns(fixture.db, taskId);
    assert.ok(run);
    assert.equal(run.status, 'completed', 'the process outcome is kept separately');
    assert.equal(run.gitIntegrityStatus, 'violation');
    assert.equal(run.errorCode, 'git_integrity_violation');
    assert.equal(isRunReviewEligible(run), false);
    const result = JSON.parse(run.gitIntegrityResultJson ?? '{}');
    assert.ok(
      result.findings.some((finding: { code: string }) => finding.code === 'task_branch_moved'),
    );
    // Evidence is retained: the agent's commit is still on the task branch.
    const [workspace] = listTaskWorkspaces(fixture.db, taskId);
    assert.ok(workspace);
    assert.notEqual(
      git(fixture.repository.root, 'rev-parse', workspace.branch).trim(),
      workspace.baseSha,
    );
  });
});

test('an inconclusive integrity check also blocks Review', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const service = fixture.service({
      verifyIntegrity: async () => {
        throw new Error('inspection failed');
      },
    });
    await service.start();
    try {
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(taskId, ['failed', 'review']), 'failed');
    } finally {
      await service.stop();
    }
    const [run] = listTaskRuns(fixture.db, taskId);
    assert.equal(run?.status, 'completed');
    assert.equal(run?.gitIntegrityStatus, 'inconclusive');
    assert.equal(run?.errorCode, 'git_integrity_inconclusive');
  });
});

test('nothing launches without persisted consent, even for a command written directly', async () => {
  await withExecutionFixture(async (fixture) => {
    const taskId = fixture.queuedTask('codex');
    // Bypass the request check, as a forged or stale command would.
    fixture.db
      .insert(workerCommands)
      .values({
        id: randomUUID(),
        kind: 'start_task',
        taskId,
        status: 'pending',
        createdAt: Date.now(),
      })
      .run();
    const service = fixture.service();
    await service.start();
    try {
      await service.tick();
    } finally {
      await service.stop();
    }
    assert.equal(
      findLatestTaskCommand(fixture.db, taskId)?.resultCode,
      'trusted_local_not_enabled',
    );
    assert.equal(findTaskById(fixture.db, taskId)?.status, 'queued');
    assert.equal(listTaskRuns(fixture.db, taskId).length, 0);
    assert.equal(fixture.clis.codex.invocations().length, 0);
    assert.equal(existsSync(fixture.worktreeRoot), false);
  });
});

test('consent revoked after the claim is enforced before authorization; the CLI never starts', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const service = fixture.service({
      captureBaseline: async (options) => {
        disableTrustedLocal(fixture.db, { now: Date.now() });
        return captureGitIntegritySnapshot(options);
      },
    });
    await service.start();
    try {
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(taskId, ['failed', 'review']), 'failed');
    } finally {
      await service.stop();
    }
    const [run] = listTaskRuns(fixture.db, taskId);
    assert.equal(run?.errorCode, 'trusted_local_not_enabled');
    assert.equal(run?.authorizationId, null);
    assert.equal(fixture.clis.codex.invocations().length, 0);
    assert.equal(run?.gitIntegrityStatus, 'clean');
  });
});

test('one active run per runtime: a second Codex start is refused while Claude runs concurrently', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    fixture.clis.codex.setSteps([{ hang: true }]);
    const first = fixture.queuedTask('codex');
    const second = fixture.queuedTask('codex');
    const claude = fixture.queuedTask('claude');
    const service = fixture.service();
    await service.start();
    try {
      fixture.requestStart(first);
      await service.tick();
      await waitFor(() => listTaskRuns(fixture.db, first)[0]?.status === 'running');
      fixture.requestStart(second);
      fixture.requestStart(claude);
      await service.tick();
      assert.equal(findLatestTaskCommand(fixture.db, second)?.resultCode, 'runtime_busy');
      assert.equal(findTaskById(fixture.db, second)?.status, 'queued');
      assert.equal(await fixture.waitForTaskStatus(claude, ['review', 'failed']), 'review');
      assert.equal(findTaskById(fixture.db, first)?.status, 'in_progress');
      requestRunStop(fixture.db, { taskId: first, now: Date.now() });
      await service.tick();
      assert.equal(await fixture.waitForTaskStatus(first, ['stopped']), 'stopped');
    } finally {
      await service.stop();
    }
    const [claudeRun] = listTaskRuns(fixture.db, claude);
    assert.equal(claudeRun?.sessionId, 'session-1');
    assert.equal(claudeRun?.effectiveModelId, 'fake-model');
  });
});

test('a second worker cannot take the lease; concurrent ticks claim a command once', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const service = fixture.service();
    await service.start();
    const other = fixture.service({ db: fixture.reopen().db });
    try {
      await assert.rejects(other.start(), WorkerLeaseUnavailableError);
      await Promise.all([service.tick(), service.tick(), service.tick()]);
      await fixture.waitForTaskStatus(taskId, ['review', 'failed']);
    } finally {
      await service.stop();
    }
    assert.equal(listTaskRuns(fixture.db, taskId).length, 1);
    assert.equal(fixture.clis.codex.invocations().length, 1);
  });
});

test('after a worker process crash the next worker marks the run Interrupted and never relaunches it', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    fixture.clis.codex.setSteps([{ hang: true }]);
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--conditions=@ai-agent-manager/source',
        join(here, 'crash-worker.ts'),
        JSON.stringify({
          databasePath: fixture.databasePath,
          worktreeRoot: fixture.worktreeRoot,
          codexPath: fixture.clis.codex.executablePath,
        }),
      ],
      { cwd: join(here, '..'), stdio: 'ignore', shell: false },
    );
    const exited = new Promise((resolve) => child.once('exit', resolve));
    let orphanPid: number | null = null;
    try {
      await waitFor(() => listTaskRuns(fixture.db, taskId)[0]?.status === 'running', 20_000);
      orphanPid = listTaskRuns(fixture.db, taskId)[0]?.pid ?? null;
      // Crash: no shutdown, no lease release. The CLI's process group survives its parent.
      child.kill('SIGKILL');
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 400));

      const restarted = fixture.service({ db: fixture.reopen().db });
      await restarted.start();
      try {
        const [run] = listTaskRuns(fixture.db, taskId);
        assert.equal(run?.status, 'interrupted');
        assert.equal(run?.errorCode, 'worker_restarted');
        assert.match(run?.errorMessage ?? '', /not resumed or retried automatically/);
        assert.match(run?.errorMessage ?? '', /was not signalled/);
        assert.equal(run?.gitIntegrityStatus, 'clean');
        assert.equal(findTaskById(fixture.db, taskId)?.status, 'interrupted');
        await restarted.tick();
        assert.equal(listTaskRuns(fixture.db, taskId).length, 1);
        assert.equal(fixture.clis.codex.invocations().length, 1);
        const [workspace] = listTaskWorkspaces(fixture.db, taskId);
        assert.ok(workspace && existsSync(workspace.path));
      } finally {
        await restarted.stop();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      // Test cleanup only: end the orphaned fake CLI's process group.
      if (orphanPid !== null) {
        try {
          process.kill(-orphanPid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });
});

test('a graceful worker shutdown records active runs as Interrupted, not Stopped', async () => {
  await withExecutionFixture(async (fixture) => {
    fixture.grantConsent();
    fixture.clis.codex.setSteps([{ hang: true }]);
    const taskId = fixture.queuedTask('codex');
    fixture.requestStart(taskId);
    const service = fixture.service();
    await service.start();
    await service.tick();
    await waitFor(() => listTaskRuns(fixture.db, taskId)[0]?.status === 'running');
    await service.stop();
    const [run] = listTaskRuns(fixture.db, taskId);
    assert.equal(run?.status, 'interrupted');
    assert.equal(run?.errorCode, 'worker_shutdown');
    assert.equal(findTaskById(fixture.db, taskId)?.status, 'interrupted');
  });
});

test('Strict Isolated Mode stays fail-closed for the shipped profile', async () => {
  await withExecutionFixture(async (fixture) => {
    const worktree = await createTaskWorktree({
      repositoryPath: fixture.repository.root,
      baseBranch: 'main',
      taskId: 'strict-check',
      worktreeRoot: fixture.worktreeRoot,
    });
    const detection = await codexAdapter.detect({
      executablePath: fixture.clis.codex.executablePath,
    });
    assert.equal(detection.status, 'available');
    if (detection.status !== 'available') return;
    const preparation = codexAdapter.prepareExecution(detection.installation, {
      runId: 'strict',
      prompt: 'p',
      modelId: null,
      workingDirectory: worktree.path,
    });
    assert.ok(preparation.ok);
    if (!preparation.ok) return;
    const decision = await authorizeAgentExecution({
      runtime: 'codex',
      runtimeVersion: detection.installation.version,
      profile: getRuntimeSecurityProfile('codex'),
      policy: defaultExecutionSecurityPolicy,
      invocation: preparation.plan.invocation,
      workspace: {
        taskId: 'strict-check',
        repositoryPath: worktree.repository.root,
        commonDir: worktree.repository.commonDir,
        worktreeRoot: fixture.worktreeRoot,
        worktreePath: worktree.path,
        branchName: worktree.branch,
        baseCommit: worktree.baseCommit,
      },
    });
    assert.equal(decision.authorized, false);
    assert.ok(
      !decision.authorized &&
        decision.denials.some((denial) => denial.code === 'control_not_enforced'),
    );
  });
});

test('worker sources never import the diagnostics supervisor or the Trusted Local issuer', () => {
  const sourceRoot = join(here, '..', 'src');
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  visit(sourceRoot);
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!source.includes('agents/diagnostics'), file);
    assert.ok(!source.includes('trusted-local-issuer'), file);
    assert.ok(!source.includes('cli-diagnostics'), file);
    assert.ok(!/\bauthorizationId:\s*randomUUID/.test(source), file);
  }
});
