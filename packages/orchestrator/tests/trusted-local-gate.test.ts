import assert from 'node:assert/strict';
import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  codexAdapter,
  getAgentAdapter,
  startAgentExecution,
  type CliInstallation,
} from '@ai-agent-manager/agents';
import {
  mandatoryTrustedLocalSafeguards,
  securityControls,
  strictExecutionAuthorizationSchema,
  trustedLocalExecutionAuthorizationSchema,
  type AgentRuntime,
  type SecurityDenialCode,
  type TrustedLocalAuthorizationDecision,
} from '@ai-agent-manager/core';
import { createTaskWorktree } from '@ai-agent-manager/git';
import {
  authorizeAgentExecution,
  authorizeTrustedLocalExecution,
  type AuthorizeTrustedLocalExecutionRequest,
  type ExecutionWorkspaceRequest,
  type TrustedLocalState,
} from '../src/index.js';
import {
  createTrustedLocalGate,
  type TrustedLocalGateDependencies,
} from '../src/trusted-local-gate.js';
import { createRepository, git, snapshot, withFixtures, writeFile } from './fixtures.js';

const now = new Date('2026-11-04T12:00:00.000Z');
const disclosureVersion = '2026-11-04.1';
const acceptedAt = '2026-11-04T10:00:00.000Z';
const environment: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/operator',
  LANG: 'C',
};

const cliFacts: Record<AgentRuntime, { version: string; options: string[] }> = {
  claude: {
    version: '2.1.317',
    options: [
      '--model',
      '--output-format',
      '--permission-mode',
      '--permission-prompts',
      '--print',
      '--restricted',
      '--strict-mcp-config',
      '--verbose',
    ],
  },
  codex: {
    version: '0.166.0',
    options: ['--ignore-rules', '--ignore-user-config', '--json', '--model', '--sandbox'],
  },
};

const dependencies = (overrides: Partial<TrustedLocalGateDependencies> = {}) => ({
  now: () => now,
  effectiveUid: () => 501,
  sourceEnvironment: () => environment,
  ...overrides,
});

type Fixture = {
  root: string;
  workspace: ExecutionWorkspaceRequest;
  installation: CliInstallation;
  executablePath: string;
  state: (overrides?: Partial<TrustedLocalState>) => TrustedLocalState;
  request: (
    overrides?: Partial<AuthorizeTrustedLocalExecutionRequest> & { policy?: unknown },
  ) => AuthorizeTrustedLocalExecutionRequest;
};

const trustedPolicy = (overrides: Record<string, unknown> = {}) => ({
  mode: 'trusted_local',
  version: 1,
  acceptance: { disclosureVersion, acceptedAt },
  acceptedRisks: [...securityControls],
  interactiveApproval: 'deny',
  timeoutMs: 30 * 60 * 1000,
  ...overrides,
});

const setUp = async (directory: string, runtime: AgentRuntime = 'codex'): Promise<Fixture> => {
  const root = createRepository(join(directory, 'my project'));
  const worktreeRoot = join(directory, 'worktree root');
  const worktree = await createTaskWorktree({
    repositoryPath: root,
    baseBranch: 'main',
    taskId: 'task-1',
    worktreeRoot,
  });
  const workspace: ExecutionWorkspaceRequest = {
    taskId: 'task-1',
    repositoryPath: worktree.repository.root,
    commonDir: worktree.repository.commonDir,
    worktreeRoot,
    worktreePath: worktree.path,
    branchName: worktree.branch,
    baseCommit: worktree.baseCommit,
  };
  // A fake CLI binary; it is never executed by the gate.
  const executablePath = join(directory, `${runtime} cli`);
  writeFileSync(executablePath, '#!/bin/sh\nexit 0\n');
  chmodSync(executablePath, 0o755);
  const stats = statSync(executablePath);
  const installation: CliInstallation = {
    runtime,
    executablePath,
    fingerprint: { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs },
    version: cliFacts[runtime].version,
    detectedOptions: cliFacts[runtime].options,
    detectedAt: now.toISOString(),
  };
  const state = (overrides: Partial<TrustedLocalState> = {}): TrustedLocalState => ({
    enabled: true,
    currentDisclosureVersion: disclosureVersion,
    acceptance: { disclosureVersion, acceptedAt, acceptedRisks: [...securityControls] },
    trustedRepositories: [
      {
        root: worktree.repository.root,
        commonDir: worktree.repository.commonDir,
        trustedAt: '2026-11-04T09:00:00.000Z',
      },
    ],
    ...overrides,
  });
  const request = (overrides: Partial<AuthorizeTrustedLocalExecutionRequest> = {}) => {
    const modelId = overrides.modelId ?? null;
    // Prepared exactly as the worker would, for the run the gate binds the authorization to.
    const preparation = getAgentAdapter(runtime).prepareExecution(
      installation,
      {
        runId: 'run-1',
        prompt: 'Implement the task.',
        modelId,
        workingDirectory: worktree.path,
        timeoutMs: 1_800_000,
      },
      { sourceEnvironment: environment },
    );
    if (!preparation.ok) throw new Error(preparation.message);
    return {
      policy: trustedPolicy(),
      run: { runId: 'run-1', prompt: 'Implement the task.' },
      runtime,
      installation,
      modelId,
      invocation: preparation.plan.invocation,
      workspace,
      ...overrides,
    };
  };
  return { root, workspace, installation, executablePath, state, request };
};

