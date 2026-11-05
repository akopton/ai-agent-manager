import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  assessControl,
  mandatoryTrustedLocalSafeguards,
  securityControls,
  type SecurityModeAuthorization,
  type TrustedLocalExecutionAuthorization,
} from '@ai-agent-manager/core';
import { claudeAdapter, codexAdapter } from '../src/index.js';
import * as mainEntryPoint from '../src/index.js';
import { claimTrustedLocalIssuer } from '../src/trusted-local-issuer.js';
import {
  createIssuanceRegistry,
  issuanceLifetimeMs,
  maxPendingAuthorizations,
} from '../src/trusted-local-issuance.js';
import type { AgentAdapter, AgentEvent, AgentRunResult, CliInstallation } from '../src/contract.js';
import { claudeAdapterSpecification } from '../src/claude-adapter.js';
import {
  createAgentExecutionLauncher,
  defaultExecutionLimits,
  type LaunchBoundaryDependencies,
  type StartAgentExecutionInput,
} from '../src/execution-launch.js';
import { createAdapter } from '../src/invocation.js';
import {
  claudeHelp,
  claudeVersionLine,
  codexExecHelp,
  codexVersionLine,
  collectEvents,
  createFakeCli,
  isAlive,
  verifiedTestProfile,
  withTemporaryDirectory,
  type FakeCli,
  type FakeScenario,
  type FakeStep,
} from './fixtures.js';

// This test process stands in for the orchestrator's Trusted Local gate: it claims the
// once-per-process issuer before anything else can. Each test file runs in its own process.
const issuer = claimTrustedLocalIssuer();
assert.ok(issuer, 'the issuer must be claimable once');

const prompt = 'Implement the task. Secret prompt text.';
const runId = 'run-tl-1';

const codexSuccess: FakeStep[] = [
  { stdout: JSON.stringify({ type: 'thread.started', thread_id: 't-1' }) },
  {
    stdout: JSON.stringify({
      type: 'item.completed',
      item: { id: 'i', type: 'agent_message', text: 'Done.' },
    }),
  },
  { stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) },
];

const claudeSuccess: FakeStep[] = [
  { stdout: JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }) },
  { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) },
];

type Context = {
  directory: string;
  workspace: string;
  fake: FakeCli;
  adapter: AgentAdapter;
  installation: CliInstallation;
};

const withFakeRuntime = async (
  runtime: 'claude' | 'codex',
  steps: FakeStep[],
  run: (context: Context) => Promise<void>,
  scenario: Partial<FakeScenario> = {},
): Promise<void> =>
  withTemporaryDirectory(async (directory) => {
    const bin = join(directory, 'bin');
    const workspace = join(directory, 'work tree');
    mkdirSync(bin);
    mkdirSync(workspace);
    const fake = createFakeCli(bin, runtime, {
      version: runtime === 'claude' ? claudeVersionLine : codexVersionLine,
      help: runtime === 'claude' ? claudeHelp : codexExecHelp,
      steps,
      ...scenario,
    });
    // Trusted Local launches use the shipped adapters and their unverified profiles.
    const adapter = runtime === 'claude' ? claudeAdapter : codexAdapter;
    const detection = await adapter.detect({ executablePath: fake.executablePath });
    assert.equal(detection.status, 'available', JSON.stringify(detection));
    if (detection.status !== 'available') return;
    await run({
      directory,
      workspace: realpathSync(workspace),
      fake,
      adapter,
      installation: detection.installation,
    });
  });

type IssueOptions = {
  modelId?: string | null;
  timeoutMs?: number;
  sourceEnvironment?: NodeJS.ProcessEnv;
  run?: { runId: string; prompt: string };
  overrides?: Record<string, unknown>;
  /** `false` builds a structurally valid authorization that the gate never issued. */
  register?: boolean;
};

/**
 * Builds a Trusted Local authorization exactly as `authorizeTrustedLocalExecution` would after
 * its checks (honest assessments from the shipped profile) and registers it like the gate does.
 */
