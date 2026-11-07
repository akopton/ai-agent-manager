import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assessControl,
  conversationSafeguards,
  conversationTurnTimeoutMs,
  securityControls,
  type AgentRuntime,
  type ConversationTurnAuthorization,
} from '@ai-agent-manager/core';
import { claimConversationIssuer } from '../src/conversation-issuance.js';
import {
  conversationSecurityProfiles,
  getConversationSecurityProfile,
} from '../src/conversation-profiles.js';
import { prepareConversationTurn, startConversationTurn } from '../src/conversation-launch.js';
import { startAgentExecution } from '../src/execution-launch.js';
import { getAgentAdapter } from '../src/registry.js';
import { runtimeSecurityProfiles } from '../src/security-profiles.js';
import {
  authorizationFor,
  claudeVersionLine,
  codexVersionLine,
  collectEvents,
  createFakeCli,
  withTemporaryDirectory,
  type FakeStep,
} from './fixtures.js';

// C2 conversation launch boundary, with fake CLIs only. The issuer is claimed here because this
// test process has no orchestrator gate; production code obtains authorizations from the gate.
const issuer = claimConversationIssuer();
assert.ok(issuer !== null);

const conversationHelp: Record<AgentRuntime, string> = {
  claude: `Usage: claude [options]
Options:
  --disable-slash-commands     Disable all skills and commands
  --model <model>              Model for the current session
  --no-session-persistence     Disable session persistence
  --output-format <format>     "text", "json", or "stream-json"
  --permission-mode <mode>     Permission mode
  --permission-prompts <target>  "host" or "none"
  -p, --print                  Print response and exit
  --restricted                 Restricted mode
  --safe-mode                  Start with all customizations disabled
  --strict-mcp-config          Only use MCP servers from --mcp-config
  --tools <tools...>           Use "" to disable all tools
  --verbose                    Override verbose mode setting
`,
  codex: `Usage: codex exec [OPTIONS] [PROMPT]
Options:
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
      --ephemeral
      --skip-git-repo-check
      --ignore-user-config
      --ignore-rules
      --json
`,
};

const versions: Record<AgentRuntime, string> = {
  claude: claudeVersionLine,
  codex: codexVersionLine,
};

const replySteps: Record<AgentRuntime, FakeStep[]> = {
  claude: [
    {
      stdout: JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        model: 'claude-sonnet-5-5',
        tools: [],
      }),
    },
    {
      stdout: JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Plan: **three** steps.' }] },
      }),
    },
    {
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Plan: **three** steps.',
      }),
    },
  ],
  codex: [
    { stdout: JSON.stringify({ type: 'thread.started', thread_id: 't' }) },
    {
      stdout: JSON.stringify({
        type: 'item.completed',
        item: { id: 'i', type: 'agent_message', text: 'Plan: three steps.' },
      }),
    },
    { stdout: JSON.stringify({ type: 'turn.completed', usage: {} }) },
  ],
};

const setup = async (directory: string, runtime: AgentRuntime, steps: FakeStep[]) => {
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const fake = createFakeCli(bin, runtime, {
    version: versions[runtime],
    help: conversationHelp[runtime],
    steps,
  });
  const detection = await getAgentAdapter(runtime).detect({ executablePath: fake.executablePath });
  assert.equal(detection.status, 'available');
  if (detection.status !== 'available') throw new Error('unreachable');
  const scratch = join(directory, 'scratch');
  mkdirSync(scratch);
  return { fake, installation: detection.installation, scratch: realpathSync(scratch) };
};