const codes = (decision: TrustedLocalAuthorizationDecision): SecurityDenialCode[] => {
  assert.equal(decision.authorized, false, 'expected a denial');
  return decision.authorized ? [] : decision.denials.map((denial) => denial.code);
};

const assertDenied = (decision: TrustedLocalAuthorizationDecision, code: SecurityDenialCode) => {
  const actual = codes(decision);
  assert.ok(actual.includes(code), `expected ${code}, got ${actual.join(', ')}`);
};

const gate = createTrustedLocalGate(dependencies());

test('authorizes a trusted repository with honest assessments, accepted risks and applied safeguards', async () => {
  for (const runtime of ['codex', 'claude'] as const) {
    await withFixtures(async (directory) => {
      const fixture = await setUp(directory, runtime);
      const decision = await gate(fixture.request(), fixture.state());
      assert.equal(decision.authorized, true, JSON.stringify(decision));
      if (!decision.authorized) return;
      const { authorization } = decision;
      assert.equal(trustedLocalExecutionAuthorizationSchema.safeParse(authorization).success, true);
      assert.equal(strictExecutionAuthorizationSchema.safeParse(authorization).success, false);
      assert.equal(authorization.mode, 'trusted_local');
      assert.equal(authorization.checkedAt, now.toISOString());
      assert.equal(authorization.runtimeVersion, cliFacts[runtime].version);
      assert.equal(authorization.launchProfileId, getAgentAdapter(runtime).securityProfile.id);
      assert.deepEqual(authorization.invocation, fixture.request().invocation);
      assert.equal(authorization.workspace.worktreePath, fixture.workspace.worktreePath);
      assert.deepEqual(authorization.trustedRepository, fixture.state().trustedRepositories[0]);
      assert.equal(authorization.policy.acceptance.disclosureVersion, disclosureVersion);
      assert.equal(authorization.policy.timeoutMs, 1_800_000);
      assert.equal(authorization.processContainment, 'process_group_only');
      // Shipped profiles are unverified: nothing is enforced, so every control is an accepted risk.
      assert.ok(!('controls' in authorization));
      assert.ok(authorization.controlAssessments.every((entry) => entry.status !== 'enforced'));
      assert.deepEqual([...authorization.acceptedRisks].sort(), [...securityControls].sort());
      assert.deepEqual(authorization.safeguards, mandatoryTrustedLocalSafeguards);
      assert.ok(!authorization.safeguards.includes('post_run_git_integrity_check'));
      assert.ok(Object.isFrozen(authorization));
    });
  }
});

test('issues a unique authorization for every decision and modifies nothing', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const before = snapshot(directory);
    const first = await gate(fixture.request(), fixture.state());
    const second = await gate(fixture.request(), fixture.state());
    assert.ok(first.authorized && second.authorized);
    assert.notEqual(first.authorization.authorizationId, second.authorization.authorizationId);
    assert.deepEqual(snapshot(directory), before);
  });
});

test('the public entry point uses the real process state', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    // The public gate re-prepares with process.env, so a request prepared with another
    // environment does not match; nothing in the request can override that.
    assertDenied(
      await authorizeTrustedLocalExecution(fixture.request(), fixture.state()),
      'invocation_invalid',
    );
  });
});