const issue = (
  context: Context,
  {
    modelId = null,
    timeoutMs = 60_000,
    sourceEnvironment = process.env,
    run = { runId, prompt },
    overrides = {},
    register = true,
  }: IssueOptions = {},
): TrustedLocalExecutionAuthorization => {
  const { adapter, installation, workspace } = context;
  const preparation = adapter.prepareExecution(
    installation,
    { runId: run.runId, prompt: run.prompt, modelId, workingDirectory: workspace, timeoutMs },
    { sourceEnvironment },
  );
  if (!preparation.ok) throw new Error(preparation.message);
  const profile = adapter.securityProfile;
  const controlAssessments = securityControls.map((control) =>
    assessControl(profile, control, installation.version),
  );
  const now = new Date();
  const authorization = {
    mode: 'trusted_local' as const,
    authorizationId: randomUUID(),
    checkedAt: now.toISOString(),
    runtime: adapter.runtime,
    runtimeVersion: installation.version,
    launchProfileId: profile.id,
    launchArguments: [...profile.launchArguments],
    invocation: preparation.plan.invocation,
    workspace: {
      repositoryRoot: workspace,
      commonDir: join(workspace, '.git'),
      worktreePath: workspace,
      workingDirectory: workspace,
      branch: 'agent/task-1',
      baseCommit: 'a'.repeat(40),
    },
    policy: {
      mode: 'trusted_local' as const,
      version: 1 as const,
      acceptance: {
        disclosureVersion: '2026-11-04.1',
        acceptedAt: new Date(now.getTime() - 60_000).toISOString(),
      },
      acceptedRisks: [...securityControls],
      interactiveApproval: 'deny' as const,
      timeoutMs,
    },
    trustedRepository: {
      root: workspace,
      commonDir: join(workspace, '.git'),
      trustedAt: new Date(now.getTime() - 120_000).toISOString(),
    },
    controlAssessments,
    acceptedRisks: controlAssessments
      .filter((entry) => entry.status !== 'enforced')
      .map((entry) => entry.control),
    safeguards: [...mandatoryTrustedLocalSafeguards],
    processContainment: 'process_group_only' as const,
    ...overrides,
  } as TrustedLocalExecutionAuthorization;
  if (register) {
    assert.equal(issuer(authorization, run), true, 'the authorization must be registrable');
  }
  return authorization;
};

const realDependencies: LaunchBoundaryDependencies = {
  now: () => new Date(),
  effectiveUid: () => 501,
  processGroupsSupported: true,
};

type Attempt = Partial<Omit<StartAgentExecutionInput, 'authorization'>> & {
  authorization: unknown;
  dependencies?: Partial<LaunchBoundaryDependencies>;
};

const launch = (context: Context, attempt: Attempt) => {
  const { dependencies, authorization, ...input } = attempt;
  const launcher = createAgentExecutionLauncher({ ...realDependencies, ...dependencies });
  return launcher({
    securityMode: 'trusted_local',
    adapter: context.adapter,
    installation: context.installation,
    request: { runId, prompt, modelId: null, workingDirectory: context.workspace },
    emit: () => undefined,
    limits: { stopGraceMs: 300 },
    ...input,
    authorization: authorization as SecurityModeAuthorization,
  });
};

/** Launches and returns the rejection code, or `started` (after the run has ended). */
const codeOf = async (context: Context, attempt: Attempt): Promise<string> => {
  const result = await launch(context, attempt);
  if (result.started) {
    await result.handle.stop();
    return 'started';
  }
  return result.code;
};

const startOrFail = async (context: Context, attempt: Attempt) => {
  const collector = collectEvents();
  const result = await launch(context, { emit: collector.emit, ...attempt });
  assert.equal(result.started, true, JSON.stringify(result));
  if (!result.started) throw new Error('not started');
  return { handle: result.handle, events: collector.events };
};

const assertFailed = (result: AgentRunResult, code: string) => {
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.equal(result.status === 'failed' ? result.code : null, code, JSON.stringify(result));
};

