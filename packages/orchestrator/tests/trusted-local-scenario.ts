import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  codexAdapter,
  startAgentExecution,
  type AgentEvent,
  type CliInstallation,
} from '@ai-agent-manager/agents';
import { securityControls, type SecurityModeAuthorization } from '@ai-agent-manager/core';
import { createTaskWorktree } from '@ai-agent-manager/git';
import {
  authorizeTrustedLocalExecution,
  type AuthorizeTrustedLocalExecutionRequest,
  type TrustedLocalState,
} from '../src/index.js';
import { createFakeCodexCli, createRepository } from './fixtures.js';

// Shared Trusted Local end-to-end scenario: the public gate and the public launch boundary,
// against a disposable repository, a real task worktree and a fake Codex CLI. Used by the tests
// in this process and by child processes that load the packages in a different order.

const disclosureVersion = '2026-11-04.1';
export const prompt = 'Implement the task. Secret prompt text.';

export type Setup = {
  worktreePath: string;
  installation: CliInstallation;
  fake: ReturnType<typeof createFakeCodexCli>;
  state: TrustedLocalState;
  request: (
    run?: { runId: string; prompt: string },
    timeoutMs?: number,
  ) => AuthorizeTrustedLocalExecutionRequest;
};

export const setUp = async (directory: string): Promise<Setup> => {
  const root = createRepository(join(directory, 'my project'));
  const worktreeRoot = join(directory, 'worktree root');
  const worktree = await createTaskWorktree({
    repositoryPath: root,
    baseBranch: 'main',
    taskId: 'task-1',
    worktreeRoot,
  });
  const fake = createFakeCodexCli(join(directory, 'bin'));
  const detection = await codexAdapter.detect({ executablePath: fake.executablePath });
  assert.equal(detection.status, 'available', JSON.stringify(detection));
  if (detection.status !== 'available') throw new Error('fake CLI not detected');
  const { installation } = detection;
  const acceptedAt = new Date(Date.now() - 60_000).toISOString();
  const state: TrustedLocalState = {
    enabled: true,
    currentDisclosureVersion: disclosureVersion,
    acceptance: { disclosureVersion, acceptedAt, acceptedRisks: [...securityControls] },
    trustedRepositories: [
      {
        root: worktree.repository.root,
        commonDir: worktree.repository.commonDir,
        trustedAt: new Date(Date.now() - 120_000).toISOString(),
      },
    ],
  };
  const request = (run = { runId: 'run-1', prompt }, timeoutMs = 60_000) => {
    const preparation = codexAdapter.prepareExecution(installation, {
      ...run,
      modelId: null,
      workingDirectory: worktree.path,
      timeoutMs,
    });
    if (!preparation.ok) throw new Error(preparation.message);
    return {
      policy: {
        mode: 'trusted_local',
        version: 1,
        acceptance: { disclosureVersion, acceptedAt },
        acceptedRisks: [...securityControls],
        interactiveApproval: 'deny',
        timeoutMs,
      },
      run,
      runtime: 'codex' as const,
      installation,
      modelId: null,
      invocation: preparation.plan.invocation,
      workspace: {
        taskId: 'task-1',
        repositoryPath: worktree.repository.root,
        commonDir: worktree.repository.commonDir,
        worktreeRoot,
        worktreePath: worktree.path,
        branchName: worktree.branch,
        baseCommit: worktree.baseCommit,
      },
    };
  };
  return { worktreePath: worktree.path, installation, fake, state, request };
};

export const authorize = async (
  setup: Setup,
  run = { runId: 'run-1', prompt },
  timeoutMs?: number,
) => {
  const decision = await authorizeTrustedLocalExecution(setup.request(run, timeoutMs), setup.state);
  assert.equal(decision.authorized, true, JSON.stringify(decision));
  if (!decision.authorized) throw new Error('not authorized');
  return decision.authorization;
};

export const launch = (
  setup: Setup,
  authorization: unknown,
  run = { runId: 'run-1', prompt },
  emit: (event: AgentEvent) => void = () => undefined,
) =>
  startAgentExecution({
    securityMode: 'trusted_local',
    adapter: codexAdapter,
    installation: setup.installation,
    request: { ...run, modelId: null, workingDirectory: setup.worktreePath },
    authorization: authorization as SecurityModeAuthorization,
    emit,
    limits: { stopGraceMs: 300 },
  });

export type ScenarioOutcome =
  | { authorized: false; codes: string[] }
  | { authorized: true; launch: string; securityMode?: string; reused: string };

/** Authorizes, launches to completion, then tries to launch the same authorization again. */
export const runScenario = async (directory: string): Promise<ScenarioOutcome> => {
  const setup = await setUp(directory);
  const decision = await authorizeTrustedLocalExecution(setup.request(), setup.state);
  if (!decision.authorized) {
    return { authorized: false, codes: decision.denials.map((denial) => denial.code) };
  }
  const started = await launch(setup, decision.authorization);
  if (!started.started) {
    return { authorized: true, launch: started.code, reused: 'not attempted' };
  }
  const result = await started.handle.completed;
  const again = await launch(setup, JSON.parse(JSON.stringify(decision.authorization)));
  return {
    authorized: true,
    launch: result.status,
    securityMode: result.securityMode,
    reused: again.started ? 'started' : again.code,
  };
};
