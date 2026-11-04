import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessControl,
  defaultExecutionSecurityPolicy,
  executionSecurityModeSchema,
  executionSecurityPolicySchema,
  maxExecutionTimeoutMs,
  requiredSecurityControls,
  runtimeSecurityProfileSchema,
  securityControls,
  securityModeAuthorizationSchema,
  securityModePolicySchema,
  strictExecutionAuthorizationSchema,
  strictIsolatedPolicySchema,
  trustedLocalExecutionAuthorizationSchema,
  trustedLocalPolicySchema,
  trustedLocalSafeguards,
  type ControlAssessment,
} from '../src/index.js';

const commit = 'a'.repeat(40);
const binding = {
  authorizationId: '5f1c2a9e-3b7d-4c8e-9f0a-1b2c3d4e5f60',
  checkedAt: '2026-11-04T12:00:00.000Z',
  runtime: 'codex' as const,
  runtimeVersion: '0.166.0',
  launchProfileId: 'codex-exec-workspace-write',
  launchArguments: ['exec', '--sandbox', 'workspace-write'],
  invocation: {
    executable: { path: '/opt/cli/codex', dev: 1, ino: 2, size: 3, mtimeMs: 4 },
    arguments: ['exec', '--sandbox', 'workspace-write', '--json', '-'],
    environmentDigest: `sha256:${'b'.repeat(64)}`,
  },
  workspace: {
    repositoryRoot: '/repos/project',
    commonDir: '/repos/project/.git',
    worktreePath: '/data/worktrees/project/task-1',
    workingDirectory: '/data/worktrees/project/task-1',
    branch: 'agent/task-1',
    baseCommit: commit,
  },
};

const strictAuthorization = () => ({
  mode: 'strict_isolated' as const,
  ...binding,
  policy: defaultExecutionSecurityPolicy,
  controls: requiredSecurityControls(defaultExecutionSecurityPolicy).map((control) => ({
    control,
    status: 'enforced' as const,
    mechanism: 'os_sandbox' as const,
  })),
});

const trustedPolicy = (overrides: Record<string, unknown> = {}) => ({
  mode: 'trusted_local' as const,
  version: 1 as const,
  acceptance: { disclosureVersion: '2026-11-04.1', acceptedAt: '2026-11-04T10:00:00.000Z' },
  acceptedRisks: [...securityControls],
  interactiveApproval: 'deny' as const,
  timeoutMs: 30 * 60 * 1000,
  ...overrides,
});

/** Honest assessments as today's unverified profiles produce them. */
const unverifiedAssessments = (): ControlAssessment[] => {
  const profile = runtimeSecurityProfileSchema.parse({
    id: 'unverified-profile',
    runtime: 'codex',
    assessedVersion: null,
    launchArguments: [],
    capabilities: securityControls.map((control) => ({
      control,
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes: 'fixture',
    })),
  });
  return securityControls.map((control) => assessControl(profile, control, '0.166.0'));
};

const trustedAuthorization = (overrides: Record<string, unknown> = {}) => ({
  mode: 'trusted_local' as const,
  ...binding,
  policy: trustedPolicy(),
  trustedRepository: {
    root: '/repos/project',
    commonDir: '/repos/project/.git',
    trustedAt: '2026-11-04T09:00:00.000Z',
  },
  controlAssessments: unverifiedAssessments(),
  acceptedRisks: [...securityControls],
  safeguards: [...trustedLocalSafeguards],
  processContainment: 'process_group_only' as const,
  ...overrides,
});

test('the mode discriminator accepts exactly the two modes', () => {
  assert.deepEqual(executionSecurityModeSchema.options, ['strict_isolated', 'trusted_local']);
  for (const mode of ['strict', 'trusted', 'none', '', undefined, null]) {
    assert.equal(executionSecurityModeSchema.safeParse(mode).success, false, String(mode));
  }
});

test('policies require an explicit, known mode and never default to Trusted Local', () => {
  assert.equal(
    securityModePolicySchema.parse({ mode: 'strict_isolated', version: 1 }).mode,
    'strict_isolated',
  );
  assert.equal(securityModePolicySchema.parse(trustedPolicy()).mode, 'trusted_local');
  for (const policy of [
    { version: 1 },
    { mode: 'unknown', version: 1 },
    { ...trustedPolicy(), mode: 'TRUSTED_LOCAL' },
    { ...trustedPolicy(), mode: undefined },
  ]) {
    assert.equal(securityModePolicySchema.safeParse(policy).success, false, JSON.stringify(policy));
  }
  // The strict schema keeps its pre-SEC-02 name and is strict only.
  assert.equal(executionSecurityPolicySchema, strictIsolatedPolicySchema);
  assert.equal(executionSecurityPolicySchema.safeParse({ version: 1 }).success, false);
  assert.equal(executionSecurityPolicySchema.safeParse(trustedPolicy()).success, false);
});