test('requires Trusted Local to be enabled and a current, matching operator acceptance', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    assertDenied(
      await gate(fixture.request(), fixture.state({ enabled: false })),
      'trusted_local_disabled',
    );
    assertDenied(
      await gate(fixture.request(), fixture.state({ acceptance: null })),
      'acceptance_missing',
    );
    assertDenied(
      await gate(
        fixture.request({
          policy: trustedPolicy({ acceptance: { disclosureVersion: '2026-01-01.1', acceptedAt } }),
        }),
        fixture.state({
          acceptance: {
            disclosureVersion: '2026-01-01.1',
            acceptedAt,
            acceptedRisks: [...securityControls],
          },
        }),
      ),
      'acceptance_stale',
    );
    const future = '2026-11-05T00:00:00.000Z';
    assertDenied(
      await gate(
        fixture.request({
          policy: trustedPolicy({ acceptance: { disclosureVersion, acceptedAt: future } }),
        }),
        fixture.state({
          acceptance: {
            disclosureVersion,
            acceptedAt: future,
            acceptedRisks: [...securityControls],
          },
        }),
      ),
      'acceptance_invalid',
    );
    // The policy cannot claim an acceptance other than the recorded one.
    assertDenied(
      await gate(
        fixture.request({
          policy: trustedPolicy({ acceptance: { disclosureVersion: '9.9', acceptedAt } }),
        }),
        fixture.state(),
      ),
      'acceptance_invalid',
    );
    assertDenied(
      await gate(
        fixture.request({
          policy: trustedPolicy({
            acceptance: { disclosureVersion, acceptedAt: '2026-11-04T11:00:00.000Z' },
          }),
        }),
        fixture.state(),
      ),
      'acceptance_invalid',
    );
  });
});

test('requires every unenforced control to be an explicitly accepted risk', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const withoutNetwork = securityControls.filter((control) => control !== 'network_denied');
    const missing = await gate(
      fixture.request({ policy: trustedPolicy({ acceptedRisks: withoutNetwork }) }),
      fixture.state(),
    );
    assertDenied(missing, 'risk_not_accepted');
    assert.ok(
      !missing.authorized && missing.denials.some((denial) => denial.control === 'network_denied'),
    );
    // The policy cannot list risks the operator never accepted.
    assertDenied(
      await gate(
        fixture.request(),
        fixture.state({
          acceptance: { disclosureVersion, acceptedAt, acceptedRisks: withoutNetwork },
        }),
      ),
      'acceptance_invalid',
    );
  });
});

test('ignores and rejects caller-supplied enforcement claims', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const claims = securityControls.map((control) => ({
      control,
      status: 'enforced',
      mechanism: 'os_sandbox',
      notes: 'claimed by caller',
    }));
    for (const extra of [
      { controlAssessments: claims },
      { acceptedRisks: [] },
      { safeguards: ['post_run_git_integrity_check'] },
      { profile: { id: 'verified', capabilities: [] } },
      { trustedRepositories: [] },
      { enabled: true },
    ]) {
      const request = { ...fixture.request(), ...extra } as AuthorizeTrustedLocalExecutionRequest;
      assertDenied(await gate(request, fixture.state()), 'invalid_request');
    }
    assertDenied(
      await gate(fixture.request({ policy: trustedPolicy({ controls: claims }) }), fixture.state()),
      'policy_invalid',
    );
  });
});

test('trust comes only from trusted state and must match root and common Git directory', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const [trusted] = fixture.state().trustedRepositories;
    assert.ok(trusted);
    assertDenied(
      await gate(fixture.request(), fixture.state({ trustedRepositories: [] })),
      'repository_not_trusted',
    );
    assertDenied(
      await gate(
        fixture.request(),
        fixture.state({
          trustedRepositories: [{ ...trusted, commonDir: join(directory, 'other', '.git') }],
        }),
      ),
      'repository_not_trusted',
    );
    assertDenied(
      await gate(
        fixture.request(),
        fixture.state({
          trustedRepositories: [{ ...trusted, trustedAt: '2026-11-05T00:00:00.000Z' }],
        }),
      ),
      'repository_not_trusted',
    );
    assertDenied(
      await gate(
        fixture.request(),
        fixture.state({
          trustedRepositories: [trusted, { ...trusted, commonDir: join(directory, 'x') }],
        }),
      ),
      'repository_not_trusted',
    );
    // A trust record for a forged identity does not help: Git still reports the real one.
    const forged = join(directory, 'forged', '.git');
    const decision = await gate(
      fixture.request({ workspace: { ...fixture.workspace, commonDir: forged } }),
      fixture.state({ trustedRepositories: [{ ...trusted, commonDir: forged }] }),
    );
    assert.equal(decision.authorized, false);
    const actual = codes(decision);
    assert.ok(
      actual.includes('repository_mismatch') || actual.includes('invalid_request'),
      actual.join(', '),
    );
  });
});

