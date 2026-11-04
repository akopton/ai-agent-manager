import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  claudeAdapter,
  startAgentExecution,
  type CliInstallation,
  type ExecutionLimits,
} from '../src/index.js';
import {
  securityControls,
  trustedLocalExecutionAuthorizationSchema,
  trustedLocalSafeguards,
  type ExecutionAuthorization,
} from '@ai-agent-manager/core';
import type { AgentAdapter, AgentEvent, AgentRunResult } from '../src/contract.js';
import { claudeAdapterSpecification } from '../src/claude-adapter.js';
import { codexAdapterSpecification } from '../src/codex-adapter.js';
import { createAdapter } from '../src/invocation.js';
import {
  authorizationFor,
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

// Test-only adapters whose profiles claim verified enforcement, so the launch path can be
// exercised against fake CLIs. The shipped adapters are unverified and can never launch.
const testClaude = createAdapter({
  ...claudeAdapterSpecification,
  securityProfile: verifiedTestProfile(claudeAdapterSpecification.securityProfile, '2.1.317'),
});
const testCodex = createAdapter({
  ...codexAdapterSpecification,
  securityProfile: verifiedTestProfile(codexAdapterSpecification.securityProfile, '0.166.0'),
});

const claudeSuccess: FakeStep[] = [
  {
    stdout: JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's-1',
      model: 'claude-x',
    }),
  },
  {
    stdout: JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Working.' }] },
    }),
  },
  {
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
    }),
  },
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
    const adapter = runtime === 'claude' ? testClaude : testCodex;
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

const start = async (
  context: Context,
  overrides: {
    modelId?: string | null;
    timeoutMs?: number;
    emit?: (event: AgentEvent) => void;
  } = {},
  limits: Partial<ExecutionLimits> = { stopGraceMs: 300 },
) => {
  const collector = collectEvents();
  const modelId = overrides.modelId ?? null;
  const sourceEnvironment = {
    ...process.env,
    GIT_DIR: '/elsewhere',
    SSH_AUTH_SOCK: '/tmp/agent',
    ANTHROPIC_API_KEY: 'k',
  };
  const result = await startAgentExecution({
    adapter: context.adapter,
    installation: context.installation,
    request: {
      runId: 'run-1',
      prompt: 'Write a.ts. Secret prompt text.',
      modelId,
      workingDirectory: context.workspace,
      ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    },
    authorization: authorizationFor(
      context.adapter,
      context.installation,
      context.workspace,
      {},
      { modelId, sourceEnvironment },
    ),
    emit: overrides.emit ?? collector.emit,
    limits,
    sourceEnvironment,
  });
  assert.equal(result.started, true, JSON.stringify(result));
  if (!result.started) throw new Error('not started');
  return { handle: result.handle, events: collector.events };
};

const waitFor = async (condition: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const terminalEvents = (events: AgentEvent[]) =>
  events.filter((event) => ['completed', 'failed', 'stopped'].includes(event.type));

const assertFailed = (result: AgentRunResult, code: string) => {
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.equal(result.status === 'failed' ? result.code : null, code, JSON.stringify(result));
};

test('runs Claude with the exact prepared invocation and reports completion', async () => {
  await withFakeRuntime('claude', claudeSuccess, async (context) => {
    const { handle, events } = await start(context, { modelId: 'opus' });
    const result = await handle.completed;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.status === 'completed' ? result.summary : null, 'Done.');
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 's-1');
    assert.equal(result.reportedModelId, 'claude-x');
    assert.equal(result.lingeringProcesses, 'none');

    const invocation = context.fake.invocation();
    assert.deepEqual(invocation.args, [
      ...context.adapter.securityProfile.launchArguments,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'opus',
    ]);
    assert.equal(invocation.cwd, context.workspace);
    assert.equal(invocation.stdin, 'Write a.ts. Secret prompt text.');
    for (const name of ['GIT_DIR', 'SSH_AUTH_SOCK', 'ANTHROPIC_API_KEY']) {
      assert.ok(!invocation.envNames.includes(name), name);
    }
    assert.equal(invocation.env.GIT_TERMINAL_PROMPT, '0');

    assert.deepEqual(
      events.map((event) => event.type),
      ['started', 'metadata', 'message', 'completed'],
    );
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_, index) => index + 1),
    );
    assert.ok(events.every((event) => event.runId === 'run-1' && event.runtime === 'claude'));
    assert.ok(
      !JSON.stringify(events).includes('Secret prompt text'),
      'the prompt is never emitted',
    );
    assert.equal(terminalEvents(events).length, 1);
  });
});

