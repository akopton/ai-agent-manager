import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getRuntimeSecurityProfile } from '@ai-agent-manager/agents';
import {
  requiredSecurityControls,
  defaultExecutionSecurityPolicy,
  securityControls,
  type AgentRuntime,
  type ControlCapability,
  type ExecutionAuthorizationDecision,
  type RuntimeSecurityProfile,
  type SecurityDenialCode,
} from '@ai-agent-manager/core';
import { createTaskWorktree, inspectTaskWorktree } from '@ai-agent-manager/git';
import {
  authorizeAgentExecution,
  type AuthorizeAgentExecutionRequest,
  type ExecutionWorkspaceRequest,
} from '../src/index.js';
import { createRepository, git, snapshot, withFixtures, writeFile } from './fixtures.js';

const testVersion = '1.0.0';

/** A profile whose capabilities are all verified OS-level enforcement; exists only in tests. */
const verifiedProfile = (
  runtime: AgentRuntime = 'codex',
  overrides: Partial<Record<(typeof securityControls)[number], Partial<ControlCapability>>> = {},
  launchArguments: string[] = ['exec', '--sandbox', 'workspace-write'],
): RuntimeSecurityProfile => ({
  id: 'verified-test-profile',
  runtime,
  assessedVersion: testVersion,
  launchArguments,
  capabilities: securityControls.map((control) => ({
    control,
    mechanism: 'os_sandbox',
    coversSubprocesses: true,
    verification: 'verified',
    evidence: 'test fixture',
    notes: 'test fixture',
    ...overrides[control],
  })),
});

type Fixture = {
  directory: string;
  root: string;
  worktreeRoot: string;
  workspace: ExecutionWorkspaceRequest;
  request: (overrides?: Partial<AuthorizeAgentExecutionRequest>) => AuthorizeAgentExecutionRequest;
};

const setUp = async (directory: string, taskId = 'task-1'): Promise<Fixture> => {
  const root = createRepository(join(directory, 'my project'));
  const worktreeRoot = join(directory, 'worktree root');
  const worktree = await createTaskWorktree({
    repositoryPath: root,
    baseBranch: 'main',
    taskId,
    worktreeRoot,
  });
  const workspace: ExecutionWorkspaceRequest = {
    taskId,
    repositoryPath: worktree.repository.root,
    commonDir: worktree.repository.commonDir,
    worktreeRoot,
    worktreePath: worktree.path,
    branchName: worktree.branch,
    baseCommit: worktree.baseCommit,
  };
  return {
    directory,
    root,
    worktreeRoot,
    workspace,
    request: (overrides = {}) => ({
      runtime: 'codex',
      runtimeVersion: testVersion,
      profile: verifiedProfile(),
      policy: { version: 1 },
      workspace,
      ...overrides,
    }),
  };
};

const denialCodes = (decision: ExecutionAuthorizationDecision): SecurityDenialCode[] => {
  assert.equal(decision.authorized, false, 'expected a denial');
  return decision.authorized ? [] : decision.denials.map((denial) => denial.code);
};

const assertDenied = (decision: ExecutionAuthorizationDecision, code: SecurityDenialCode): void => {
  const codes = denialCodes(decision);
  assert.ok(codes.includes(code), `expected ${code}, got ${codes.join(', ')}`);
};

test('authorizes a verified worktree when every required control is enforced', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const decision = await authorizeAgentExecution(
      fixture.request({ now: () => new Date('2026-01-01T00:00:00.000Z') }),
    );
    assert.equal(decision.authorized, true, JSON.stringify(decision));
    if (!decision.authorized) return;
    const { authorization } = decision;
    assert.deepEqual(authorization.workspace, {
      repositoryRoot: fixture.root,
      commonDir: fixture.workspace.commonDir,
      worktreePath: fixture.workspace.worktreePath,
      workingDirectory: fixture.workspace.worktreePath,
      branch: 'agent/task-1',
      baseCommit: fixture.workspace.baseCommit,
    });
    assert.deepEqual(
      authorization.controls.map((control) => [control.control, control.status]),
      securityControls.map((control) => [control, 'enforced']),
    );
    assert.deepEqual(authorization.launchArguments, ['exec', '--sandbox', 'workspace-write']);
    assert.equal(authorization.checkedAt, '2026-01-01T00:00:00.000Z');
    assert.ok(Object.isFrozen(authorization) && Object.isFrozen(authorization.launchArguments));
  });
});