test('a trusted repository does not skip worktree verification', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    assertDenied(
      await gate(
        fixture.request({
          workspace: { ...fixture.workspace, worktreePath: join(directory, 'missing') },
        }),
        fixture.state(),
      ),
      'worktree_not_verified',
    );
    assertDenied(
      await gate(
        fixture.request({ workspace: { ...fixture.workspace, branchName: 'agent/other' } }),
        fixture.state(),
      ),
      'branch_mismatch',
    );
    assertDenied(
      await gate(
        fixture.request({ workspace: { ...fixture.workspace, workingDirectory: fixture.root } }),
        fixture.state(),
      ),
      'path_outside_workspace',
    );
    // A worktree of another repository, claimed under this repository's identity.
    const otherRoot = createRepository(join(directory, 'other project'));
    const other = await createTaskWorktree({
      repositoryPath: otherRoot,
      baseBranch: 'main',
      taskId: 'task-1',
      worktreeRoot: join(directory, 'worktree root'),
    });
    const foreign = await gate(
      fixture.request({ workspace: { ...fixture.workspace, worktreePath: other.path } }),
      fixture.state(),
    );
    assert.equal(foreign.authorized, false);
    // HEAD moved: an agent (or anyone) committed in the worktree.
    writeFile(join(fixture.workspace.worktreePath, 'change.txt'), 'x\n');
    git(fixture.workspace.worktreePath, 'add', 'change.txt');
    git(fixture.workspace.worktreePath, 'commit', '--quiet', '-m', 'unexpected');
    assertDenied(await gate(fixture.request(), fixture.state()), 'unexpected_head');
  });
});

test('binds the executable identity and the exact prepared invocation', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const base = fixture.request();
    const executable = base.invocation.executable;
    assertDenied(
      await gate(
        fixture.request({
          invocation: {
            ...base.invocation,
            executable: { ...executable, size: executable.size + 1 },
          },
        }),
        fixture.state(),
      ),
      'executable_not_verified',
    );
    // Substitution: a different executable presented as the detected installation.
    const substitute = join(directory, 'substitute');
    writeFileSync(substitute, '#!/bin/sh\nexit 1\n');
    chmodSync(substitute, 0o755);
    assertDenied(
      await gate(
        fixture.request({
          invocation: { ...base.invocation, executable: { ...executable, path: substitute } },
        }),
        fixture.state(),
      ),
      'executable_not_verified',
    );
    assertDenied(
      await gate(
        fixture.request({
          invocation: {
            ...base.invocation,
            arguments: [...base.invocation.arguments, '--model', 'm'],
          },
        }),
        fixture.state(),
      ),
      'invocation_invalid',
    );
    assertDenied(
      await gate(
        fixture.request({ invocation: { ...base.invocation, arguments: ['exec', '--yolo', '-'] } }),
        fixture.state(),
      ),
      'unsafe_launch_arguments',
    );
    assertDenied(
      await gate(
        fixture.request({
          invocation: { ...base.invocation, environmentDigest: `sha256:${'f'.repeat(64)}` },
        }),
        fixture.state(),
      ),
      'invocation_invalid',
    );
    // The launch environment differs from the one the invocation was prepared with.
    const otherEnvironment = createTrustedLocalGate(
      dependencies({ sourceEnvironment: () => ({ ...environment, HOME: '/Users/someone-else' }) }),
    );
    assertDenied(await otherEnvironment(fixture.request(), fixture.state()), 'invocation_invalid');
    // The binary changed on disk after detection.
    writeFileSync(fixture.executablePath, '#!/bin/sh\nexit 2\n# replaced\n');
    assertDenied(await gate(fixture.request(), fixture.state()), 'executable_not_verified');
  });
});

test('requires a matching runtime and a supported CLI version', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    assertDenied(
      await gate(
        fixture.request({ installation: { ...fixture.installation, runtime: 'claude' } }),
        fixture.state(),
      ),
      'invalid_request',
    );
    for (const version of ['0.100.0', 'abc', '0.166']) {
      assertDenied(
        await gate(
          fixture.request({ installation: { ...fixture.installation, version } }),
          fixture.state(),
        ),
        'cli_version_unsupported',
      );
    }
    const unknownRuntime = {
      ...fixture.request(),
      runtime: 'gemini',
    } as unknown as AuthorizeTrustedLocalExecutionRequest;
    assertDenied(await gate(unknownRuntime, fixture.state()), 'invalid_request');
  });
});

