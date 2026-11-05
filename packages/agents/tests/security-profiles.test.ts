import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentRuntimes, assessControl, securityControls } from '@ai-agent-manager/core';
import {
  findUnsafeLaunchArguments,
  getRuntimeSecurityProfile,
  runtimeSecurityProfiles,
} from '../src/index.js';

test('shipped profiles describe every control and claim no verified enforcement', () => {
  for (const runtime of agentRuntimes) {
    const profile = getRuntimeSecurityProfile(runtime);
    assert.equal(profile.runtime, runtime);
    assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.capabilities));
    assert.deepEqual(
      profile.capabilities.map((capability) => capability.control).sort(),
      [...securityControls].sort(),
    );
    for (const capability of profile.capabilities) {
      assert.equal(capability.verification, 'unverified', `${runtime}: ${capability.control}`);
      assert.notEqual(assessControl(profile, capability.control, '0.0.0').status, 'enforced');
    }
  }
});

test('Claude restrictions are CLI permissions, not an OS sandbox', () => {
  const profile = runtimeSecurityProfiles.claude;
  for (const capability of profile.capabilities) {
    assert.notEqual(capability.mechanism, 'os_sandbox');
    assert.equal(capability.coversSubprocesses, false);
  }
});

test('Claude keeps the restricted, non-interactive profile and approves only edits (SEC-02e.4)', () => {
  const profile = runtimeSecurityProfiles.claude;
  assert.equal(profile.assessedVersion, null);
  assert.deepEqual(profile.launchArguments, [
    '--print',
    '--restricted',
    '--strict-mcp-config',
    '--permission-prompts',
    'none',
    '--permission-mode',
    'acceptEdits',
  ]);
  // The permission modes that approve without denial stay rejected next to the profile.
  for (const mode of ['auto', 'bypassPermissions']) {
    assert.equal(
      findUnsafeLaunchArguments('claude', [...profile.launchArguments, '--permission-mode', mode])
        .length,
      1,
      mode,
    );
  }
  assert.equal(
    findUnsafeLaunchArguments('claude', [
      ...profile.launchArguments,
      '--dangerously-skip-permissions',
    ]).length,
    1,
  );
});

test('Codex does not claim credential isolation', () => {
  const credential = runtimeSecurityProfiles.codex.capabilities.find(
    (capability) => capability.control === 'credential_isolation',
  );
  assert.equal(credential?.mechanism, 'none');
});

test('shipped launch arguments contain no unsafe options', () => {
  for (const runtime of agentRuntimes) {
    assert.deepEqual(
      findUnsafeLaunchArguments(runtime, getRuntimeSecurityProfile(runtime).launchArguments),
      [],
    );
  }
});

test('detects permission and sandbox bypass options', () => {
  const unsafe: Array<[(typeof agentRuntimes)[number], string[]]> = [
    ['claude', ['--dangerously-skip-permissions']],
    ['claude', ['--allow-dangerously-skip-permissions']],
    ['claude', ['--permission-mode', 'bypassPermissions']],
    ['claude', ['--permission-mode=auto']],
    ['claude', ['--add-dir', '/']],
    ['claude', ['--settings', '{"permissions":{"allow":["Bash"]}}']],
    ['claude', ['--permission-prompt-tool', 'mcp__approve']],
    ['codex', ['--dangerously-bypass-approvals-and-sandbox']],
    ['codex', ['--dangerously-bypass-hook-trust']],
    ['codex', ['--sandbox', 'danger-full-access']],
    ['codex', ['-s', 'danger-full-access']],
    ['codex', ['--sandbox=danger-full-access']],
    ['codex', ['--approve-for-me']],
    ['codex', ['--full-auto']],
    ['codex', ['-c', 'sandbox_mode="danger-full-access"']],
    ['codex', ['--config', 'sandbox_workspace_write.network_access=true']],
    ['codex', ['-c', 'approval_policy="never"']],
    ['codex', ['--add-dir=/Users']],
    ['codex', ['--cd', '/']],
    ['codex', ['--worktree']],
    ['codex', ['--profile', 'unsafe']],
    ['codex', ['--enable', 'something']],
  ];
  for (const [runtime, args] of unsafe) {
    assert.equal(
      findUnsafeLaunchArguments(runtime, args).length,
      1,
      `${runtime} ${args.join(' ')}`,
    );
  }
});

test('allows ordinary options and values that only look like flags', () => {
  assert.deepEqual(findUnsafeLaunchArguments('claude', ['--permission-mode', 'dontAsk']), []);
  assert.deepEqual(findUnsafeLaunchArguments('codex', ['--sandbox', 'read-only', '--json']), []);
  assert.deepEqual(findUnsafeLaunchArguments('codex', ['-c', 'model="x"']), []);
  // `-p` is print mode for Claude, but a configuration profile for Codex.
  assert.deepEqual(findUnsafeLaunchArguments('claude', ['-p']), []);
  assert.equal(findUnsafeLaunchArguments('codex', ['-p', 'other']).length, 1);
});