test('denies the shipped launch profiles: their restrictions are declared, not verified', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    for (const runtime of ['claude', 'codex'] as const) {
      const decision = await authorizeAgentExecution(
        fixture.request({ runtime, profile: getRuntimeSecurityProfile(runtime) }),
      );
      assert.equal(decision.authorized, false);
      if (decision.authorized) continue;
      assert.deepEqual(
        decision.denials.map((denial) => [denial.code, denial.control]),
        requiredSecurityControls(defaultExecutionSecurityPolicy).map((control) => [
          'control_not_enforced',
          control,
        ]),
      );
    }
  });
});

test('acknowledging every risk cannot authorize the unverified shipped profiles', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const policy = {
      version: 1,
      riskAcknowledgements: securityControls.map((control) => ({
        control,
        reason: 'disposable repo',
      })),
    };
    for (const runtime of ['claude', 'codex'] as const) {
      const decision = await authorizeAgentExecution(
        fixture.request({ runtime, profile: getRuntimeSecurityProfile(runtime), policy }),
      );
      assert.equal(decision.authorized, false, runtime);
      if (decision.authorized) continue;
      // The workspace and launch arguments are valid: only the unenforced controls block it.
      assert.deepEqual(
        decision.denials.map((denial) => [denial.code, denial.control]),
        securityControls.map((control) => ['control_not_enforced', control]),
      );
      for (const denial of decision.denials) {
        assert.equal(denial.acknowledgement, 'disposable repo');
        assert.notEqual(denial.assessment?.status, 'enforced');
      }
    }
  });
});

test('an acknowledgement cannot waive an unsupported, unverified, or partial mandatory control', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const mandatory = [
      'workspace_write_confinement',
      'git_history_mutation_denied',
      'git_push_denied',
      'network_denied',
      'credential_isolation',
    ] as const;
    const weaknesses: Array<Partial<ControlCapability>> = [
      { mechanism: 'none' },
      { mechanism: 'instruction_only' },
      { verification: 'unverified' },
      { mechanism: 'cli_permission', coversSubprocesses: false },
    ];
    for (const control of mandatory) {
      for (const weakness of weaknesses) {
        const decision = await authorizeAgentExecution(
          fixture.request({
            profile: verifiedProfile('codex', { [control]: weakness }),
            policy: {
              version: 1,
              riskAcknowledgements: [{ control, reason: 'acknowledged by user' }],
            },
          }),
        );
        assert.equal(decision.authorized, false, `${control} ${JSON.stringify(weakness)}`);
        if (decision.authorized) continue;
        assert.equal(decision.denials.length, 1);
        assert.equal(decision.denials[0]?.code, 'control_not_enforced');
        assert.equal(decision.denials[0]?.control, control);
        assert.equal(decision.denials[0]?.acknowledgement, 'acknowledged by user');
      }
    }
  });
});

test('an acknowledgement for an enforced control is harmless and not part of the authorization', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const decision = await authorizeAgentExecution(
      fixture.request({
        policy: {
          version: 1,
          riskAcknowledgements: [{ control: 'git_push_denied', reason: 'n/a' }],
        },
      }),
    );
    assert.equal(decision.authorized, true, JSON.stringify(decision));
    if (!decision.authorized) return;
    assert.ok(decision.authorization.controls.every((control) => control.status === 'enforced'));
  });
});

test('missing or invalid security configuration fails closed', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    assertDenied(
      await authorizeAgentExecution(fixture.request({ policy: undefined })),
      'policy_missing',
    );
    assertDenied(
      await authorizeAgentExecution(fixture.request({ policy: null })),
      'policy_missing',
    );
    for (const policy of [
      {},
      'deny',
      { version: 1, gitMutations: 'allow' },
      { version: 1, allowPush: true },
      { version: 1, sandbox: 'none' },
    ]) {
      assertDenied(await authorizeAgentExecution(fixture.request({ policy })), 'policy_invalid');
    }
  });
});

