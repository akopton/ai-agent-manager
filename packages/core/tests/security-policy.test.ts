import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessControl,
  defaultExecutionSecurityPolicy,
  executionSecurityPolicySchema,
  requiredSecurityControls,
  runtimeSecurityProfileSchema,
  securityControls,
  type ControlCapability,
  type RuntimeSecurityProfile,
} from '../src/index.js';

const profileWith = (capability: Partial<ControlCapability>): RuntimeSecurityProfile =>
  runtimeSecurityProfileSchema.parse({
    id: 'test-profile',
    runtime: 'codex',
    assessedVersion: '1.0.0',
    launchArguments: [],
    capabilities: [
      {
        control: 'workspace_write_confinement',
        mechanism: 'os_sandbox',
        coversSubprocesses: true,
        verification: 'verified',
        evidence: 'fixture',
        notes: 'fixture',
        ...capability,
      },
    ],
  });

test('defaults every policy field to the restrictive value', () => {
  assert.deepEqual(defaultExecutionSecurityPolicy, {
    mode: 'strict_isolated',
    version: 1,
    workspaceAccess: 'task_worktree_only',
    network: 'deny',
    interactiveApproval: 'deny',
    gitMutations: 'deny',
    riskAcknowledgements: [],
  });
  assert.ok(Object.isFrozen(defaultExecutionSecurityPolicy));
  assert.deepEqual(requiredSecurityControls(defaultExecutionSecurityPolicy), [...securityControls]);
});

test('rejects policies that request unsupported or permissive behavior', () => {
  for (const policy of [
    {},
    { version: 2 },
    { mode: 'strict_isolated', version: 1, gitMutations: 'allow' },
    { mode: 'strict_isolated', version: 1, interactiveApproval: 'allow' },
    { mode: 'strict_isolated', version: 1, workspaceAccess: 'any' },
    { mode: 'strict_isolated', version: 1, allowPush: true },
    { mode: 'strict_isolated', version: 1, riskAcknowledgements: [{ control: 'git_push_denied' }] },
    {
      mode: 'strict_isolated',
      version: 1,
      riskAcknowledgements: [{ control: 'unknown_control', reason: 'x' }],
    },
    {
      mode: 'strict_isolated',
      version: 1,
      riskAcknowledgements: [
        { control: 'network_denied', reason: 'a' },
        { control: 'network_denied', reason: 'b' },
      ],
    },
  ]) {
    assert.equal(
      executionSecurityPolicySchema.safeParse(policy).success,
      false,
      JSON.stringify(policy),
    );
  }
});

test('allowing network removes only the network control', () => {
  const policy = executionSecurityPolicySchema.parse({
    mode: 'strict_isolated',
    version: 1,
    network: 'allow',
  });
  assert.deepEqual(
    requiredSecurityControls(policy),
    securityControls.filter((control) => control !== 'network_denied'),
  );
});

test('only a verified mechanism covering subprocesses counts as enforced', () => {
  const control = 'workspace_write_confinement';
  assert.equal(assessControl(profileWith({}), control, '1.0.0').status, 'enforced');
  assert.equal(
    assessControl(profileWith({ coversSubprocesses: false }), control, '1.0.0').status,
    'cli_tools_only',
  );
  assert.equal(
    assessControl(profileWith({ verification: 'unverified' }), control, '1.0.0').status,
    'unverified',
  );
  assert.equal(
    assessControl(profileWith({ mechanism: 'instruction_only' }), control, '1.0.0').status,
    'instruction_only',
  );
  assert.equal(
    assessControl(profileWith({ mechanism: 'none' }), control, '1.0.0').status,
    'unsupported',
  );
  assert.equal(assessControl(profileWith({}), 'network_denied', '1.0.0').status, 'unsupported');
});

test('a verification for another CLI version is not trusted', () => {
  const control = 'workspace_write_confinement';
  assert.equal(assessControl(profileWith({}), control, '1.0.1').status, 'unverified');
  assert.equal(assessControl(profileWith({}), control, null).status, 'unverified');
});

test('subprocess coverage is only required for process-boundary controls', () => {
  const profile = profileWith({
    control: 'non_interactive_approval',
    mechanism: 'cli_permission',
    coversSubprocesses: false,
  });
  assert.equal(assessControl(profile, 'non_interactive_approval', '1.0.0').status, 'enforced');
});

test('verified capabilities must cite evidence and controls must be unique', () => {
  assert.throws(() => profileWith({ evidence: undefined }));
  assert.throws(() =>
    runtimeSecurityProfileSchema.parse({
      id: 'duplicate',
      runtime: 'claude',
      assessedVersion: null,
      launchArguments: [],
      capabilities: [
        {
          control: 'network_denied',
          mechanism: 'none',
          coversSubprocesses: false,
          verification: 'unverified',
          notes: 'a',
        },
        {
          control: 'network_denied',
          mechanism: 'none',
          coversSubprocesses: false,
          verification: 'unverified',
          notes: 'b',
        },
      ],
    }),
  );
});