test('requires a valid timeout, non-interactive approval and the Trusted Local mode', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    for (const timeoutMs of [
      undefined,
      0,
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      24 * 60 * 60 * 1000 + 1,
    ]) {
      assertDenied(
        await gate(fixture.request({ policy: trustedPolicy({ timeoutMs }) }), fixture.state()),
        'timeout_required',
      );
    }
    assertDenied(
      await gate(
        fixture.request({ policy: trustedPolicy({ interactiveApproval: 'allow' }) }),
        fixture.state(),
      ),
      'policy_invalid',
    );
    assertDenied(
      await gate(fixture.request({ policy: undefined }), fixture.state()),
      'policy_missing',
    );
    for (const policy of [
      { mode: 'strict_isolated', version: 1 },
      { ...trustedPolicy(), mode: 'unknown' },
      { version: 1 },
    ]) {
      assertDenied(await gate(fixture.request({ policy }), fixture.state()), 'mode_mismatch');
    }
  });
});

test('refuses to authorize elevated or unknown privileges', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    for (const uid of [0, undefined]) {
      const elevated = createTrustedLocalGate(dependencies({ effectiveUid: () => uid }));
      assertDenied(await elevated(fixture.request(), fixture.state()), 'elevated_privileges');
    }
  });
});

test('rejects malformed trusted state', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    for (const state of [
      { ...fixture.state(), enabled: 'yes' },
      { ...fixture.state(), currentDisclosureVersion: '' },
      { ...fixture.state(), extra: true },
    ]) {
      assertDenied(
        await gate(fixture.request(), state as unknown as TrustedLocalState),
        'invalid_request',
      );
    }
  });
});

test('Strict Mode is unchanged and never falls back to Trusted Local', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const trusted = fixture.request();
    // The same launch through the strict gate, with the shipped profile, stays denied.
    const strict = await authorizeAgentExecution({
      runtime: 'codex',
      runtimeVersion: fixture.installation.version,
      profile: codexAdapter.securityProfile,
      policy: { mode: 'strict_isolated', version: 1 },
      invocation: trusted.invocation,
      workspace: fixture.workspace,
    });
    assert.equal(strict.authorized, false);
    assert.ok(
      !strict.authorized && strict.denials.some((denial) => denial.code === 'control_not_enforced'),
    );
    // A Trusted Local policy at the strict gate is invalid, not a downgrade.
    const crossed = await authorizeAgentExecution({
      runtime: 'codex',
      runtimeVersion: fixture.installation.version,
      profile: codexAdapter.securityProfile,
      policy: trustedPolicy(),
      invocation: trusted.invocation,
      workspace: fixture.workspace,
    });
    assert.ok(
      !crossed.authorized && crossed.denials.some((denial) => denial.code === 'policy_invalid'),
    );
  });
});

test('a Trusted Local authorization is never launched in Strict Mode', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const decision = await gate(fixture.request(), fixture.state());
    assert.ok(decision.authorized);
    if (!decision.authorized) return;
    const result = await startAgentExecution({
      securityMode: 'strict_isolated',
      adapter: codexAdapter,
      installation: fixture.installation,
      request: {
        runId: 'run-1',
        prompt: 'Implement the task.',
        modelId: null,
        workingDirectory: fixture.workspace.worktreePath,
        timeoutMs: 1_800_000,
      },
      authorization: decision.authorization,
      emit: () => undefined,
      sourceEnvironment: environment,
    });
    assert.equal(result.started, false);
    assert.equal(!result.started && result.code, 'mode_mismatch');
  });
});

test('binds the authorization to a valid run', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    for (const run of [
      { runId: 'run 1', prompt: 'Implement the task.' },
      { runId: 'run-1', prompt: '   ' },
    ]) {
      assertDenied(await gate(fixture.request({ run }), fixture.state()), 'invocation_invalid');
    }
    const missing: Record<string, unknown> = { ...fixture.request() };
    delete missing.run;
    assertDenied(
      await gate(missing as AuthorizeTrustedLocalExecutionRequest, fixture.state()),
      'invalid_request',
    );
    // The authorization records neither the prompt nor its digest.
    const decision = await gate(fixture.request(), fixture.state());
    assert.ok(decision.authorized);
    assert.ok(!JSON.stringify(decision).includes('Implement the task.'));
  });
});