test('allowing network only drops the network requirement', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const profile = verifiedProfile('codex', { network_denied: { mechanism: 'none' } });
    assertDenied(
      await authorizeAgentExecution(fixture.request({ profile })),
      'control_not_enforced',
    );
    const decision = await authorizeAgentExecution(
      fixture.request({ profile, policy: { version: 1, network: 'allow' } }),
    );
    assert.equal(decision.authorized, true, JSON.stringify(decision));
  });
});

test('incompatible capabilities are not enforcement', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const cases: Array<[Partial<ControlCapability>, string]> = [
      [{ coversSubprocesses: false, mechanism: 'cli_permission' }, 'cli_tools_only'],
      [{ mechanism: 'instruction_only' }, 'instruction_only'],
      [{ verification: 'unverified' }, 'unverified'],
      [{ mechanism: 'none' }, 'unsupported'],
    ];
    for (const [override, status] of cases) {
      const decision = await authorizeAgentExecution(
        fixture.request({
          profile: verifiedProfile('codex', { workspace_write_confinement: override }),
        }),
      );
      assert.equal(decision.authorized, false);
      if (decision.authorized) continue;
      assert.equal(decision.denials.length, 1);
      assert.equal(decision.denials[0]?.control, 'workspace_write_confinement');
      assert.match(decision.denials[0]?.message ?? '', new RegExp(`\\(${status},`));
    }
  });
});

test('verification of another CLI version, or an unknown version, is not trusted', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    for (const runtimeVersion of ['1.0.1', null]) {
      const decision = await authorizeAgentExecution(fixture.request({ runtimeVersion }));
      assert.equal(decision.authorized, false);
      if (decision.authorized) continue;
      assert.equal(decision.denials.length, securityControls.length);
      assert.ok(decision.denials.every((denial) => denial.code === 'control_not_enforced'));
    }
  });
});

test('rejects invalid or mismatched launch profiles', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    assertDenied(
      await authorizeAgentExecution(fixture.request({ profile: verifiedProfile('claude') })),
      'profile_invalid',
    );
    const forged = verifiedProfile();
    const capability = forged.capabilities[0];
    if (capability !== undefined) delete capability.evidence;
    assertDenied(
      await authorizeAgentExecution(fixture.request({ profile: forged })),
      'profile_invalid',
    );
  });
});

test('rejects launch profiles that request an unsafe execution mode', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const unsafe: Array<[AgentRuntime, string[]]> = [
      ['codex', ['exec', '--dangerously-bypass-approvals-and-sandbox']],
      ['codex', ['exec', '--sandbox', 'danger-full-access']],
      ['codex', ['exec', '-c', 'sandbox_mode="danger-full-access"']],
      ['codex', ['exec', '--add-dir', '/']],
      ['claude', ['--print', '--dangerously-skip-permissions']],
      ['claude', ['--print', '--permission-mode', 'bypassPermissions']],
    ];
    for (const [runtime, args] of unsafe) {
      const decision = await authorizeAgentExecution(
        fixture.request({ runtime, profile: verifiedProfile(runtime, {}, args) }),
      );
      assert.deepEqual(denialCodes(decision), ['unsafe_launch_arguments'], args.join(' '));
    }
  });
});

test('rejects malformed requests before touching the filesystem', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const invalid: Array<Partial<ExecutionWorkspaceRequest>> = [
      { worktreePath: 'relative/path' },
      { baseCommit: 'main' },
      { baseCommit: fixture.workspace.baseCommit.slice(0, 12) },
      { taskId: '../escape' },
    ];
    for (const override of invalid) {
      const decision = await authorizeAgentExecution(
        fixture.request({ workspace: { ...fixture.workspace, ...override } }),
      );
      assert.deepEqual(denialCodes(decision), ['invalid_request'], JSON.stringify(override));
    }
    assertDenied(
      await authorizeAgentExecution({
        ...fixture.request(),
        runtime: 'gemini' as AgentRuntime,
      }),
      'invalid_request',
    );
  });
});