const assertReportsMode = (events: AgentEvent[], result: AgentRunResult) => {
  assert.equal(result.securityMode, 'trusted_local');
  assert.equal(result.processContainment, 'process_group_only');
  assert.equal(result.runId, runId);
  const started = events.find((event) => event.type === 'started');
  if (started !== undefined) {
    assert.equal(started.type === 'started' && started.securityMode, 'trusted_local');
    assert.equal(started.type === 'started' && started.processContainment, 'process_group_only');
  }
  const terminal = events.filter((event) =>
    ['completed', 'failed', 'stopped'].includes(event.type),
  );
  assert.equal(terminal.length, 1);
  assert.ok(events.every((event) => event.runId === runId));
  assert.ok(!JSON.stringify(events).includes('Secret prompt text'), 'the prompt is never emitted');
};

const waitFor = async (condition: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('the issuer can be claimed only once per process', () => {
  assert.equal(claimTrustedLocalIssuer(), null);
});

test('launches a gate-issued Trusted Local authorization for both runtimes', async () => {
  for (const [runtime, steps] of [
    ['codex', codexSuccess],
    ['claude', claudeSuccess],
  ] as const) {
    await withFakeRuntime(runtime, steps, async (context) => {
      const { handle, events } = await startOrFail(context, { authorization: issue(context) });
      const result = await handle.completed;
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.runtime, runtime);
      assertReportsMode(events, result);
      const invocation = context.fake.invocation();
      assert.equal(invocation.stdin, prompt);
      assert.equal(invocation.cwd, context.workspace);
      assert.deepEqual(
        invocation.args.slice(0, context.adapter.securityProfile.launchArguments.length),
        context.adapter.securityProfile.launchArguments,
        'the restricted profile arguments are unchanged',
      );
    });
  }
});

test('reports failures with the Trusted Local mode', async () => {
  await withFakeRuntime('codex', [{ stderr: 'Error: boom' }, { exit: 1 }], async (context) => {
    const { handle, events } = await startOrFail(context, { authorization: issue(context) });
    const result = await handle.completed;
    assertFailed(result, 'non_zero_exit');
    assertReportsMode(events, result);
  });
});

test('enforces the authorized timeout, and only that timeout', async () => {
  await withFakeRuntime('codex', [{ hang: true }], async (context) => {
    // No request timeout: the policy's timeout applies anyway.
    const { handle, events } = await startOrFail(context, {
      authorization: issue(context, { timeoutMs: 200 }),
    });
    const result = await handle.completed;
    assertFailed(result, 'timeout');
    assert.ok(events.some((event) => event.type === 'stopping' && event.reason === 'timeout'));
    assertReportsMode(events, result);

    for (const timeoutMs of [100, 60_001]) {
      assert.equal(
        await codeOf(context, {
          authorization: issue(context, { timeoutMs: 60_000 }),
          request: {
            runId,
            prompt,
            modelId: null,
            workingDirectory: context.workspace,
            timeoutMs,
          },
        }),
        'authorization_mismatch',
        `request timeout ${timeoutMs}`,
      );
    }
    // A policy without a finite timeout is not a valid authorization; it cannot even be issued.
    for (const timeoutMs of [undefined, 0, Number.POSITIVE_INFINITY]) {
      const unbounded = issue(context, { register: false });
      const policy: Record<string, unknown> = { ...unbounded.policy, timeoutMs };
      const candidate = { ...unbounded, policy } as unknown as TrustedLocalExecutionAuthorization;
      assert.equal(issuer(candidate, { runId, prompt }), false);
      assert.equal(
        await codeOf(context, { authorization: candidate }),
        'authorization_mismatch',
        String(timeoutMs),
      );
    }
  });
});

test('stop terminates the process group and reports stopped', async () => {
  await withFakeRuntime(
    'codex',
    [{ spawnLingeringChild: true }, { hang: true }],
    async (context) => {
      const { handle, events } = await startOrFail(context, { authorization: issue(context) });
      await waitFor(() => {
        try {
          return context.fake.lingeringChildPid() > 0;
        } catch {
          return false;
        }
      });
      const result = await handle.stop();
      assert.equal(result.status, 'stopped');
      assert.equal(result.signal, 'SIGTERM');
      assert.equal(isAlive(context.fake.lingeringChildPid()), false);
      assertReportsMode(events, result);
    },
  );
});