test('strict and trusted policies do not accept each other’s fields', () => {
  assert.equal(
    trustedLocalPolicySchema.safeParse({
      ...trustedPolicy(),
      riskAcknowledgements: [{ control: 'network_denied', reason: 'x' }],
    }).success,
    false,
    'riskAcknowledgements belong to Strict mode only',
  );
  for (const extra of [{ network: 'allow' }, { gitMutations: 'deny' }, { controls: [] }]) {
    assert.equal(trustedLocalPolicySchema.safeParse(trustedPolicy(extra)).success, false);
  }
  assert.equal(
    strictIsolatedPolicySchema.safeParse({
      mode: 'strict_isolated',
      version: 1,
      acceptance: trustedPolicy().acceptance,
    }).success,
    false,
    'operator acceptance is not part of a strict policy',
  );
});

test('trusted policies require a versioned, timestamped acceptance and no defaults', () => {
  for (const acceptance of [
    undefined,
    {},
    { disclosureVersion: '2026-11-04.1' },
    { acceptedAt: '2026-11-04T10:00:00.000Z' },
    { disclosureVersion: '', acceptedAt: '2026-11-04T10:00:00.000Z' },
    { disclosureVersion: '../x', acceptedAt: '2026-11-04T10:00:00.000Z' },
    { disclosureVersion: 'v'.repeat(65), acceptedAt: '2026-11-04T10:00:00.000Z' },
    { disclosureVersion: '1', acceptedAt: 'yesterday' },
    { disclosureVersion: '1', acceptedAt: '2026-11-04' },
    { disclosureVersion: '1', acceptedAt: '2026-11-04T10:00:00.000Z', reason: 'extra' },
  ]) {
    assert.equal(
      trustedLocalPolicySchema.safeParse(trustedPolicy({ acceptance })).success,
      false,
      JSON.stringify(acceptance),
    );
  }
  for (const field of [
    'acceptance',
    'acceptedRisks',
    'interactiveApproval',
    'timeoutMs',
    'version',
  ]) {
    const policy: Record<string, unknown> = trustedPolicy();
    delete policy[field];
    assert.equal(trustedLocalPolicySchema.safeParse(policy).success, false, `missing ${field}`);
  }
  assert.equal(
    trustedLocalPolicySchema.safeParse(trustedPolicy({ interactiveApproval: 'allow' })).success,
    false,
  );
  for (const acceptedRisks of [['network_denied', 'network_denied'], ['unknown_control']]) {
    assert.equal(
      trustedLocalPolicySchema.safeParse(trustedPolicy({ acceptedRisks })).success,
      false,
    );
  }
});

test('trusted policies require a finite, positive, bounded integer timeout', () => {
  for (const timeoutMs of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    maxExecutionTimeoutMs + 1,
    '60000',
    null,
  ]) {
    assert.equal(
      trustedLocalPolicySchema.safeParse(trustedPolicy({ timeoutMs })).success,
      false,
      String(timeoutMs),
    );
  }
  for (const timeoutMs of [1, maxExecutionTimeoutMs]) {
    assert.equal(trustedLocalPolicySchema.parse(trustedPolicy({ timeoutMs })).timeoutMs, timeoutMs);
  }
});

test('strict authorizations keep their mandatory enforced-control representation', () => {
  const parsed = strictExecutionAuthorizationSchema.parse(strictAuthorization());
  assert.equal(parsed.mode, 'strict_isolated');
  const withoutOne = strictAuthorization();
  withoutOne.controls = withoutOne.controls.slice(1);
  const notEnforced = strictAuthorization() as Record<string, unknown>;
  notEnforced.controls = (strictAuthorization().controls as object[]).map((entry) => ({
    ...entry,
    status: 'unverified',
  }));
  const withoutMode: Record<string, unknown> = { ...strictAuthorization() };
  delete withoutMode.mode;
  for (const candidate of [
    withoutOne,
    notEnforced,
    withoutMode,
    { ...strictAuthorization(), authorizationId: 'not-a-uuid' },
    { ...strictAuthorization(), checkedAt: 'now' },
    { ...strictAuthorization(), launchArguments: ['different'] },
  ]) {
    assert.equal(strictExecutionAuthorizationSchema.safeParse(candidate).success, false);
  }
});