test('rejects a missing or removed worktree', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({
          workspace: {
            ...fixture.workspace,
            worktreePath: join(fixture.worktreeRoot, 'missing'),
          },
        }),
      ),
      'worktree_not_verified',
    );
    git(fixture.root, 'worktree', 'unlock', fixture.workspace.worktreePath);
    git(fixture.root, 'worktree', 'remove', fixture.workspace.worktreePath);
    assertDenied(await authorizeAgentExecution(fixture.request()), 'worktree_not_verified');
  });
});

test('rejects a worktree on the wrong task branch', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({ workspace: { ...fixture.workspace, branchName: 'agent/other' } }),
      ),
      'branch_mismatch',
    );
    git(fixture.workspace.worktreePath, 'switch', '--quiet', '-c', 'other');
    assertDenied(await authorizeAgentExecution(fixture.request()), 'branch_mismatch');
  });
});

test('rejects a worktree whose HEAD moved away from the recorded base commit', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    writeFile(join(fixture.workspace.worktreePath, 'agent.txt'), 'committed by the agent\n');
    git(fixture.workspace.worktreePath, 'add', 'agent.txt');
    git(fixture.workspace.worktreePath, 'commit', '--quiet', '-m', 'Agent commit');
    assertDenied(await authorizeAgentExecution(fixture.request()), 'unexpected_head');
  });
});

test('rejects the wrong repository identity', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const other = createRepository(join(directory, 'other project'));
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({ workspace: { ...fixture.workspace, commonDir: join(other, '.git') } }),
      ),
      'repository_mismatch',
    );
    const decision = await authorizeAgentExecution(
      fixture.request({ workspace: { ...fixture.workspace, repositoryPath: other } }),
    );
    assertDenied(decision, 'repository_mismatch');
    assertDenied(decision, 'worktree_not_verified');
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({
          workspace: { ...fixture.workspace, repositoryPath: fixture.workspace.worktreePath },
        }),
      ),
      'repository_invalid',
    );
  });
});

test('rejects worktrees without the AI Agent Manager ownership marker', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    git(fixture.root, 'worktree', 'unlock', fixture.workspace.worktreePath);
    assertDenied(await authorizeAgentExecution(fixture.request()), 'ownership_not_verified');
    git(
      fixture.root,
      'worktree',
      'lock',
      '--reason',
      'someone else',
      fixture.workspace.worktreePath,
    );
    assertDenied(await authorizeAgentExecution(fixture.request()), 'ownership_not_verified');
  });
});

test('does not accept a manually created worktree at the expected location', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const key = (await inspectTaskWorktree({ ...fixture.workspace, repositoryPath: fixture.root }))
      .repository.key;
    const manual = join(fixture.worktreeRoot, key, 'task-2');
    git(fixture.root, 'worktree', 'add', '--quiet', '-b', 'agent/task-2', manual);
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({
          workspace: {
            ...fixture.workspace,
            taskId: 'task-2',
            worktreePath: manual,
            branchName: 'agent/task-2',
          },
        }),
      ),
      'ownership_not_verified',
    );
  });
});

test('rejects the main checkout as the worktree', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({
          workspace: { ...fixture.workspace, worktreePath: fixture.root, branchName: 'main' },
        }),
      ),
      'unsafe_path_relationship',
    );
  });
});

test('rejects symlinked and non-canonical paths', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const link = join(directory, 'link to worktree');
    symlinkSync(fixture.workspace.worktreePath, link);
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({ workspace: { ...fixture.workspace, worktreePath: link } }),
      ),
      'path_not_canonical',
    );
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({
          workspace: {
            ...fixture.workspace,
            worktreePath: `${fixture.workspace.worktreePath}/../task-1`,
          },
        }),
      ),
      'path_not_canonical',
    );
    const repositoryLink = join(directory, 'link to repository');
    symlinkSync(fixture.root, repositoryLink);
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({ workspace: { ...fixture.workspace, repositoryPath: repositoryLink } }),
      ),
      'path_not_canonical',
    );
  });
});

