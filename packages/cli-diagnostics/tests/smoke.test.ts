import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { AgentRuntime } from '@ai-agent-manager/core';
import { createTerminalApproval, type ApprovalSummary } from '../src/smoke/approval.js';
import { smokeChecks, type SmokeCheckId } from '../src/smoke/checks.js';
import { runSmokeCommand } from '../src/smoke/cli.js';
import {
  cleanupSmokeFixture,
  createSmokeFixture,
  smokeClaimFileName,
  verifySmokeFixture,
  type SmokeManifest,
} from '../src/smoke/fixture.js';
import {
  classifyLaunchedRun,
  smokeReportSchema,
  writeSmokeReport,
  type SmokeExecution,
  type SmokeReport,
} from '../src/smoke/report.js';
import { createSmokeRunner, type SmokeRunnerDependencies } from '../src/smoke/runner.js';
import {
  assistantSecret,
  createSmokeFake,
  stderrSecret,
  type FakeBehavior,
  type SmokeFake,
} from './smoke-fakes.js';

// Offline only: fake CLIs in temporary directories, disposable fixture repositories. Every
// runner in this file is given the fake's absolute path, so discovery never searches PATH.

const withScratch = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'aam-smoke-test-')));
  try {
    await run(directory);
  } finally {
    // Restore permissions a test may have removed before deleting.
    execFileSync('chmod', ['-R', 'u+rwX', directory]);
    rmSync(directory, { recursive: true, force: true });
  }
};

type Scenario = {
  scratch: string;
  manifestPath: string;
  manifest: SmokeManifest;
  fake: SmokeFake;
  approvals: ApprovalSummary[];
  run: (
    checkId: SmokeCheckId | string,
    options?: {
      runtime?: string;
      deps?: Partial<SmokeRunnerDependencies>;
      signal?: AbortSignal;
    },
  ) => ReturnType<ReturnType<typeof createSmokeRunner>>;
};

const fastChecks = {
  ...smokeChecks,
  timeout: { ...smokeChecks.timeout, timeoutMs: 1500 },
  stop: { ...smokeChecks.stop, timeoutMs: 20_000 },
};

