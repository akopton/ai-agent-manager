import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  getAgentAdapter,
  prepareConversationTurn,
  startAgentExecution,
  startConversationTurn,
  type CliInstallation,
} from '@ai-agent-manager/agents';
import {
  conversationDisclosure,
  conversationTurnTimeoutMs,
  type AgentRuntime,
  type ConversationDenialCode,
} from '@ai-agent-manager/core';
import {
  authorizeConversationTurn,
  type AuthorizeConversationTurnRequest,
  type ConversationGateState,
} from '../src/index.js';
import { createRepository, withFixtures } from './fixtures.js';

// C2 conversation gate: fail-closed Strict mode, separate consent, scratch-directory checks and
// single-use authorizations, with fake CLIs and disposable repositories only.

const acceptedAt = new Date(Date.now() - 60_000).toISOString();

const helpTexts: Record<AgentRuntime, string> = {
  claude:
    '--disable-slash-commands --model --no-session-persistence --output-format --permission-mode --permission-prompts --print --restricted --safe-mode --strict-mcp-config --tools --verbose\n',
  codex:
    '--model --sandbox --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules --json\n',
};
const versionLines: Record<AgentRuntime, string> = {
  claude: '2.1.317 (Claude Code)',
  codex: 'codex-cli 0.166.0',
};