test('runs Codex with the prompt on stdin and the Default model', async () => {
  await withFakeRuntime(
    'codex',
    [
      { stdout: JSON.stringify({ type: 'thread.started', thread_id: 't-1' }) },
      {
        stdout: JSON.stringify({
          type: 'item.completed',
          item: { id: 'i', type: 'agent_message', text: 'Done.' },
        }),
      },
      { stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) },
    ],
    async (context) => {
      const { handle } = await start(context);
      const result = await handle.completed;
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.sessionId, 't-1');
      const invocation = context.fake.invocation();
      assert.deepEqual(invocation.args, [...context.adapter.securityProfile.launchArguments, '-']);
      assert.ok(!invocation.args.includes('--model'));
    },
  );
});

test('reports a non-zero exit as a failure with the last stderr line', async () => {
  await withFakeRuntime(
    'claude',
    [{ stderr: 'Error: not logged in' }, { exit: 1 }],
    async (context) => {
      const { handle, events } = await start(context);
      const result = await handle.completed;
      assertFailed(result, 'non_zero_exit');
      assert.equal(result.exitCode, 1);
      assert.match(result.status === 'failed' ? result.message : '', /not logged in/);
      assert.ok(events.some((event) => event.type === 'stderr'));
    },
  );
});

test('classifies a refused explicit model without fallback', async () => {
  await withFakeRuntime(
    'codex',
    [
      {
        stdout: JSON.stringify({
          type: 'turn.failed',
          error: { message: "The 'gpt-x' model is not supported." },
        }),
      },
      { exit: 1 },
    ],
    async (context) => {
      const { handle } = await start(context, { modelId: 'gpt-x' });
      const result = await handle.completed;
      assertFailed(result, 'model_unavailable');
      // Exactly one process ran: nothing retried with another model.
      assert.deepEqual(context.fake.invocation().args.slice(-3), ['--model', 'gpt-x', '-']);
    },
  );
});

test('reports exit code 0 without a result as incomplete output', async () => {
  await withFakeRuntime(
    'claude',
    [{ stdoutRaw: '{"type":"assistant","mess' }, { exit: 0 }],
    async (context) => {
      const { handle, events } = await start(context);
      assertFailed(await handle.completed, 'incomplete_output');
      assert.ok(
        events.some((event) => event.type === 'diagnostic' && event.code === 'malformed_output'),
      );
    },
  );
});

test('stop sends SIGTERM to the process group and reports stopped, not success', async () => {
  await withFakeRuntime(
    'claude',
    [{ stdout: '{"type":"system","subtype":"init"}' }, { hang: true }],
    async (context) => {
      const { handle, events } = await start(context);
      await waitFor(() => events.some((event) => event.type === 'started'));
      const result = await handle.stop();
      assert.equal(result.status, 'stopped');
      assert.equal(result.signal, 'SIGTERM');
      assert.equal(await handle.stop(), result, 'stop is idempotent');
      const types = events.map((event) => event.type);
      assert.ok(types.indexOf('stopping') < types.indexOf('stopped'));
      assert.equal(terminalEvents(events).length, 1);
    },
  );
});

test('a CLI that exits 0 or 143 after SIGTERM is still reported as stopped', async () => {
  for (const exitCode of [0, 143]) {
    await withFakeRuntime(
      'claude',
      [...claudeSuccess.slice(0, 1), { hang: true }],
      async (context) => {
        const { handle, events } = await start(context);
        await waitFor(() => events.some((event) => event.type === 'metadata'));
        const result = await handle.stop();
        assert.equal(result.status, 'stopped', `exit ${exitCode}`);
        assert.equal(result.exitCode, exitCode);
        assert.equal(result.signal, null);
      },
      { onSigterm: { exit: exitCode } },
    );
  }
});