const setUp = async (
  scratch: string,
  runtime: AgentRuntime,
  behavior: FakeBehavior,
): Promise<Scenario> => {
  const parent = join(scratch, 'fixtures');
  mkdirSync(parent, { mode: 0o700 });
  const { manifest, manifestPath } = await createSmokeFixture(parent);
  const fake = createSmokeFake(join(scratch, 'bin'), runtime);
  fake.setBehavior(behavior);
  const approvals: ApprovalSummary[] = [];
  const run: Scenario['run'] = (checkId, options = {}) =>
    createSmokeRunner({
      verification: 'offline_fake_cli',
      detectionOptions: { executablePath: fake.executablePath },
      checks: fastChecks,
      confirm: async (summary) => {
        approvals.push(summary);
        return {
          approved: true,
          method: 'offline_test_dependency',
          decidedAt: new Date().toISOString(),
        };
      },
      ...options.deps,
    })({
      manifestPath,
      runtime: options.runtime ?? runtime,
      checkId,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  return { scratch, manifestPath, manifest, fake, approvals, run };
};

const readReport = (path: string | null): SmokeReport => {
  assert.ok(path !== null);
  return smokeReportSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

// --- Fixture -------------------------------------------------------------------------------

test('smoke prepare creates only synthetic compatibility resources and verifies', async () => {
  await withScratch(async (scratch) => {
    const { manifest, manifestPath } = await setUp(scratch, 'codex', 'token');
    const rootEntries = readdirSync(manifest.paths.root).sort();
    assert.deepEqual(rootEntries, [
      '.aam-smoke-fixture.json',
      'origin.git',
      'repository',
      'worktrees',
    ]);
    assert.equal(existsSync(join(manifest.paths.assignedWorktree, '.aam-probe')), false);
    assert.doesNotMatch(readFileSync(manifestPath, 'utf8'), /CANARY|credential|probe/i);
    assert.equal(readFileSync(manifestPath).length > 0, true);
    assert.equal(
      git(manifest.paths.repository, 'remote', 'get-url', 'origin').trim(),
      manifest.paths.remote,
    );
    const verified = await verifySmokeFixture(manifestPath);
    assert.equal(verified.repository.root, manifest.paths.repository);
    assert.equal(verified.worktree.path, manifest.paths.assignedWorktree);
  });
});

test('smoke prepare refuses an unsafe parent', async () => {
  await withScratch(async (scratch) => {
    const parent = join(scratch, 'open');
    mkdirSync(parent, { mode: 0o777 });
    chmodSync(parent, 0o777);
    await assert.rejects(createSmokeFixture(parent), /writable by group or others/);
    const linked = join(scratch, 'link');
    mkdirSync(join(scratch, 'target'), { mode: 0o700 });
    symlinkSync(join(scratch, 'target'), linked);
    await assert.rejects(createSmokeFixture(linked), /symbolic link/);
  });
});

const refusals: Array<{ name: string; tamper: (s: Scenario) => void; reason: RegExp }> = [
  {
    name: 'a replaced repository',
    tamper: ({ manifest }) => {
      renameSync(manifest.paths.repository, `${manifest.paths.repository}-moved`);
      mkdirSync(manifest.paths.repository);
      git(manifest.paths.repository, 'init', '--quiet');
    },
    reason: /identity changed|not ready/,
  },
  {
    name: 'a manifest pointing at another repository',
    tamper: ({ manifestPath, manifest, scratch }) => {
      const elsewhere = join(scratch, 'elsewhere');
      mkdirSync(elsewhere);
      const edited = { ...manifest, paths: { ...manifest.paths, repository: elsewhere } };
      writeFileSync(manifestPath, JSON.stringify(edited), { mode: 0o600 });
    },
    reason: /outside the fixture root/,
  },
  {
    name: 'a symlinked task worktree',
    tamper: ({ manifest }) => {
      renameSync(manifest.paths.assignedWorktree, `${manifest.paths.assignedWorktree}-real`);
      symlinkSync(`${manifest.paths.assignedWorktree}-real`, manifest.paths.assignedWorktree);
    },
    reason: /not a directory/,
  },
  {
    name: 'a modified task worktree',
    tamper: ({ manifest }) => writeFileSync(join(manifest.paths.assignedWorktree, 'x.txt'), 'x'),
    reason: /not pristine/,
  },
  {
    name: 'a moved task branch',
    tamper: ({ manifest }) =>
      git(manifest.paths.assignedWorktree, 'commit', '--allow-empty', '--quiet', '-m', 'moved'),
    reason: /moved away from the base commit/,
  },
  {
    name: 'a remote outside the fixture',
    tamper: ({ manifest, scratch }) =>
      git(manifest.paths.repository, 'remote', 'set-url', 'origin', join(scratch, 'real.git')),
    reason: /remotes differ/,
  },
  {
    name: 'a manifest readable by others',
    tamper: ({ manifestPath }) => chmodSync(manifestPath, 0o644),
    reason: /private to the current user/,
  },
  {
    name: 'a foreign ownership marker',
    tamper: ({ manifest }) =>
      writeFileSync(
        join(manifest.paths.root, '.aam-smoke-fixture.json'),
        JSON.stringify({ harness: 'ai-agent-manager-smoke', fixtureId: '0'.repeat(32) }),
      ),
    reason: /ownership marker/,
  },
];

for (const { name, tamper, reason } of refusals) {
  test(`smoke run refuses ${name} before detection or approval`, async () => {
    await withScratch(async (scratch) => {
      const scenario = await setUp(scratch, 'codex', 'token');
      tamper(scenario);
      const outcome = await scenario.run('stdin-token');
      assert.equal(outcome.classification, 'aborted');
      assert.match(outcome.reasons.join(' '), reason);
      assert.equal(outcome.reportPath, null);
      assert.equal(scenario.approvals.length, 0);
      assert.equal(scenario.fake.invocations().length, 0);
    });
  });
}

// --- Input validation and approval --------------------------------------------------------------

test('unknown runtimes and check IDs are refused without any process', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    for (const [runtime, checkId] of [
      ['gemini', 'stdin-token'],
      ['codex', 'rm-rf'],
      ['codex', 'Reply with anything'],
    ] as const) {
      const outcome = await scenario.run(checkId, { runtime });
      assert.equal(outcome.classification, 'aborted');
      assert.equal(outcome.reportPath, null);
    }
    assert.equal(scenario.approvals.length, 0);
    assert.equal(scenario.fake.invocations().length, 0);
  });
});