test('escalates to SIGKILL when SIGTERM is ignored', async () => {
  await withFakeRuntime(
    'codex',
    [{ stdout: '{"type":"turn.started"}' }, { hang: true }],
    async (context) => {
      const { handle, events } = await startOrFail(context, { authorization: issue(context) });
      await waitFor(() => events.some((event) => event.type === 'started'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await handle.stop();
      assert.equal(result.status, 'stopped');
      assert.equal(result.signal, 'SIGKILL');
    },
    { onSigterm: 'ignore' },
  );
});

test('output limits apply and can only be tightened', async () => {
  const line = JSON.stringify({ type: 'turn.started', filler: 'x'.repeat(1_000) });
  await withFakeRuntime(
    'codex',
    [...Array.from({ length: 20 }, () => ({ stdout: line })), { hang: true }],
    async (context) => {
      const { handle, events } = await startOrFail(context, {
        authorization: issue(context),
        limits: { stopGraceMs: 300, maxStdoutBytes: 5_000 },
      });
      const result = await handle.completed;
      assertFailed(result, 'output_limit_exceeded');
      assertReportsMode(events, result);

      const widened: Array<Partial<typeof defaultExecutionLimits>> = [
        { maxStdoutBytes: defaultExecutionLimits.maxStdoutBytes + 1 },
        { maxStdoutBytes: Number.POSITIVE_INFINITY },
        { maxLineBytes: Number.NaN },
        { maxStderrEventBytes: 0 },
        { stopGraceMs: -1 },
        { maxAuthorizationAgeMs: 3_600_000 },
      ];
      for (const limits of widened) {
        assert.equal(
          await codeOf(context, { authorization: issue(context), limits }),
          'safeguard_unavailable',
          JSON.stringify(limits),
        );
      }
    },
  );
});

test('a throwing event handler terminates the run', async () => {
  await withFakeRuntime('codex', [...codexSuccess.slice(0, 1), { hang: true }], async (context) => {
    const { handle } = await startOrFail(context, {
      authorization: issue(context),
      emit: (event) => {
        if (event.type === 'metadata') throw new Error('database unavailable');
      },
    });
    const result = await handle.completed;
    assertFailed(result, 'event_handler_failed');
    assert.equal(result.securityMode, 'trusted_local');
  });
});

test('single use by authorization ID, including copies and deserialized forms', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    const authorization = issue(context);
    assert.equal(await codeOf(context, { authorization }), 'started');
    for (const reused of [
      authorization,
      { ...authorization },
      JSON.parse(JSON.stringify(authorization)),
      structuredClone(authorization),
    ]) {
      assert.equal(await codeOf(context, { authorization: reused }), 'authorization_mismatch');
    }
    // A rejected attempt also uses the authorization up: no retry with corrected inputs.
    const burned = issue(context);
    assert.equal(
      await codeOf(context, {
        authorization: burned,
        request: {
          runId,
          prompt: 'Another task.',
          modelId: null,
          workingDirectory: context.workspace,
        },
      }),
      'authorization_mismatch',
    );
    assert.equal(await codeOf(context, { authorization: burned }), 'authorization_mismatch');
    // Concurrent launches of one authorization: exactly one starts.
    const shared = issue(context);
    const outcomes = await Promise.all([
      codeOf(context, { authorization: shared }),
      codeOf(context, { authorization: { ...shared } }),
    ]);
    assert.deepEqual([...outcomes].sort(), ['authorization_mismatch', 'started']);
    // A second registration of the same ID is refused.
    const twice = issue(context);
    assert.equal(issuer(twice, { runId, prompt }), false);
  });
});

test('refuses structurally valid authorizations without gate provenance', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    // Never registered: built by hand, as a REST body or a database row would be.
    assert.equal(
      await codeOf(context, { authorization: issue(context, { register: false }) }),
      'authorization_mismatch',
    );
    // Registered, then altered (still schema-valid): differs from what the gate issued.
    const issued = issue(context);
    const tampered = { ...issued, policy: { ...issued.policy, timeoutMs: 24 * 60 * 60 * 1000 } };
    assert.equal(await codeOf(context, { authorization: tampered }), 'authorization_mismatch');
    assert.equal(await codeOf(context, { authorization: issued }), 'authorization_mismatch');
    // Malformed, missing or foreign IDs.
    const valid = issue(context);
    for (const authorizationId of [undefined, 'abc', randomUUID()]) {
      assert.equal(
        await codeOf(context, { authorization: { ...valid, authorizationId } }),
        'authorization_mismatch',
        String(authorizationId),
      );
    }
    for (const malformed of [null, undefined, 'token', {}, [valid]]) {
      assert.equal(
        await codeOf(context, { authorization: malformed }),
        'authorization_mismatch',
        JSON.stringify(malformed),
      );
    }
  });
});