test('escalates to SIGKILL when SIGTERM is ignored', async () => {
  await withFakeRuntime(
    'codex',
    [{ stdout: '{"type":"turn.started"}' }, { hang: true }],
    async (context) => {
      const { handle, events } = await start(context);
      await waitFor(() => events.some((event) => event.type === 'started'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await handle.stop();
      assert.equal(result.status, 'stopped');
      assert.equal(result.signal, 'SIGKILL');
    },
    { onSigterm: 'ignore' },
  );
});

test('a SIGTERM that AI Agent Manager did not send is a failure', async () => {
  await withFakeRuntime('claude', [{ killSelf: 'SIGTERM' }], async (context) => {
    const { handle } = await start(context);
    const result = await handle.completed;
    assertFailed(result, 'terminated_by_signal');
    assert.equal(result.signal, 'SIGTERM');
  });
});

test('terminates the run on timeout', async () => {
  await withFakeRuntime('claude', [{ hang: true }], async (context) => {
    const { handle, events } = await start(context, { timeoutMs: 200 });
    const result = await handle.completed;
    assertFailed(result, 'timeout');
    assert.ok(events.some((event) => event.type === 'stopping' && event.reason === 'timeout'));
  });
});

test('terminates the run when stdout exceeds the output limit', async () => {
  const line = JSON.stringify({ type: 'system', subtype: 'status', filler: 'x'.repeat(1_000) });
  await withFakeRuntime(
    'claude',
    [...Array.from({ length: 20 }, () => ({ stdout: line })), { hang: true }],
    async (context) => {
      const { handle } = await start(context, {}, { stopGraceMs: 300, maxStdoutBytes: 5_000 });
      const result = await handle.completed;
      assertFailed(result, 'output_limit_exceeded');
      assert.ok(result.stdoutBytes > 5_000);
    },
  );
});

test('discards overlong lines and bounds stderr events', async () => {
  await withFakeRuntime(
    'claude',
    [
      {
        stdout: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'y'.repeat(5_000) }] },
        }),
      },
      ...Array.from({ length: 10 }, () => ({ stderr: 'e'.repeat(500) })),
      ...claudeSuccess,
    ],
    async (context) => {
      const { handle, events } = await start(
        context,
        {},
        {
          stopGraceMs: 300,
          maxLineBytes: 2_000,
          maxStderrEventBytes: 1_200,
        },
      );
      const result = await handle.completed;
      assert.equal(result.status, 'completed');
      assert.ok(
        events.some((event) => event.type === 'diagnostic' && event.code === 'line_truncated'),
      );
      assert.equal(events.filter((event) => event.type === 'stderr').length, 2);
      assert.equal(
        events.filter((event) => event.type === 'diagnostic' && event.code === 'stderr_truncated')
          .length,
        1,
      );
    },
  );
});

test('terminates processes left in the process group after the CLI exits', async () => {
  await withFakeRuntime(
    'claude',
    [{ spawnLingeringChild: true }, ...claudeSuccess, { exit: 0 }],
    async (context) => {
      const { handle, events } = await start(context);
      const result = await handle.completed;
      assert.equal(result.status, 'completed');
      assert.equal(result.lingeringProcesses, 'terminated');
      assert.equal(isAlive(context.fake.lingeringChildPid()), false);
      assert.ok(
        events.some((event) => event.type === 'diagnostic' && event.code === 'lingering_processes'),
      );
    },
  );
});

test('stop reaches only the process group; a descendant in its own session survives', async () => {
  // Documents a known limitation, not desired behavior: there is no process-tree tracking, so the
  // result must not claim more than process-group containment.
  const tag = `aam-escaped-${randomBytes(16).toString('hex')}`;
  await withFakeRuntime(
    'claude',
    [{ spawnDetachedChild: tag }, { spawnLingeringChild: true }, { hang: true }],
    async (context) => {
      const { handle } = await start(context);
      const pidReady = (read: () => number) => () => {
        try {
          return read() > 0;
        } catch {
          return false;
        }
      };
      await waitFor(pidReady(context.fake.detachedChildPid));
      await waitFor(pidReady(context.fake.lingeringChildPid));
      const detachedPid = context.fake.detachedChildPid();
      const result = await handle.stop();
      try {
        assert.equal(result.status, 'stopped');
        assert.equal(result.processContainment, 'process_group_only');
        // The group was signalled during stop, so nothing was left in it to report.
        assert.equal(result.lingeringProcesses, 'none');
        assert.equal(isAlive(context.fake.lingeringChildPid()), false);
        assert.equal(isAlive(detachedPid), true, 'the escaped descendant is expected to survive');
      } finally {
        // Clean up exactly that PID, and only after confirming its command line carries the tag.
        const command = execFileSync('ps', ['-o', 'command=', '-p', String(detachedPid)], {
          encoding: 'utf8',
        });
        if (command.includes(tag)) process.kill(detachedPid, 'SIGKILL');
      }
    },
  );
});