test('the smoke command rejects non-TTY runs before discovery, and arbitrary options', async () => {
  const io = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let text = '';
    stderr.on('data', (chunk) => (text += chunk));
    return { io: { stdin: new PassThrough(), stdout, stderr }, text: () => text };
  };
  const nonTty = io();
  const code = await runSmokeCommand(
    ['run', '--manifest', '/nonexistent/m.json', '--runtime', 'codex', '--check', 'stdin-token'],
    nonTty.io,
  );
  assert.equal(code, 2);
  assert.match(nonTty.text(), /requires an interactive terminal/);
  for (const args of [
    ['run', '--manifest', 'm', '--runtime', 'codex', '--check', 'x', '--prompt', 'hi'],
    ['run', '--executable', '/bin/sh'],
    ['prepare', '--parent', '/tmp', '--manifest', 'm'],
    ['launch'],
  ]) {
    const other = io();
    assert.equal(await runSmokeCommand(args, other.io), 2, args.join(' '));
  }
});

test('terminal approval refuses non-interactive streams and requires the exact token', async () => {
  const summary = { confirmationToken: 'abcd1234/codex/stdin-token/abcdef' } as ApprovalSummary;
  const refused = await createTerminalApproval(new PassThrough(), new PassThrough())(summary);
  assert.equal(refused.approved, false);
  assert.equal(refused.reason, 'not_interactive');
  const answer = async (text: string) => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    output.resume();
    const pending = createTerminalApproval(
      input,
      output,
    )({
      ...summary,
      acceptedRisks: [],
      limitations: [],
      invocation: [],
      environmentNames: [],
    } as ApprovalSummary);
    setImmediate(() => input.write(`${text}\n`));
    return pending;
  };
  assert.equal((await answer('yes')).approved, false);
  assert.equal((await answer('abcd1234/codex/stdin-token/abcdef')).approved, true);
});

test('a declined approval launches nothing and leaves the fixture unused', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'claude', 'token');
    const outcome = await scenario.run('stdin-token', {
      deps: {
        confirm: async () => ({
          approved: false,
          method: 'offline_test_dependency',
          decidedAt: new Date().toISOString(),
          reason: 'declined',
        }),
      },
    });
    assert.equal(outcome.classification, 'aborted');
    const report = readReport(outcome.reportPath);
    assert.equal(report.approval.decision, 'declined');
    assert.equal(report.authorization.requested, false);
    assert.equal(report.launch.processStarted, false);
    assert.equal(scenario.fake.invocations().length, 0);
    assert.equal(existsSync(join(scenario.manifest.resultsDirectory, smokeClaimFileName)), false);
  });
});

test('blocked checks never run', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    const outcome = await scenario.run('auth-error');
    assert.equal(outcome.classification, 'aborted');
    assert.match(outcome.reasons.join(' '), /blocked/);
    assert.equal(scenario.approvals.length, 0);
    assert.equal(scenario.fake.invocations().length, 0);
  });
});

// --- Production path: gate → launch, same process --------------------------------------------

for (const runtime of ['claude', 'codex'] as const) {
  test(`${runtime} stdin-token passes through the Trusted Local gate and launch boundary`, async () => {
    await withScratch(async (scratch) => {
      const scenario = await setUp(scratch, runtime, 'token');
      const outcome = await scenario.run('stdin-token');
      assert.equal(outcome.classification, 'pass', outcome.reasons.join(' '));
      const report = readReport(outcome.reportPath);
      const [invocation] = scenario.fake.invocations();
      assert.ok(invocation);
      // Run and prompt binding: the authorized prompt reached stdin, never the arguments.
      assert.equal(invocation.stdinSha256, report.promptDigest);
      assert.deepEqual(invocation.args, report.cli.arguments);
      assert.equal(invocation.cwd, scenario.manifest.paths.assignedWorktree);
      assert.equal(scenario.approvals.length, 1);
      const [approval] = scenario.approvals;
      assert.ok(approval);
      assert.equal(approval.runId, report.runId);
      assert.ok(invocation.args.every((argument) => !argument.includes('AAM-COMPAT-OK')));
      assert.deepEqual(approval.invocation.slice(1), report.cli.arguments);
      assert.match(
        approval.prompt,
        /^Reply with exactly AAM-COMPAT-OK-[0-9a-f]{8} and nothing else\.$/,
      );
      assert.equal(report.verification, 'offline_fake_cli');
      assert.equal(report.authorization.authorized, true);
      assert.match(report.authorization.authorizationId ?? '', /^[0-9a-f-]{36}$/);
      assert.equal(report.authorization.disclosureVersion, 'sec-02e-smoke.2');
      assert.ok(report.authorization.acceptedRisks.length > 0);
      assert.ok(!report.authorization.safeguards.includes('post_run_git_integrity_check'));
      assert.equal(report.launch.processStarted, true);
      assert.equal(report.execution?.status, 'completed');
      assert.equal(report.execution?.securityMode, 'trusted_local');
      assert.equal(report.execution?.processContainment, 'process_group_only');
      assert.equal(report.execution?.tokenObserved, true);
      assert.equal(report.execution?.sessionIdReported, true);
      assert.equal(report.integrity.baseline, 'observed');
      assert.equal(report.integrity.status, 'clean');
      assert.equal(report.integrity.appliedAs, 'diagnostic_only');
      assert.equal(report.cli.versionAfter, report.cli.version);
      assert.equal(report.productionCapabilityClaims, 'none');
      // The fixture is preserved for inspection.
      assert.equal(existsSync(scenario.manifest.paths.root), true);
    });
  });
}