test('binds the authorization to the run and the prompt', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    const request = { runId, prompt, modelId: null, workingDirectory: context.workspace };
    for (const substitute of [
      { ...request, runId: 'run-other' },
      { ...request, prompt: 'Delete everything.' },
      { ...request, prompt: `${prompt} ` },
    ]) {
      assert.equal(
        await codeOf(context, { authorization: issue(context), request: substitute }),
        'authorization_mismatch',
        JSON.stringify({ runId: substitute.runId }),
      );
    }
  });
});

test('refuses expired authorizations and caller-supplied clocks', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    const later = () => new Date(Date.now() + defaultExecutionLimits.maxAuthorizationAgeMs + 1);
    assert.equal(
      await codeOf(context, { authorization: issue(context), dependencies: { now: later } }),
      'authorization_mismatch',
    );
    const earlier = () => new Date(Date.now() - 60_000);
    assert.equal(
      await codeOf(context, { authorization: issue(context), dependencies: { now: earlier } }),
      'authorization_mismatch',
    );
    // A Trusted Local launch never uses the caller's clock.
    assert.equal(
      await codeOf(context, { authorization: issue(context), now: () => new Date() }),
      'authorization_mismatch',
    );
  });
});

test('requires a non-root effective user at launch', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    for (const uid of [0, undefined]) {
      assert.equal(
        await codeOf(context, {
          authorization: issue(context),
          dependencies: { effectiveUid: () => uid },
        }),
        'elevated_privileges',
        String(uid),
      );
    }
    assert.throws(() => context.fake.invocation(), 'nothing was started');
  });
});

test('refuses when a mandatory runtime safeguard cannot be applied', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    assert.equal(
      await codeOf(context, {
        authorization: issue(context),
        dependencies: { processGroupsSupported: false },
      }),
      'safeguard_unavailable',
    );
    // Claiming the Git integrity check before the lifecycle applies it is not honest; refused.
    assert.equal(
      await codeOf(context, {
        authorization: issue(context, {
          overrides: {
            safeguards: [...mandatoryTrustedLocalSafeguards, 'post_run_git_integrity_check'],
          },
        }),
      }),
      'safeguard_unavailable',
    );
    const withoutTimeoutSafeguard = issue(context, {
      register: false,
      overrides: {
        safeguards: mandatoryTrustedLocalSafeguards.filter((name) => name !== 'mandatory_timeout'),
      },
    });
    assert.equal(issuer(withoutTimeoutSafeguard, { runId, prompt }), false);
    assert.equal(
      await codeOf(context, { authorization: withoutTimeoutSafeguard }),
      'authorization_mismatch',
    );
  });
});

test('binds the executable, arguments, model, environment and working directory', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    const base = issue(context, { register: false });
    const withInvocation = (invocation: Partial<typeof base.invocation>) =>
      issue(context, { overrides: { invocation: { ...base.invocation, ...invocation } } });
    const request = { runId, prompt, modelId: null, workingDirectory: context.workspace };
    const cases: Array<[string, Attempt]> = [
      ['authorized for another model', { authorization: issue(context, { modelId: 'gpt-x' }) }],
      [
        'requested another model',
        { authorization: issue(context), request: { ...request, modelId: 'gpt-x' } },
      ],
      [
        'extra argument',
        { authorization: withInvocation({ arguments: [...base.invocation.arguments, '--debug'] }) },
      ],
      [
        'another inode',
        {
          authorization: withInvocation({
            executable: { ...base.invocation.executable, ino: base.invocation.executable.ino + 1 },
          }),
        },
      ],
      [
        'another environment digest',
        { authorization: withInvocation({ environmentDigest: `sha256:${'f'.repeat(64)}` }) },
      ],
      [
        'another launch environment',
        {
          authorization: issue(context),
          sourceEnvironment: { ...process.env, PATH: '/somewhere/else' },
        },
      ],
      [
        'another working directory',
        {
          authorization: issue(context),
          request: { ...request, workingDirectory: context.directory },
        },
      ],
      [
        'working directory outside the worktree',
        {
          authorization: issue(context, {
            overrides: {
              workspace: { ...base.workspace, worktreePath: join(context.workspace, 'sub') },
            },
          }),
        },
      ],
    ];
    for (const [name, attempt] of cases) {
      assert.equal(await codeOf(context, attempt), 'authorization_mismatch', name);
    }
    assert.throws(() => context.fake.invocation(), 'nothing was started');

    // Replacing the binary after the gate's check is detected immediately before spawning.
    const authorization = issue(context);
    const later = new Date(Date.now() + 5_000);
    utimesSync(context.fake.executablePath, later, later);
    assert.equal(await codeOf(context, { authorization }), 'executable_changed');
  });
});