const fakeCli = (directory: string, runtime: AgentRuntime): string => {
  const path = join(directory, runtime);
  writeFileSync(
    path,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') process.stdout.write(${JSON.stringify(versionLines[runtime])} + '\\n');
else if (args.includes('--help')) process.stdout.write(${JSON.stringify(helpTexts[runtime])});
else {
  let input = '';
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    const out = ${runtime === 'claude'}
      ? [{ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }, { type: 'result', subtype: 'success', is_error: false, result: 'ok' }]
      : [{ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'ok' } }, { type: 'turn.completed' }];
    process.stdout.write(out.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
  });
}
`,
  );
  chmodSync(path, 0o755);
  return realpathSync(path);
};

type Setup = {
  installation: CliInstallation;
  scratchRoot: string;
  scratch: string;
  repository: string;
  state: ConversationGateState;
};

const setUp = async (directory: string, runtime: AgentRuntime = 'claude'): Promise<Setup> => {
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const detection = await getAgentAdapter(runtime).detect({
    executablePath: fakeCli(bin, runtime),
  });
  assert.equal(detection.status, 'available');
  if (detection.status !== 'available') throw new Error('unreachable');
  const scratchRoot = join(directory, 'data', 'conversation-scratch');
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = realpathSync(mkdtempSync(join(scratchRoot, 'turn-')));
  const repository = createRepository(join(directory, 'repo'));
  return {
    installation: detection.installation,
    scratchRoot: realpathSync(scratchRoot),
    scratch,
    repository,
    state: {
      enabled: true,
      currentDisclosureVersion: conversationDisclosure.version,
      acceptance: { disclosureVersion: conversationDisclosure.version, acceptedAt },
      scratchRoot: realpathSync(scratchRoot),
      protectedPaths: [repository, join(repository, '.git'), join(directory, 'worktrees')],
    },
  };
};

const request = (
  setup: Setup,
  overrides: Partial<AuthorizeConversationTurnRequest> = {},
): AuthorizeConversationTurnRequest => {
  const turnId = overrides.turn?.turnId ?? randomUUID();
  const prompt = overrides.turn?.prompt ?? 'Plan it';
  const scratchDirectory = overrides.scratchDirectory ?? setup.scratch;
  const modelId = overrides.modelId ?? null;
  const preparation = prepareConversationTurn(setup.installation, {
    turnId,
    prompt,
    modelId,
    scratchDirectory,
  });
  assert.ok(preparation.ok, preparation.ok ? '' : preparation.message);
  if (!preparation.ok) throw new Error('unreachable');
  return {
    policy: {
      mode: 'trusted_local',
      version: 1,
      acceptance: { disclosureVersion: conversationDisclosure.version, acceptedAt },
      timeoutMs: conversationTurnTimeoutMs,
    },
    turn: { turnId, prompt },
    runtime: setup.installation.runtime,
    installation: setup.installation,
    modelId,
    invocation: preparation.plan.invocation,
    scratchDirectory,
    ...overrides,
  };
};

const denialCodes = async (
  input: AuthorizeConversationTurnRequest,
  state: ConversationGateState,
): Promise<ConversationDenialCode[]> => {
  const decision = await authorizeConversationTurn(input, state);
  return decision.authorized ? [] : decision.denials.map((denial) => denial.code);
};

test('authorizes a Trusted Local turn with honest assessments and launches it once', async () => {
  await withFixtures(async (directory) => {
    const setup = await setUp(directory);
    const input = request(setup);
    const decision = await authorizeConversationTurn(input, setup.state);
    assert.ok(decision.authorized, decision.authorized ? '' : JSON.stringify(decision.denials));
    if (!decision.authorized) return;
    const { authorization } = decision;
    assert.equal(authorization.kind, 'conversation_turn');
    assert.equal(authorization.launchProfileId, 'claude-conversation-no-tools');
    assert.ok(authorization.controlAssessments.every((entry) => entry.status !== 'enforced'));
    assert.equal(authorization.acceptedRisks.length, authorization.controlAssessments.length);
    assert.ok(!('controls' in authorization));
    // Not an execution authorization.
    const asExecution = await startAgentExecution({
      adapter: getAgentAdapter('claude'),
      installation: setup.installation,
      request: { runId: 'r1', prompt: 'Plan it', modelId: null, workingDirectory: setup.scratch },
      securityMode: 'trusted_local',
      authorization: authorization as never,
      emit: () => {},
    });
    assert.equal(asExecution.started, false);

    const started = await startConversationTurn({
      installation: setup.installation,
      request: {
        turnId: input.turn.turnId,
        prompt: input.turn.prompt,
        modelId: null,
        scratchDirectory: setup.scratch,
      },
      authorization,
      emit: () => {},
    });
    // The execution boundary did not consume the conversation registry entry.
    assert.ok(started.started, started.started ? '' : started.message);
    if (started.started) assert.equal((await started.handle.completed).status, 'completed');
  });
});

test('Strict Isolated conversations are fail-closed and never downgraded', async () => {
  await withFixtures(async (directory) => {
    const setup = await setUp(directory);
    const codes = await denialCodes(
      request(setup, { policy: { mode: 'strict_isolated', version: 1 } }),
      setup.state,
    );
    assert.ok(codes.length > 0);
    assert.ok(codes.every((code) => code === 'control_not_enforced'));
  });
});

test('consent comes only from the separate AI Conversations acceptance', async () => {
  await withFixtures(async (directory) => {
    const setup = await setUp(directory);
    assert.ok(
      (await denialCodes(request(setup), { ...setup.state, enabled: false })).includes(
        'conversation_disabled',
      ),
    );
    assert.ok(
      (await denialCodes(request(setup), { ...setup.state, acceptance: null })).includes(
        'acceptance_missing',
      ),
    );
    assert.ok(
      (
        await denialCodes(request(setup), {
          ...setup.state,
          acceptance: { disclosureVersion: '2020-01-01.1', acceptedAt },
        })
      ).includes('acceptance_stale'),
    );
    // A Trusted Local *execution* policy is not a conversation policy.
    assert.deepEqual(
      await denialCodes(
        request(setup, {
          policy: {
            mode: 'trusted_local',
            version: 1,
            acceptance: { disclosureVersion: 'x', acceptedAt },
            acceptedRisks: [],
            interactiveApproval: 'deny',
            timeoutMs: 1000,
          },
        }),
        setup.state,
      ),
      ['policy_invalid'],
    );
    assert.deepEqual(await denialCodes(request(setup, { policy: undefined }), setup.state), [
      'policy_missing',
    ]);
  });
});

test('the scratch directory must be private, empty and outside repositories', async () => {
  await withFixtures(async (directory) => {
    const setup = await setUp(directory);
    // Inside a connected repository.
    const inRepo = join(setup.repository, 'scratch');
    mkdirSync(inRepo, { mode: 0o700 });
    assert.ok(
      (
        await denialCodes(request(setup, { scratchDirectory: realpathSync(inRepo) }), {
          ...setup.state,
          scratchRoot: setup.repository,
        })
      ).includes('scratch_directory_invalid'),
    );
    // Outside the scratch root.
    const outside = realpathSync(mkdtempSync(join(directory, 'outside-')));
    assert.ok(
      (await denialCodes(request(setup, { scratchDirectory: outside }), setup.state)).includes(
        'scratch_directory_invalid',
      ),
    );
    // Not empty.
    writeFileSync(join(setup.scratch, 'leftover.txt'), 'x');
    assert.ok(
      (await denialCodes(request(setup), setup.state)).includes('scratch_directory_invalid'),
    );
  });
});

test('a tampered invocation or unknown CLI options are refused', async () => {
  await withFixtures(async (directory) => {
    const setup = await setUp(directory, 'codex');
    const base = request(setup);
    const tampered = {
      ...base,
      invocation: {
        ...base.invocation,
        arguments: [...base.invocation.arguments.slice(0, -1), '--add-dir', '/', '-'],
      },
    };
    const codes = await denialCodes(tampered, setup.state);
    assert.ok(codes.includes('unsafe_launch_arguments'));
    assert.ok(codes.includes('invocation_invalid'));
    const unsupported = await denialCodes(
      request(
        { ...setup, installation: setup.installation },
        {
          installation: { ...setup.installation, detectedOptions: ['--model'] },
        },
      ),
      setup.state,
    );
    assert.ok(unsupported.includes('conversation_profile_unsupported'));
  });
});