test('a fixture is used for exactly one run', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    assert.equal((await scenario.run('stdin-token')).classification, 'pass');
    const second = await scenario.run('stdin-token');
    assert.equal(second.classification, 'aborted');
    assert.match(second.reasons.join(' '), /already used/);
    assert.equal(scenario.approvals.length, 1);
    assert.equal(scenario.fake.invocations().length, 1);
  });
});

test('the report contains no prompt, assistant text, stderr text or environment values', async () => {
  await withScratch(async (scratch) => {
    process.env.AAM_SMOKE_TEST_SECRET = 'env-secret-value-0451';
    try {
      const scenario = await setUp(scratch, 'claude', 'token');
      const outcome = await scenario.run('stdin-token');
      assert.equal(outcome.classification, 'pass');
      const text = readFileSync(outcome.reportPath ?? '', 'utf8');
      for (const secret of [
        assistantSecret,
        stderrSecret,
        'env-secret-value-0451',
        'AAM_SMOKE_TEST_SECRET',
        'AAM-COMPAT-OK',
        'Reply with exactly',
      ]) {
        assert.equal(text.includes(secret), false, secret);
      }
    } finally {
      delete process.env.AAM_SMOKE_TEST_SECRET;
    }
  });
});

test('a gate denial is refused_before_launch and still compares Git integrity', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    // The executable changes between discovery and authorization (as a CLI auto-update would).
    const outcome = await scenario.run('stdin-token', {
      deps: {
        confirm: async () => {
          const later = new Date(Date.now() + 5_000);
          utimesSync(scenario.fake.executablePath, later, later);
          return {
            approved: true,
            method: 'offline_test_dependency',
            decidedAt: new Date().toISOString(),
          };
        },
      },
    });
    assert.equal(outcome.classification, 'refused_before_launch');
    const report = readReport(outcome.reportPath);
    assert.equal(report.authorization.authorized, false);
    assert.ok(report.authorization.denialCodes.includes('executable_not_verified'));
    assert.equal(report.launch.processStarted, false);
    assert.equal(report.integrity.status, 'clean');
    assert.equal(scenario.fake.invocations().length, 0);
  });
});

// --- Check outcomes -------------------------------------------------------------------------------