test('a throwing event handler terminates the run', async () => {
  await withFakeRuntime(
    'claude',
    [...claudeSuccess.slice(0, 1), { hang: true }],
    async (context) => {
      let calls = 0;
      const { handle } = await start(context, {
        emit: (event) => {
          calls += 1;
          if (event.type === 'metadata') throw new Error('database unavailable');
        },
      });
      assertFailed(await handle.completed, 'event_handler_failed');
      assert.ok(calls >= 2);
    },
  );
});

test('refuses to launch without a matching, fresh, single-use authorization', async () => {
  await withFakeRuntime('claude', claudeSuccess, async (context) => {
    const { adapter, installation, workspace } = context;
    const request = { runId: 'run-2', prompt: 'p', modelId: null, workingDirectory: workspace };
    const attempt = (overrides: Partial<Parameters<typeof startAgentExecution>[0]>) =>
      startAgentExecution({
        adapter,
        installation,
        request,
        authorization: authorizationFor(adapter, installation, workspace),
        emit: () => undefined,
        ...overrides,
      });
    const codeOf = async (overrides: Partial<Parameters<typeof startAgentExecution>[0]>) => {
      const result = await attempt(overrides);
      if (result.started) {
        await result.handle.stop();
        return 'started';
      }
      return result.code;
    };

    // The shipped adapter's profile is unverified: even a well-formed authorization is refused.
    assert.equal(
      await codeOf({
        adapter: claudeAdapter,
        authorization: authorizationFor(claudeAdapter, installation, workspace),
      }),
      'authorization_mismatch',
    );
    const mismatches: Array<Partial<Parameters<typeof authorizationFor>[3]>> = [
      { runtimeVersion: '2.1.318' },
      { runtimeVersion: null },
      { runtime: 'codex' },
      { launchProfileId: 'other' },
      { launchArguments: [...adapter.securityProfile.launchArguments, '--add-dir', '/'] },
      { controls: [] },
      { checkedAt: new Date(Date.now() - 120_000).toISOString() },
      { checkedAt: 'not a date' },
      {
        workspace: {
          ...authorizationFor(adapter, installation, workspace).workspace,
          workingDirectory: context.directory,
        },
      },
    ];
    for (const overrides of mismatches) {
      assert.equal(
        await codeOf({
          authorization: authorizationFor(adapter, installation, workspace, overrides),
        }),
        'authorization_mismatch',
        JSON.stringify(overrides),
      );
    }

    assert.equal(
      await codeOf({ request: { ...request, modelId: '--dangerously-skip-permissions' } }),
      'model_invalid',
    );

    const authorization = authorizationFor(adapter, installation, workspace);
    assert.equal(await codeOf({ authorization }), 'started');
    assert.equal(await codeOf({ authorization }), 'authorization_mismatch', 'single use');

    // Replacing the binary after discovery is detected.
    const later = new Date(Date.now() + 5_000);
    utimesSync(context.fake.executablePath, later, later);
    assert.equal(await codeOf({}), 'executable_changed');
  });
});

test('the strict launch boundary refuses a Trusted Local authorization (SEC-02a)', async () => {
  // Trusted Local launches are not implemented (SEC-02c). Until then, a Trusted Local authorization
  // that reaches startAgentExecution, for example through an unchecked cast, must be refused
  // before anything is spawned, even with a test adapter whose profile claims enforcement.
  await withFakeRuntime('codex', [], async (context) => {
    const { adapter, installation, workspace } = context;
    const strict = authorizationFor(adapter, installation, workspace);
    const binding: Record<string, unknown> = { ...strict };
    delete binding.controls;
    const trusted = {
      ...binding,
      mode: 'trusted_local',
      policy: {
        mode: 'trusted_local',
        version: 1,
        acceptance: { disclosureVersion: '1', acceptedAt: new Date().toISOString() },
        acceptedRisks: [...securityControls],
        interactiveApproval: 'deny',
        timeoutMs: 60_000,
      },
      trustedRepository: {
        root: strict.workspace.repositoryRoot,
        commonDir: strict.workspace.commonDir,
        trustedAt: new Date().toISOString(),
      },
      controlAssessments: securityControls.map((control) => ({
        control,
        status: 'unverified',
        mechanism: 'os_sandbox',
        notes: 'fixture',
      })),
      acceptedRisks: [...securityControls],
      safeguards: [...trustedLocalSafeguards],
      processContainment: 'process_group_only',
    };
    assert.equal(trustedLocalExecutionAuthorizationSchema.safeParse(trusted).success, true);
    const result = await startAgentExecution({
      adapter,
      installation,
      request: { runId: 'run-trusted', prompt: 'p', modelId: null, workingDirectory: workspace },
      // Deliberate misuse: the strict launch boundary is typed for strict authorizations only.
      authorization: trusted as unknown as ExecutionAuthorization,
      emit: () => undefined,
    });
    assert.equal(result.started, false);
    assert.equal(!result.started && result.code, 'authorization_mismatch');
    assert.throws(() => context.fake.invocation(), 'the fake CLI must never have been started');
  });
});