/** An authorization shaped exactly as the gate issues it, registered with the issuer. */
const issue = (
  installation: Awaited<ReturnType<typeof setup>>['installation'],
  turnId: string,
  prompt: string,
  scratchDirectory: string,
  modelId: string | null = null,
): ConversationTurnAuthorization => {
  const preparation = prepareConversationTurn(installation, {
    turnId,
    prompt,
    modelId,
    scratchDirectory,
  });
  assert.ok(preparation.ok, preparation.ok ? '' : preparation.message);
  if (!preparation.ok) throw new Error('unreachable');
  const profile = getConversationSecurityProfile(installation.runtime);
  const assessments = securityControls.map((control) =>
    assessControl(profile, control, installation.version),
  );
  const authorization: ConversationTurnAuthorization = {
    kind: 'conversation_turn',
    mode: 'trusted_local',
    authorizationId: randomUUID(),
    checkedAt: new Date().toISOString(),
    turnId,
    runtime: installation.runtime,
    runtimeVersion: installation.version,
    launchProfileId: profile.id,
    launchArguments: [...profile.launchArguments],
    invocation: preparation.plan.invocation,
    scratchDirectory,
    policy: {
      mode: 'trusted_local',
      version: 1,
      acceptance: { disclosureVersion: 'test', acceptedAt: new Date(0).toISOString() },
      timeoutMs: conversationTurnTimeoutMs,
    },
    controlAssessments: assessments,
    acceptedRisks: assessments.map((assessment) => assessment.control),
    safeguards: [...conversationSafeguards],
    processContainment: 'process_group_only',
  };
  assert.equal(issuer?.(authorization, { turnId, prompt }), true);
  return authorization;
};

test('conversation profiles differ from execution profiles and claim nothing as enforced', () => {
  for (const runtime of ['claude', 'codex'] as const) {
    const profile = conversationSecurityProfiles[runtime];
    assert.notEqual(profile.id, runtimeSecurityProfiles[runtime].id);
    for (const control of securityControls) {
      assert.notEqual(assessControl(profile, control, '2.1.317').status, 'enforced');
    }
  }
  assert.deepEqual(conversationSecurityProfiles.claude.launchArguments.slice(5, 7), [
    '--tools',
    '',
  ]);
  assert.ok(conversationSecurityProfiles.codex.launchArguments.includes('read-only'));
  assert.ok(!conversationSecurityProfiles.claude.launchArguments.includes('acceptEdits'));
});

for (const runtime of ['claude', 'codex'] as const) {
  test(`${runtime}: prepares the conversation invocation with and without a model`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const { installation, scratch } = await setup(directory, runtime, []);
      const turnId = randomUUID();
      const base = { turnId, prompt: 'Hello', scratchDirectory: scratch };
      const plain = prepareConversationTurn(installation, { ...base, modelId: null });
      const withModel = prepareConversationTurn(installation, { ...base, modelId: 'model-x' });
      assert.ok(plain.ok && withModel.ok);
      const profile = conversationSecurityProfiles[runtime];
      assert.deepEqual(
        plain.plan.args.slice(0, profile.launchArguments.length),
        profile.launchArguments,
      );
      assert.ok(!plain.plan.args.includes('--model'));
      const index = withModel.plan.args.indexOf('--model');
      assert.equal(withModel.plan.args[index + 1], 'model-x');
      assert.equal(plain.plan.cwd, scratch);
      if (runtime === 'codex') assert.equal(withModel.plan.args.at(-1), '-');
      const invalid = prepareConversationTurn(installation, { ...base, modelId: '--evil' });
      assert.equal(invalid.ok ? 'ok' : invalid.code, 'model_invalid');
    });
  });

  test(`${runtime}: refuses a CLI that lacks the conversation profile options`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const { installation, scratch } = await setup(directory, runtime, []);
      const preparation = prepareConversationTurn(
        { ...installation, detectedOptions: ['--model'] },
        { turnId: randomUUID(), prompt: 'Hi', modelId: null, scratchDirectory: scratch },
      );
      assert.equal(preparation.ok ? 'ok' : preparation.code, 'conversation_profile_unsupported');
    });
  });

  test(`${runtime}: runs an authorized turn in the scratch directory`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const { fake, installation, scratch } = await setup(directory, runtime, replySteps[runtime]);
      const turnId = randomUUID();
      const prompt = '<new_message>Plan the feature</new_message>';
      const authorization = issue(installation, turnId, prompt, scratch, 'model-x');
      const { events, emit } = collectEvents();
      const started = await startConversationTurn({
        installation,
        request: { turnId, prompt, modelId: 'model-x', scratchDirectory: scratch },
        authorization,
        emit,
        limits: { stopGraceMs: 200 },
      });
      assert.ok(started.started, started.started ? '' : started.message);
      if (!started.started) return;
      const result = await started.handle.completed;
      assert.equal(result.status, 'completed');
      assert.equal(result.securityMode, 'trusted_local');
      const invocation = fake.invocation();
      assert.equal(invocation.cwd, scratch);
      assert.equal(invocation.stdin, prompt);
      assert.deepEqual(invocation.args, [...authorization.invocation.arguments]);
      const texts = events.flatMap((event) => (event.type === 'message' ? [event.text] : []));
      assert.equal(texts.length, 1);
      assert.match(texts[0] ?? '', /three/);
      if (runtime === 'claude') assert.equal(result.reportedModelId, 'claude-sonnet-5-5');
      // The authorization is single use.
      const again = await startConversationTurn({
        installation,
        request: { turnId, prompt, modelId: 'model-x', scratchDirectory: scratch },
        authorization,
        emit,
      });
      assert.equal(again.started ? 'started' : again.code, 'authorization_mismatch');
    });
  });
}

