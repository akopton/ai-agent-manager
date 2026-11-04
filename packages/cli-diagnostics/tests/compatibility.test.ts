import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter, codexAdapter } from '@ai-agent-manager/agents';
import {
  createFakeCli,
  fakeCompatibility,
  runFakeCli,
  staticCompatibility,
  successSteps,
  verifyFakeCli,
  withDiagnosticFixture,
  type DiagnosticFixture,
} from '../src/index.js';
import { detectFake } from '../src/fake-runner.js';

const withScratchFixture = (run: (fixture: DiagnosticFixture) => Promise<void>) =>
  (async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'aam-diagnostics-test-')));
    try {
      await withDiagnosticFixture(run, { parentDirectory: parent, preserveOnFailure: false });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  })();

for (const adapter of [claudeAdapter, codexAdapter]) {
  test(`${adapter.runtime}: fake-CLI compatibility checks pass and are labeled fake_cli`, async () => {
    await withScratchFixture(async (fixture) => {
      const results = await fakeCompatibility(fixture, adapter);
      const fake = results.filter((entry) => entry.verification === 'fake_cli');
      assert.ok(fake.length >= 13);
      assert.deepEqual(
        fake
          .filter((entry) => entry.status !== 'passed')
          .map((entry) => `${entry.checkId}: ${entry.detail}`),
        [],
      );
      // Mocked compatibility is never reported as real.
      assert.ok(results.every((entry) => entry.verification !== 'real_supervised'));
      assert.ok(
        results
          .filter((entry) => entry.verification === 'not_verified')
          .every((entry) => entry.status === 'not_run'),
      );
      // The same-group child was terminated and recorded for cleanup.
      assert.equal(fixture.manifest.trackedProcesses.length, 1);
    });
  });
}

test('static compatibility reports a missing CLI and an unsupported version', async () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'aam-diagnostics-test-')));
  try {
    const missing = staticCompatibility(
      'claude',
      await claudeAdapter.detect({ searchPath: [empty] }),
    );
    const availability = missing.find((entry) => entry.checkId === 'cli_availability');
    assert.equal(availability?.status, 'failed');
    assert.equal(availability?.verification, 'static_inspection');
    assert.ok(
      missing
        .filter((entry) => entry.checkId !== 'cli_availability')
        .every((entry) => entry.status === 'not_run' && entry.verification === 'not_verified'),
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  await withScratchFixture(async (fixture) => {
    const old = await createFakeCli(fixture, 'codex', { version: 'codex-cli 0.1.0' });
    const results = staticCompatibility('codex', await detectFake(fixture, codexAdapter, old));
    const version = results.find((entry) => entry.checkId === 'version_support');
    assert.equal(version?.status, 'failed');
    assert.match(version?.detail ?? '', /version_unsupported/);
  });
});

test('handles malformed, incomplete, timed-out and cancelled runs', async () => {
  await withScratchFixture(async (fixture) => {
    const fake = await createFakeCli(fixture, 'claude');
    const run = (steps: Parameters<typeof runFakeCli>[0]['steps'], extra = {}) =>
      runFakeCli({ fixture, adapter: claudeAdapter, fake, steps, ...extra });

    const malformed = await run([{ stdout: '<<<garbage>>>' }, { exit: 0 }]);
    assert.ok(malformed.diagnosticCodes.includes('malformed_output'));
    assert.equal(
      malformed.outcome.status === 'failed' && malformed.outcome.code,
      'incomplete_output',
    );

    const truncated = await run([{ stdoutRaw: '{"type":"result","subtype":"succ' }]);
    assert.equal(
      truncated.outcome.status === 'failed' && truncated.outcome.code,
      'incomplete_output',
    );

    const crashed = await run([{ stderr: 'synthetic crash' }, { exit: 3 }]);
    assert.equal(crashed.outcome.status === 'failed' && crashed.outcome.code, 'non_zero_exit');

    const timedOut = await run([{ hang: true }], { timeoutMs: 200 });
    assert.equal(timedOut.outcome.status === 'failed' && timedOut.outcome.code, 'timeout');

    let polls = 0;
    const cancelled = await run([...successSteps('claude').slice(0, 1), { hang: true }], {
      stopWhen: async () => (polls += 1) > 3,
    });
    assert.equal(cancelled.outcome.status, 'stopped');
  });
});

test('the fake runner refuses executables that are not the verified fake CLI', async () => {
  await withScratchFixture(async (fixture) => {
    const fake = await createFakeCli(fixture, 'codex');
    await verifyFakeCli(fixture, fake);

    await assert.rejects(
      runFakeCli({
        fixture,
        adapter: codexAdapter,
        fake: { ...fake, executablePath: '/usr/bin/true' },
        steps: [],
      }),
      /not inside the fixture's fake-bin/,
    );

    writeFileSync(fake.executablePath, '#!/bin/sh\nexit 0\n');
    await assert.rejects(
      runFakeCli({ fixture, adapter: codexAdapter, fake, steps: [] }),
      /not the fake CLI generated by this harness/,
    );

    const elsewhere = join(fixture.manifest.paths.home, 'bin');
    mkdirSync(elsewhere);
    await assert.rejects(
      runFakeCli({
        fixture,
        adapter: codexAdapter,
        fake: { ...fake, executablePath: join(elsewhere, 'codex') },
        steps: [],
      }),
      /not inside the fixture's fake-bin/,
    );
  });
});
