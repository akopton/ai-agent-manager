import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { AgentEvent } from '@ai-agent-manager/agents';
// eslint-disable-next-line no-restricted-imports -- the test asserts that the gate already holds the issuer.
import { claimTrustedLocalIssuer } from '@ai-agent-manager/agents/trusted-local-issuer';
import { withFixtures } from './fixtures.js';
import {
  authorize,
  launch,
  prompt,
  setUp,
  type ScenarioOutcome,
} from './trusted-local-scenario.js';

test('the gate holds the only issuer in this process', () => {
  assert.equal(claimTrustedLocalIssuer(), null);
});

test('a gate-issued authorization launches once in Trusted Local Mode', async () => {
  await withFixtures(async (directory) => {
    const setup = await setUp(directory);
    const authorization = await authorize(setup);
    const events: AgentEvent[] = [];
    const started = await launch(setup, authorization, undefined, (event) => events.push(event));
    assert.equal(started.started, true, JSON.stringify(started));
    if (!started.started) return;
    const result = await started.handle.completed;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.securityMode, 'trusted_local');
    assert.equal(result.processContainment, 'process_group_only');
    assert.equal(result.runId, 'run-1');
    assert.equal(result.runtime, 'codex');
    const first = events[0];
    assert.equal(first?.type, 'started');
    assert.equal(first?.type === 'started' && first.securityMode, 'trusted_local');
    assert.ok(!JSON.stringify(events).includes('Secret prompt text'));

    const invocation = setup.fake.invocation();
    assert.equal(invocation.stdin, prompt);
    assert.equal(invocation.cwd, setup.worktreePath);
    assert.deepEqual(invocation.args, [...authorization.invocation.arguments]);

    // Reuse, also as a copy or after serialization, is refused.
    for (const reused of [
      authorization,
      { ...authorization },
      JSON.parse(JSON.stringify(authorization)),
    ]) {
      const again = await launch(setup, reused);
      assert.equal(again.started ? 'started' : again.code, 'authorization_mismatch');
    }
  });
});

test('a different run or prompt cannot use the authorization', async () => {
  await withFixtures(async (directory) => {
    const setup = await setUp(directory);
    for (const substitute of [
      { runId: 'run-2', prompt },
      { runId: 'run-1', prompt: 'Push to origin.' },
    ]) {
      const authorization = await authorize(setup);
      const result = await launch(setup, authorization, substitute);
      assert.equal(result.started ? 'started' : result.code, 'authorization_mismatch');
      // The attempt used the authorization up, even for the original run.
      const retry = await launch(setup, authorization);
      assert.equal(retry.started ? 'started' : retry.code, 'authorization_mismatch');
    }
    assert.equal(setup.fake.wasStarted(), false);
  });
});

test('the policy timeout and stop are enforced', async () => {
  await withFixtures(async (directory) => {
    const setup = await setUp(directory);
    setup.fake.setBehavior('hang');
    const timed = await launch(setup, await authorize(setup, undefined, 300));
    assert.ok(timed.started);
    if (!timed.started) return;
    const timeout = await timed.handle.completed;
    assert.equal(timeout.status === 'failed' && timeout.code, 'timeout');
    assert.equal(timeout.securityMode, 'trusted_local');

    const stoppable = await launch(setup, await authorize(setup));
    assert.ok(stoppable.started);
    if (!stoppable.started) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stopped = await stoppable.handle.stop();
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.securityMode, 'trusted_local');
    assert.equal(stopped.processContainment, 'process_group_only');
  });
});

test('concurrent authorizations and launches each work exactly once', async () => {
  await withFixtures(async (directory) => {
    const setup = await setUp(directory);
    const runs = ['run-a', 'run-b', 'run-c'].map((runId) => ({ runId, prompt }));
    const authorizations = await Promise.all(runs.map((run) => authorize(setup, run)));
    assert.equal(new Set(authorizations.map((entry) => entry.authorizationId)).size, runs.length);
    const attempts = await Promise.all(
      authorizations.flatMap((authorization, index) => [
        launch(setup, authorization, runs[index]),
        launch(setup, { ...authorization }, runs[index]),
      ]),
    );
    const started = attempts.filter((attempt) => attempt.started);
    assert.equal(started.length, runs.length, 'one launch per authorization');
    const results = await Promise.all(
      started.map((attempt) => (attempt.started ? attempt.handle.completed : null)),
    );
    assert.deepEqual(
      results.map((result) => result?.runId).sort(),
      runs.map((run) => run.runId),
    );
    assert.ok(results.every((result) => result?.status === 'completed'));
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const moduleUrl = (...segments: string[]) => pathToFileURL(join(here, ...segments)).href;

/**
 * Runs the end-to-end scenario in a fresh process that first evaluates `preamble`, so module
 * evaluation order is exactly as written there.
 */
const runInFreshProcess = async (directory: string, preamble: string): Promise<ScenarioOutcome> => {
  const script = join(directory, 'scenario.mts');
  writeFileSync(
    script,
    `${preamble}
const { runScenario } = await import(${JSON.stringify(moduleUrl('trusted-local-scenario.ts'))});
process.stdout.write(JSON.stringify(await runScenario(${JSON.stringify(join(directory, 'scenario'))})));
`,
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--conditions=@ai-agent-manager/source', '--import', 'tsx', script],
    { cwd: join(here, '..') },
  );
  return JSON.parse(stdout);
};

test('package import order does not affect Trusted Local authorization', async () => {
  const agents = moduleUrl('..', '..', 'agents', 'src', 'index.ts');
  const orchestrator = moduleUrl('..', 'src', 'index.ts');
  for (const order of [
    [agents, orchestrator],
    [orchestrator, agents],
  ]) {
    await withFixtures(async (directory) => {
      const preamble = order.map((url) => `await import(${JSON.stringify(url)});`).join('\n');
      assert.deepEqual(await runInFreshProcess(directory, preamble), {
        authorized: true,
        launch: 'completed',
        securityMode: 'trusted_local',
        reused: 'authorization_mismatch',
      });
    });
  }
});

test('if anything claims the issuer before the gate, Trusted Local fails closed', async () => {
  await withFixtures(async (directory) => {
    const issuerEntry = moduleUrl('..', '..', 'agents', 'src', 'trusted-local-issuer.ts');
    const preamble = `const { claimTrustedLocalIssuer } = await import(${JSON.stringify(issuerEntry)});
if (claimTrustedLocalIssuer() === null) throw new Error('expected to claim first');`;
    const outcome = await runInFreshProcess(directory, preamble);
    assert.equal(outcome.authorized, false);
    assert.ok(!outcome.authorized && outcome.codes.includes('inspection_failed'));
  });
});