test('trusted authorizations record honest assessments and never claim enforcement', () => {
  const parsed = trustedLocalExecutionAuthorizationSchema.parse(trustedAuthorization());
  assert.equal(parsed.mode, 'trusted_local');
  assert.equal(parsed.processContainment, 'process_group_only');
  assert.ok(!('controls' in parsed), 'no enforced-control field');
  assert.ok(parsed.controlAssessments.every((entry) => entry.status !== 'enforced'));
  assert.deepEqual([...parsed.acceptedRisks].sort(), [...securityControls].sort());
  assert.equal(parsed.policy.acceptance.disclosureVersion, '2026-11-04.1');

  const relabelled = unverifiedAssessments().map((entry, index) =>
    index === 0 ? { ...entry, status: 'enforced' as const } : entry,
  );
  const missingAssessment = unverifiedAssessments().slice(1);
  for (const [label, overrides] of [
    ['enforced-control claim', { controls: strictAuthorization().controls }],
    ['risk listed although assessed enforced', { controlAssessments: relabelled }],
    [
      'unenforced control not listed as accepted risk',
      { acceptedRisks: securityControls.slice(1) },
    ],
    [
      'risk the operator did not accept',
      { policy: trustedPolicy({ acceptedRisks: securityControls.slice(1) }) },
    ],
    [
      'incomplete assessment',
      { controlAssessments: missingAssessment, acceptedRisks: securityControls.slice(1) },
    ],
    [
      'missing mandatory safeguard',
      { safeguards: trustedLocalSafeguards.filter((s) => s !== 'non_root') },
    ],
    ['duplicate safeguard', { safeguards: [...trustedLocalSafeguards, 'non_root'] }],
    ['containment overstated', { processContainment: 'process_tree' }],
    ['unknown CLI version', { runtimeVersion: null }],
    [
      'workspace outside the trusted repository',
      {
        trustedRepository: {
          root: '/repos/other',
          commonDir: '/repos/other/.git',
          trustedAt: '2026-11-04T09:00:00.000Z',
        },
      },
    ],
    ['invocation without profile prefix', { launchArguments: ['--other'] }],
  ] as const) {
    assert.equal(
      trustedLocalExecutionAuthorizationSchema.safeParse(trustedAuthorization(overrides)).success,
      false,
      label,
    );
  }
  // The post-run Git integrity check is optional until SEC-02d exists.
  assert.equal(
    trustedLocalExecutionAuthorizationSchema.safeParse(
      trustedAuthorization({
        safeguards: trustedLocalSafeguards.filter((s) => s !== 'post_run_git_integrity_check'),
      }),
    ).success,
    true,
  );
});

test('strict and trusted authorizations are not interchangeable', () => {
  const strict = strictAuthorization();
  const trusted = trustedAuthorization();
  assert.equal(strictExecutionAuthorizationSchema.safeParse(trusted).success, false);
  assert.equal(trustedLocalExecutionAuthorizationSchema.safeParse(strict).success, false);
  // Relabelling the mode is not enough in either direction.
  assert.equal(
    strictExecutionAuthorizationSchema.safeParse({ ...trusted, mode: 'strict_isolated' }).success,
    false,
  );
  assert.equal(
    trustedLocalExecutionAuthorizationSchema.safeParse({ ...strict, mode: 'trusted_local' })
      .success,
    false,
  );
  // A trusted authorization carrying strict fields is rejected, not merged.
  assert.equal(
    securityModeAuthorizationSchema.safeParse({ ...trusted, controls: strict.controls }).success,
    false,
  );
  assert.equal(
    securityModeAuthorizationSchema.safeParse({ ...strict, mode: 'unknown' }).success,
    false,
  );
  assert.equal(
    securityModeAuthorizationSchema.safeParse({ ...strict, mode: undefined }).success,
    false,
  );
});

test('both authorizations round-trip through JSON and preserve the shared launch binding', () => {
  for (const authorization of [strictAuthorization(), trustedAuthorization()]) {
    const parsed = securityModeAuthorizationSchema.parse(JSON.parse(JSON.stringify(authorization)));
    assert.equal(parsed.mode, authorization.mode);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(authorization)));
    for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
      assert.deepEqual(parsed[key], binding[key], key);
    }
  }
});