const outcomeCases: Array<{
  name: string;
  runtime: AgentRuntime;
  behavior: FakeBehavior;
  check: SmokeCheckId;
  expected: string;
  verify?: (report: SmokeReport) => void;
}> = [
  {
    name: 'a normal coding edit passes with a clean integrity result',
    runtime: 'claude',
    behavior: 'edit',
    check: 'coding-edit',
    expected: 'pass',
    verify: (report) => {
      assert.deepEqual(
        report.worktreeChanges?.files.map((file) => file.path),
        ['src/greeting.ts'],
      );
      assert.equal(report.worktreeChanges?.expectedEditMatched, true);
      assert.equal(report.integrity.status, 'clean');
    },
  },
  {
    name: 'a failed write tool is a compat_failure with per-tool counts and no claimed cause',
    runtime: 'claude',
    behavior: 'write-denied',
    check: 'coding-edit',
    expected: 'compat_failure',
    verify: (report) => {
      assert.deepEqual(report.execution?.toolActivity, [
        { toolName: 'Read', started: 1, completed: 1, failed: 0 },
        { toolName: 'Write', started: 1, completed: 0, failed: 1 },
        { toolName: 'other', started: 1, completed: 0, failed: 0 },
      ]);
      const reasons = report.reasons.join(' ');
      assert.match(reasons, /file-writing tool Write \(1 failed\) reported a failure/);
      assert.match(reasons, /permission denial is possible but not confirmed/);
      assert.doesNotMatch(reasons, /was denied|denied by/);
      const text = JSON.stringify(report);
      for (const secret of [
        'FILE-CONTENT-DO-NOT-REPORT',
        'TOOL-OUTPUT-DO-NOT-REPORT',
        'greeting.ts',
        'weird<tool>',
      ]) {
        assert.equal(text.includes(secret), false, secret);
      }
      assert.equal(report.worktreeChanges?.totalFiles, 0);
      assert.equal(report.integrity.status, 'clean');
    },
  },
  {
    name: 'a coding-edit run without any write tool says the edit was not attempted',
    runtime: 'codex',
    behavior: 'token',
    check: 'coding-edit',
    expected: 'compat_failure',
    verify: (report) => {
      assert.deepEqual(report.execution?.toolActivity, []);
      assert.match(report.reasons.join(' '), /No file-writing tool was observed/);
    },
  },
  {
    name: 'an edit with unrequested changes is a compat_failure',
    runtime: 'codex',
    behavior: 'edit-extra',
    check: 'coding-edit',
    expected: 'compat_failure',
    verify: (report) => assert.equal(report.worktreeChanges?.expectedEditMatched, false),
  },
  {
    name: 'an agent commit is an integrity_violation',
    runtime: 'codex',
    behavior: 'commit',
    check: 'coding-edit',
    expected: 'integrity_violation',
    verify: (report) => {
      assert.equal(report.integrity.status, 'violation');
      assert.ok(report.integrity.findings.some((finding) => finding.code === 'task_branch_moved'));
    },
  },
  {
    name: 'a common Git config change is an integrity_violation even when the CLI succeeds',
    runtime: 'claude',
    behavior: 'config',
    check: 'stdin-token',
    expected: 'integrity_violation',
    verify: (report) => {
      assert.equal(report.execution?.status, 'completed');
      assert.ok(report.integrity.findings.some((finding) => finding.code === 'config_changed'));
      assert.equal(JSON.stringify(report).includes('"value"'), false);
    },
  },
  {
    name: 'an unknown explicit model is classified as model_unavailable',
    runtime: 'claude',
    behavior: 'model-error',
    check: 'explicit-model-error',
    expected: 'pass',
    verify: (report) => {
      assert.equal(report.execution?.failureCode, 'model_unavailable');
      assert.ok(report.cli.arguments.includes('aam-nonexistent-model-000'));
      assert.equal(report.integrity.status, 'clean');
    },
  },
  {
    name: 'a crashing CLI is a compat_failure with integrity still checked',
    runtime: 'codex',
    behavior: 'crash',
    check: 'stdin-token',
    expected: 'compat_failure',
    verify: (report) => {
      assert.equal(report.execution?.failureCode, 'non_zero_exit');
      assert.equal(report.integrity.status, 'clean');
    },
  },
  {
    name: 'stop goes through AgentHandle.stop() and reports process_group_only',
    runtime: 'codex',
    behavior: 'hang',
    check: 'stop',
    expected: 'pass',
    verify: (report) => {
      assert.equal(report.execution?.status, 'stopped');
      assert.equal(report.execution?.stopRequestedBy, 'check');
      assert.equal(report.execution?.processContainment, 'process_group_only');
      assert.equal(report.integrity.status, 'clean');
    },
  },
  {
    name: 'the policy timeout terminates the run',
    runtime: 'claude',
    behavior: 'hang',
    check: 'timeout',
    expected: 'pass',
    verify: (report) => {
      assert.equal(report.execution?.failureCode, 'timeout');
      assert.equal(report.limits.timeoutMs, 1500);
      assert.equal(report.integrity.status, 'clean');
    },
  },
  {
    name: 'a timeout check that completes early is inconclusive, not pass',
    runtime: 'codex',
    behavior: 'token',
    check: 'timeout',
    expected: 'inconclusive',
  },
  {
    name: 'the tightened output limit terminates the run',
    runtime: 'codex',
    behavior: 'flood',
    check: 'output-limit',
    expected: 'pass',
    verify: (report) => {
      assert.equal(report.execution?.failureCode, 'output_limit_exceeded');
      assert.equal(report.limits.maxStdoutBytes, 4096);
      assert.equal(report.integrity.status, 'clean');
    },
  },
];