test('requires the shipped adapter, runtime, profile and a supported CLI version', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    const testAdapter = createAdapter({
      ...claudeAdapterSpecification,
      securityProfile: verifiedTestProfile(claudeAdapterSpecification.securityProfile, '2.1.317'),
    });
    const cases: Array<[string, Attempt]> = [
      [
        'claude adapter for a codex authorization',
        { authorization: issue(context), adapter: claudeAdapter },
      ],
      ['non-shipped adapter', { authorization: issue(context), adapter: testAdapter }],
      [
        'installation of another runtime',
        {
          authorization: issue(context),
          installation: { ...context.installation, runtime: 'claude' },
        },
      ],
      [
        'another profile',
        { authorization: issue(context, { overrides: { launchProfileId: 'other' } }) },
      ],
      [
        'another CLI version',
        { authorization: issue(context, { overrides: { runtimeVersion: '0.167.0' } }) },
      ],
      [
        'unsupported CLI version',
        {
          authorization: issue(context, { overrides: { runtimeVersion: '0.100.0' } }),
          installation: { ...context.installation, version: '0.100.0' },
        },
      ],
    ];
    for (const [name, attempt] of cases) {
      assert.equal(await codeOf(context, attempt), 'authorization_mismatch', name);
    }
  });
});

test('refuses upgraded assessments and invalid acceptance', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    const base = issue(context, { register: false });
    // Upgrading a control to `enforced` (and dropping it from the risks) is schema-valid, but it
    // is not what the shipped profile says.
    const [first, ...rest] = base.controlAssessments;
    assert.ok(first);
    const upgraded = issue(context, {
      overrides: {
        controlAssessments: [{ ...first, status: 'enforced' }, ...rest],
        acceptedRisks: base.acceptedRisks.filter((control) => control !== first.control),
      },
    });
    assert.equal(await codeOf(context, { authorization: upgraded }), 'authorization_mismatch');

    const future = new Date(Date.now() + 60_000).toISOString();
    const lateAcceptance = issue(context, {
      overrides: {
        policy: { ...base.policy, acceptance: { ...base.policy.acceptance, acceptedAt: future } },
      },
    });
    assert.equal(
      await codeOf(context, { authorization: lateAcceptance }),
      'authorization_mismatch',
    );

    for (const acceptance of [
      { ...base.policy.acceptance, disclosureVersion: '' },
      { disclosureVersion: base.policy.acceptance.disclosureVersion },
      null,
    ]) {
      const invalid = { ...base, policy: { ...base.policy, acceptance } };
      assert.equal(
        issuer(invalid as unknown as TrustedLocalExecutionAuthorization, { runId, prompt }),
        false,
      );
      assert.equal(await codeOf(context, { authorization: invalid }), 'authorization_mismatch');
    }
    // A risk the operator did not accept.
    const unaccepted = {
      ...base,
      policy: { ...base.policy, acceptedRisks: securityControls.slice(1) },
    };
    assert.equal(await codeOf(context, { authorization: unaccepted }), 'authorization_mismatch');
  });
});

test('the main entry point exposes neither the issuer nor test factories', () => {
  for (const name of [
    'claimTrustedLocalIssuer',
    'redeemTrustedLocalAuthorization',
    'createIssuanceRegistry',
    'createAgentExecutionLauncher',
    'startSupervisedProcess',
  ]) {
    assert.ok(!(name in mainEntryPoint), name);
  }
});