test('rejects working directories that escape the worktree', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const { worktreePath } = fixture.workspace;
    const escape = join(worktreePath, 'escape');
    symlinkSync(fixture.root, escape);
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({ workspace: { ...fixture.workspace, workingDirectory: escape } }),
      ),
      'path_not_canonical',
    );
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({ workspace: { ...fixture.workspace, workingDirectory: fixture.root } }),
      ),
      'path_outside_workspace',
    );

    const nested = join(worktreePath, 'vendor', 'nested');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init', '--quiet', '.');
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({ workspace: { ...fixture.workspace, workingDirectory: nested } }),
      ),
      'unsafe_path_relationship',
    );

    const source = join(worktreePath, 'src');
    mkdirSync(source);
    const decision = await authorizeAgentExecution(
      fixture.request({ workspace: { ...fixture.workspace, workingDirectory: source } }),
    );
    assert.equal(decision.authorized, true, JSON.stringify(decision));
    if (decision.authorized)
      assert.equal(decision.authorization.workspace.workingDirectory, source);
  });
});

test('rejects worktrees outside the managed layout for the task', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const otherRoot = join(directory, 'other root');
    mkdirSync(otherRoot);
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({ workspace: { ...fixture.workspace, worktreeRoot: otherRoot } }),
      ),
      'path_outside_workspace',
    );
    assertDenied(
      await authorizeAgentExecution(
        fixture.request({ workspace: { ...fixture.workspace, taskId: 'task-2' } }),
      ),
      'path_outside_workspace',
    );
  });
});

test("rejects another task's worktree and nested worktrees", async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const second = await createTaskWorktree({
      repositoryPath: fixture.root,
      baseBranch: 'main',
      taskId: 'task-2',
      worktreeRoot: fixture.worktreeRoot,
    });
    // Task 1's recorded facts pointing at task 2's worktree.
    const crossed = await authorizeAgentExecution(
      fixture.request({ workspace: { ...fixture.workspace, worktreePath: second.path } }),
    );
    assertDenied(crossed, 'branch_mismatch');

    git(
      fixture.root,
      'worktree',
      'add',
      '--quiet',
      '-b',
      'nested',
      join(fixture.workspace.worktreePath, 'nested'),
    );
    assertDenied(await authorizeAgentExecution(fixture.request()), 'unsafe_path_relationship');
  });
});

test('collects every independent denial instead of stopping at the first', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    git(fixture.root, 'worktree', 'unlock', fixture.workspace.worktreePath);
    const codes = denialCodes(
      await authorizeAgentExecution(
        fixture.request({ policy: undefined, profile: verifiedProfile('codex', {}, ['--yolo']) }),
      ),
    );
    assert.deepEqual(codes, [
      'policy_missing',
      'unsafe_launch_arguments',
      'ownership_not_verified',
    ]);
  });
});

test('authorization does not modify the repository or the worktrees', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    writeFile(join(fixture.workspace.worktreePath, 'partial.txt'), 'agent output\n');
    const before = snapshot(directory);
    assert.equal((await authorizeAgentExecution(fixture.request())).authorized, true);
    await authorizeAgentExecution(fixture.request({ policy: undefined }));
    await authorizeAgentExecution(
      fixture.request({ workspace: { ...fixture.workspace, branchName: 'agent/other' } }),
    );
    assert.deepEqual(snapshot(directory), before);
  });
});

test('preserves Git hardening: repository-configured fsmonitor and hooks never run', async () => {
  await withFixtures(async (directory) => {
    const fixture = await setUp(directory);
    const marker = join(directory, 'executed');
    const script = join(directory, 'hostile.sh');
    writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(script, 0o755);
    git(fixture.root, 'config', 'core.fsmonitor', script);
    git(fixture.root, 'config', 'core.hooksPath', directory);
    writeFile(join(directory, 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`);
    assert.equal((await authorizeAgentExecution(fixture.request())).authorized, true);
    assert.equal(existsSync(marker), false);
  });
});