for (const { name, runtime, behavior, check, expected, verify } of outcomeCases) {
  test(name, async () => {
    await withScratch(async (scratch) => {
      const scenario = await setUp(scratch, runtime, behavior);
      const outcome = await scenario.run(check);
      assert.equal(outcome.classification, expected, outcome.reasons.join(' '));
      const report = readReport(outcome.reportPath);
      assert.equal(report.launch.processStarted, true);
      assert.equal(report.integrity.baseline, 'observed');
      verify?.(report);
    });
  });
}

test('an operator interrupt stops the run through the handle', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'claude', 'hang');
    const controller = new AbortController();
    const outcome = await scenario.run('stdin-token', {
      signal: controller.signal,
      deps: { log: (line) => (line.startsWith('Started') ? controller.abort() : undefined) },
    });
    const report = readReport(outcome.reportPath);
    assert.equal(report.execution?.status, 'stopped');
    assert.equal(report.execution?.stopRequestedBy, 'operator');
    assert.equal(report.integrity.status, 'clean');
    assert.equal(outcome.classification, 'inconclusive');
    assert.match(outcome.reasons.join(' '), /Interrupted by the operator/);
  });
});

test('an operator stop of the stop check is still inconclusive, never pass', () => {
  const execution = {
    status: 'stopped',
    failureCode: null,
    exitCode: null,
    signal: 'SIGTERM',
    durationMs: 10,
    securityMode: 'trusted_local',
    processContainment: 'process_group_only',
    lingeringProcesses: 'none',
    stopRequestedBy: 'operator',
    eventCounts: {} as Record<string, number>,
    toolActivity: [] as SmokeExecution['toolActivity'],
    diagnosticCodes: [] as string[],
    sessionIdReported: true,
    reportedModelId: null,
    tokenObserved: null,
    stdoutBytes: 1,
    stderrBytes: 0,
  } as const;
  const base = {
    checkId: 'stop',
    execution,
    integrityStatus: 'clean',
    versionChanged: false,
    worktreeChanges: null,
    requestedModelId: null,
  } as const;
  assert.equal(
    classifyLaunchedRun({ ...base, operatorInterrupted: true }).classification,
    'inconclusive',
  );
  assert.equal(
    classifyLaunchedRun({ ...base, operatorInterrupted: true, integrityStatus: 'violation' })
      .classification,
    'integrity_violation',
  );
  assert.equal(classifyLaunchedRun({ ...base, operatorInterrupted: false }).classification, 'pass');
});

test('an operator stop reports process-group scope truthfully while an escaped child survives', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'hang-children');
    const controller = new AbortController();
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let children: ReturnType<SmokeFake['children']> = null;
    try {
      const outcome = await scenario.run('stdin-token', {
        signal: controller.signal,
        deps: {
          log: (line) => {
            if (!line.startsWith('Started')) return;
            const wait = setInterval(() => {
              if (scenario.fake.children() === null) return;
              clearInterval(wait);
              controller.abort();
            }, 20);
          },
        },
      });
      children = scenario.fake.children();
      assert.ok(children !== null);
      const report = readReport(outcome.reportPath);
      assert.equal(report.execution?.status, 'stopped');
      assert.equal(report.execution?.stopRequestedBy, 'operator');
      assert.equal(report.execution?.processContainment, 'process_group_only');
      assert.ok(report.limitations.some((line) => line.includes('SEC-01')));
      assert.equal(report.integrity.status, 'clean');
      assert.equal(outcome.classification, 'inconclusive');
      // The group child was stopped with the group; the new-session child escaped (SEC-01).
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(alive(children.group), false);
      assert.equal(alive(children.escaped), true);
    } finally {
      const pids = children ?? scenario.fake.children();
      if (pids !== null && alive(pids.escaped)) process.kill(pids.escaped, 'SIGKILL');
    }
  });
});