test('an unregistered or altered conversation authorization is refused', async () => {
  await withTemporaryDirectory(async (directory) => {
    const { fake, installation, scratch } = await setup(directory, 'claude', replySteps.claude);
    const turnId = randomUUID();
    const prompt = 'Hi';
    const request = { turnId, prompt, modelId: null, scratchDirectory: scratch };
    const issued = issue(installation, turnId, prompt, scratch);
    const forged = { ...issued, authorizationId: randomUUID() };
    const result = await startConversationTurn({
      installation,
      request,
      authorization: forged,
      emit: () => {},
    });
    assert.equal(result.started ? 'started' : result.code, 'authorization_mismatch');
    const otherPrompt = await startConversationTurn({
      installation,
      request: { ...request, prompt: 'Something else' },
      authorization: issued,
      emit: () => {},
    });
    assert.equal(otherPrompt.started ? 'started' : otherPrompt.code, 'authorization_mismatch');
    assert.throws(() => fake.invocation(), /ENOENT/);
  });
});

test('execution and conversation authorizations are not interchangeable', async () => {
  await withTemporaryDirectory(async (directory) => {
    const { installation, scratch } = await setup(directory, 'claude', replySteps.claude);
    const turnId = randomUUID();
    const conversation = issue(installation, turnId, 'Hi', scratch);
    const execution = authorizationFor(getAgentAdapter('claude'), installation, scratch);

    const asExecution = await startAgentExecution({
      adapter: getAgentAdapter('claude'),
      installation,
      request: { runId: turnId, prompt: 'Hi', modelId: null, workingDirectory: scratch },
      securityMode: 'trusted_local',
      // Deliberately the wrong kind: the launch boundary must refuse it.
      authorization: conversation as never,
      emit: () => {},
    });
    assert.equal(asExecution.started ? 'started' : asExecution.code, 'authorization_mismatch');

    const asConversation = await startConversationTurn({
      installation,
      request: { turnId, prompt: 'Hi', modelId: null, scratchDirectory: scratch },
      authorization: execution as never,
      emit: () => {},
    });
    assert.equal(
      asConversation.started ? 'started' : asConversation.code,
      'authorization_mismatch',
    );
  });
});

test('Claude authentication failure output is a failed turn, never a reply', async () => {
  // Shapes observed from Claude Code 2.1.317 without a login (2026-11-07).
  const steps: FakeStep[] = [
    { stdout: JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }) },
    {
      stdout: JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
        error: 'authentication_failed',
      }),
    },
    {
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
      }),
    },
    { exit: 1 },
  ];
  await withTemporaryDirectory(async (directory) => {
    const { installation, scratch } = await setup(directory, 'claude', steps);
    const turnId = randomUUID();
    const authorization = issue(installation, turnId, 'Hi', scratch);
    const started = await startConversationTurn({
      installation,
      request: { turnId, prompt: 'Hi', modelId: null, scratchDirectory: scratch },
      authorization,
      emit: () => {},
    });
    assert.ok(started.started);
    if (!started.started) return;
    const result = await started.handle.completed;
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.match(result.message, /Not logged in/);
  });
});