test('refuses a non-canonical working directory', async () => {
  await withFakeRuntime('claude', claudeSuccess, async (context) => {
    const { adapter, installation, workspace } = context;
    const missing = join(context.directory, 'missing');
    const result = await startAgentExecution({
      adapter,
      installation,
      request: { runId: 'run-3', prompt: 'p', modelId: null, workingDirectory: missing },
      authorization: authorizationFor(adapter, installation, workspace, {
        workspace: {
          ...authorizationFor(adapter, installation, workspace).workspace,
          workingDirectory: missing,
        },
      }),
      emit: () => undefined,
    });
    assert.equal(result.started ? 'started' : result.code, 'authorization_mismatch');
  });
});

test('reports a process that cannot be spawned as spawn_failed', async () => {
  await withFakeRuntime('claude', claudeSuccess, async (context) => {
    // chmod changes neither size, inode, nor mtime, so the fingerprint still matches.
    chmodSync(context.fake.executablePath, 0o644);
    const { handle, events } = await start(context);
    const result = await handle.completed;
    assertFailed(result, 'spawn_failed');
    assert.equal(result.pid, null);
    assert.deepEqual(
      events.map((event) => event.type),
      ['failed'],
    );
  });
});

test('refuses a launch that differs from the authorized invocation', async () => {
  await withFakeRuntime('claude', claudeSuccess, async (context) => {
    const { adapter, installation, workspace } = context;
    const request = { runId: 'run-4', prompt: 'p', modelId: null, workingDirectory: workspace };
    const base = authorizationFor(adapter, installation, workspace);
    const attempt = async (authorization: typeof base, sourceEnvironment = process.env) => {
      const result = await startAgentExecution({
        adapter,
        installation,
        request,
        authorization,
        emit: () => undefined,
        sourceEnvironment,
      });
      if (result.started) {
        await result.handle.stop();
        return 'started';
      }
      return result.code;
    };
    const withInvocation = (invocation: Partial<typeof base.invocation>) => ({
      ...base,
      invocation: { ...base.invocation, ...invocation },
    });

    const cases: Array<[string, typeof base]> = [
      [
        'authorized for another model',
        authorizationFor(adapter, installation, workspace, {}, { modelId: 'opus' }),
      ],
      ['extra argument', withInvocation({ arguments: [...base.invocation.arguments, '--debug'] })],
      ['missing argument', withInvocation({ arguments: base.invocation.arguments.slice(0, -1) })],
      [
        'another executable',
        withInvocation({ executable: { ...base.invocation.executable, path: '/usr/bin/true' } }),
      ],
      [
        'another inode',
        withInvocation({
          executable: { ...base.invocation.executable, ino: base.invocation.executable.ino + 1 },
        }),
      ],
      ['another environment', withInvocation({ environmentDigest: `sha256:${'f'.repeat(64)}` })],
    ];
    for (const [name, authorization] of cases) {
      assert.equal(await attempt(authorization), 'authorization_mismatch', name);
    }
    // The environment at launch must be the one that was authorized.
    assert.equal(
      await attempt(authorizationFor(adapter, installation, workspace), {
        ...process.env,
        PATH: '/somewhere/else',
      }),
      'authorization_mismatch',
    );
    // Variables outside the allow list do not affect the digest.
    assert.equal(
      await attempt(authorizationFor(adapter, installation, workspace), {
        ...process.env,
        UNRELATED_SECRET: 'x',
      }),
      'started',
    );
  });
});