test('a runner failure after launch stops the CLI, checks integrity and never passes', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'claude', 'hang');
    const outcome = await scenario.run('stdin-token', {
      deps: {
        log: (line) => {
          if (line.startsWith('Started')) throw new Error('simulated runner failure');
        },
      },
    });
    assert.equal(outcome.classification, 'inconclusive');
    assert.match(outcome.reasons.join(' '), /runner failed unexpectedly \(Error\)/);
    assert.equal(readFileSync(outcome.reportPath ?? '', 'utf8').includes('simulated'), false);
    assert.match(outcome.reasons.join(' '), /CLI was stopped \(stopped/);
    const report = readReport(outcome.reportPath);
    assert.equal(report.launch.processStarted, true);
    assert.equal(report.integrity.status, 'clean');
    assert.notEqual(report.integrity.beforeDigest, null);
  });
});

test('a runner failure before launch is aborted and the CLI never starts', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    const outcome = await scenario.run('stdin-token', {
      deps: {
        captureBaseline: async () => {
          throw new Error('simulated baseline failure');
        },
      },
    });
    assert.equal(outcome.classification, 'aborted');
    const report = readReport(outcome.reportPath);
    assert.equal(report.integrity.baseline, 'error');
    assert.equal(scenario.fake.invocations().length, 0);
  });
});

test('an interrupt after approval and before launch runs nothing', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    const controller = new AbortController();
    const outcome = await scenario.run('stdin-token', {
      signal: controller.signal,
      deps: {
        confirm: async () => {
          setImmediate(() => controller.abort());
          return {
            approved: true,
            method: 'offline_test_dependency',
            decidedAt: new Date().toISOString(),
          };
        },
        captureBaseline: async (options) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const { captureGitIntegritySnapshot } = await import('@ai-agent-manager/git');
          return captureGitIntegritySnapshot(options);
        },
      },
    });
    assert.equal(outcome.classification, 'aborted');
    assert.match(outcome.reasons.join(' '), /nothing ran/);
    assert.equal(scenario.fake.invocations().length, 0);
  });
});

test('reports are never overwritten', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    const outcome = await scenario.run('stdin-token');
    const report = readReport(outcome.reportPath);
    await assert.rejects(writeSmokeReport(scenario.manifest.resultsDirectory, report), /EEXIST/);
  });
});

test('Ctrl+C or end of input at the approval prompt cancels the run', async () => {
  const summary = {
    confirmationToken: 'abcd1234/codex/stdin-token/abcdef',
    acceptedRisks: [],
    limitations: [],
    invocation: [],
    environmentNames: [],
  } as unknown as ApprovalSummary;
  for (const action of ['ctrl-c', 'eof'] as const) {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    output.resume();
    const pending = createTerminalApproval(input, output)(summary);
    setImmediate(() => (action === 'ctrl-c' ? input.write('\u0003') : input.end()));
    const decision = await pending;
    assert.equal(decision.approved, false, action);
    assert.equal(decision.reason, 'interrupted', action);
  }
});

// --- Integrity failures ---------------------------------------------------------------------------

test('an incomplete baseline refuses the launch', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    const { captureGitIntegritySnapshot } = await import('@ai-agent-manager/git');
    const outcome = await scenario.run('stdin-token', {
      deps: {
        captureBaseline: async (options) => {
          const snapshot = await captureGitIntegritySnapshot(options);
          return {
            ...snapshot,
            hooks: { status: 'failed', failure: { reason: 'git_failed', message: 'simulated' } },
          };
        },
      },
    });
    assert.equal(outcome.classification, 'aborted');
    const report = readReport(outcome.reportPath);
    assert.equal(report.integrity.baseline, 'incomplete');
    assert.deepEqual(report.integrity.baselineFailedSections, ['hooks']);
    assert.equal(report.authorization.requested, false);
    assert.equal(scenario.fake.invocations().length, 0);
  });
});

test('a failed post-run inspection is inconclusive, never pass', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    const outcome = await scenario.run('stdin-token', {
      deps: {
        verifyIntegrity: async () => {
          throw new Error('simulated inspection failure');
        },
      },
    });
    assert.equal(outcome.classification, 'inconclusive');
    const report = readReport(outcome.reportPath);
    assert.equal(report.execution?.status, 'completed');
    assert.equal(report.integrity.status, 'inconclusive');
    assert.equal(report.integrity.error, 'Error');
    assert.equal(JSON.stringify(report).includes('simulated inspection failure'), false);
  });
});