test('issuance records expire with the launch freshness limit and fail closed', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    assert.equal(issuanceLifetimeMs, defaultExecutionLimits.maxAuthorizationAgeMs + 5_000);
    let clock = 1_000_000;
    const registry = createIssuanceRegistry({
      now: () => clock,
      lifetimeMs: issuanceLifetimeMs,
      maxPending: 2,
    });
    const run = { runId, prompt };
    const build = () => issue(context, { register: false });

    // Expired records cannot be redeemed, even before any pruning happened.
    const expiring = build();
    assert.equal(registry.register(expiring, run), true);
    clock += issuanceLifetimeMs + 1;
    assert.equal(registry.redeem(expiring, run).ok, false);

    // A clock that moved backwards invalidates the record.
    const skewed = build();
    assert.equal(registry.register(skewed, run), true);
    clock -= 10;
    assert.equal(registry.redeem(skewed, run).ok, false);

    // Exhaustion refuses new registrations until records are redeemed or expire.
    const [first, second, third] = [build(), build(), build()];
    assert.equal(registry.register(first, run), true);
    assert.equal(registry.register(second, run), true);
    assert.equal(registry.register(third, run), false);
    assert.equal(registry.redeem(third, run).ok, false, 'a refused registration never redeems');
    assert.equal(registry.redeem(first, run).ok, true);
    assert.equal(registry.register(third, run), true);
    clock += issuanceLifetimeMs + 1;
    assert.equal(registry.pendingCount(), 0);
    assert.equal(registry.redeem(second, run).ok, false);
    assert.equal(registry.redeem(third, run).ok, false);
  });
});

test('the process registry fails closed when exhausted and recovers after redemption', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    const run = { runId, prompt };
    // Earlier tests may have left unredeemed records; fill the registry until it refuses.
    const issued: TrustedLocalExecutionAuthorization[] = [];
    for (;;) {
      const candidate = issue(context, { register: false });
      if (!issuer(candidate, run)) break;
      issued.push(candidate);
      assert.ok(issued.length <= maxPendingAuthorizations, 'the registry must be bounded');
    }
    assert.ok(issued.length > 0);
    const overflow = issue(context, { register: false });
    assert.equal(issuer(overflow, run), false);
    assert.equal(await codeOf(context, { authorization: overflow }), 'authorization_mismatch');
    // Drain: every redemption is consumed (rejected launches still redeem the record).
    for (const authorization of issued) {
      await codeOf(context, {
        authorization,
        dependencies: { effectiveUid: () => 0 },
      });
    }
    assert.equal(await codeOf(context, { authorization: issue(context) }), 'started');
  });
});

test('an authorization from another (or restarted) process is never valid here', async () => {
  await withFakeRuntime('codex', codexSuccess, async (context) => {
    const authorization = issue(context);
    // A fresh process with its own registry, like a restarted worker, loads the same modules and
    // receives the serialized authorization.
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = pathToFileURL(join(here, '..', 'src', 'index.ts')).href;
    const script = join(context.directory, 'other-process.mts');
    writeFileSync(
      script,
      `import { codexAdapter, startAgentExecution } from ${JSON.stringify(entry)};
const input = JSON.parse(process.argv[2]);
const result = await startAgentExecution({ ...input, securityMode: 'trusted_local', adapter: codexAdapter, emit: () => undefined });
process.stdout.write(JSON.stringify(result.started ? { started: true } : result));
if (result.started) await result.handle.stop();
`,
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--conditions=@ai-agent-manager/source',
        '--import',
        'tsx',
        script,
        JSON.stringify({
          installation: context.installation,
          authorization,
          request: { runId, prompt, modelId: null, workingDirectory: context.workspace },
        }),
      ],
      { cwd: join(here, '..') },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.code, 'authorization_mismatch');
    assert.match(result.message, /not issued by the Trusted Local gate in this process/);
    assert.throws(() => context.fake.invocation(), 'the other process started nothing');
    // The issuing process's record is untouched by the other process.
    assert.equal(await codeOf(context, { authorization }), 'started');
  });
});