test('an inconclusive comparison is inconclusive, never pass', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    const { verifyGitIntegrity } = await import('@ai-agent-manager/git');
    const outcome = await scenario.run('stdin-token', {
      deps: {
        verifyIntegrity: async (baseline) => {
          const result = await verifyGitIntegrity(baseline);
          return { ...result, comparison: { ...result.comparison, status: 'inconclusive' } };
        },
      },
    });
    assert.equal(outcome.classification, 'inconclusive');
  });
});

// --- Cleanup --------------------------------------------------------------------------------------

test('cleanup removes only a verified smoke fixture and keeps results unless asked', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    const { manifest, manifestPath } = scenario;
    writeFileSync(
      join(manifest.paths.root, '.aam-smoke-fixture.json'),
      JSON.stringify({
        harness: 'ai-agent-manager-cli-diagnostics',
        fixtureId: manifest.fixtureId,
      }),
    );
    const refused = await cleanupSmokeFixture(manifestPath);
    assert.equal(refused.status, 'refused');
    assert.equal(existsSync(manifest.paths.root), true);
    writeFileSync(
      join(manifest.paths.root, '.aam-smoke-fixture.json'),
      JSON.stringify({ harness: 'ai-agent-manager-smoke', fixtureId: manifest.fixtureId }),
    );
    const removed = await cleanupSmokeFixture(manifestPath);
    assert.equal(removed.status, 'removed');
    assert.equal(existsSync(manifest.paths.root), false);
    assert.equal(existsSync(manifest.resultsDirectory), true);
    const all = await cleanupSmokeFixture(manifestPath, { includeResults: true });
    assert.equal(all.status, 'removed');
    assert.equal(existsSync(manifest.resultsDirectory), false);
  });
});

test('cleanup refuses a replaced fixture root', async () => {
  await withScratch(async (scratch) => {
    const { manifest, manifestPath } = await setUp(scratch, 'codex', 'token');
    renameSync(manifest.paths.root, `${manifest.paths.root}-old`);
    mkdirSync(manifest.paths.root, { mode: 0o700 });
    writeFileSync(
      join(manifest.paths.root, '.aam-smoke-fixture.json'),
      JSON.stringify({ harness: 'ai-agent-manager-smoke', fixtureId: manifest.fixtureId }),
    );
    const result = await cleanupSmokeFixture(manifestPath);
    assert.equal(result.status, 'refused');
    assert.match(result.status === 'refused' ? result.reasons.join(' ') : '', /identity changed/);
    assert.equal(existsSync(`${manifest.paths.root}-old`), true);
  });
});

test('cleanup refuses while a claimed run may still be finishing', async () => {
  await withScratch(async (scratch) => {
    const { manifest, manifestPath } = await setUp(scratch, 'codex', 'token');
    const claim = join(manifest.resultsDirectory, smokeClaimFileName);
    // A live runner PID (this test process) and no report yet: the run may still be finishing.
    writeFileSync(claim, JSON.stringify({ runId: 'smoke-x', runnerPid: process.pid }), {
      mode: 0o600,
    });
    const refused = await cleanupSmokeFixture(manifestPath);
    assert.equal(refused.status, 'refused');
    assert.match(refused.status === 'refused' ? refused.reasons.join(' ') : '', /still be/);
    assert.equal(existsSync(manifest.paths.root), true);
    // A runner that is gone without a report (for example SIGKILL) no longer blocks cleanup.
    const gone = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid))'],
      {
        encoding: 'utf8',
      },
    );
    writeFileSync(claim, JSON.stringify({ runId: 'smoke-x', runnerPid: Number(gone) }));
    assert.equal((await cleanupSmokeFixture(manifestPath)).status, 'removed');
  });
});

test('cleanup is allowed after a run wrote its report', async () => {
  await withScratch(async (scratch) => {
    const scenario = await setUp(scratch, 'codex', 'token');
    assert.equal((await scenario.run('stdin-token')).classification, 'pass');
    const started = JSON.parse(
      readFileSync(join(scenario.manifest.resultsDirectory, 'run-process.json'), 'utf8'),
    ) as { cliPid: number; processGroup: number };
    assert.equal(started.processGroup, started.cliPid);
    // The claim names this (still running) test process, but the report exists.
    assert.equal((await cleanupSmokeFixture(scenario.manifestPath)).status, 'removed');
  });
});
