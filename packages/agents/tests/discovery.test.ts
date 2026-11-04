import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter, codexAdapter, type CliDetection } from '../src/index.js';
import { parseHelpOptions } from '../src/discovery.js';
import { compareVersions, parseVersionOutput } from '../src/version.js';
import {
  claudeHelp,
  claudeVersionLine,
  codexExecHelp,
  codexVersionLine,
  createFakeCli,
  withTemporaryDirectory,
} from './fixtures.js';

const installationOf = (detection: CliDetection) => {
  assert.equal(detection.status, 'available', JSON.stringify(detection));
  if (detection.status !== 'available') throw new Error('unavailable');
  return detection.installation;
};

const unavailableReason = (detection: CliDetection): string =>
  detection.status === 'unavailable' ? detection.reason : 'available';

test('parses Claude and Codex version output', () => {
  assert.equal(
    parseVersionOutput('2.1.317 (Claude Code)\n', /^(\S+) \(Claude Code\)$/)?.version,
    '2.1.317',
  );
  assert.equal(parseVersionOutput('codex-cli 0.166.0', /^codex-cli (\S+)$/)?.version, '0.166.0');
  assert.equal(
    parseVersionOutput('codex-cli 0.167.0-alpha.2', /^codex-cli (\S+)$/)?.prerelease,
    'alpha.2',
  );
  for (const output of [
    '',
    'Claude Code',
    '2.1 (Claude Code)',
    'v2.1.317 (Claude Code)',
    '2.1.317',
  ]) {
    assert.equal(parseVersionOutput(output, /^(\S+) \(Claude Code\)$/), null, output);
  }
  const version = (text: string) => {
    const parsed = parseVersionOutput(text, /^(.+)$/);
    assert.ok(parsed);
    return parsed;
  };
  assert.equal(compareVersions(version('2.1.318'), version('2.1.317')), 1);
  assert.equal(compareVersions(version('2.10.0'), version('2.9.99')), 1);
  assert.equal(compareVersions(version('1.0.0-rc.1'), version('1.0.0')), -1);
  assert.equal(compareVersions(version('1.0.0'), version('1.0.0')), 0);
});

test('extracts long options from help output', () => {
  const options = parseHelpOptions(claudeHelp);
  assert.ok(
    options.has('--print') && options.has('--permission-prompts') && options.has('--model'),
  );
  assert.ok(!options.has('-p'));
});

test('discovers Claude Code on the search path and records its version and options', async () => {
  await withTemporaryDirectory(async (directory) => {
    const fake = createFakeCli(directory, 'claude', {
      version: claudeVersionLine,
      help: claudeHelp,
      steps: [],
    });
    const installation = installationOf(
      await claudeAdapter.detect({ searchPath: ['relative/ignored', directory] }),
    );
    assert.equal(installation.runtime, 'claude');
    assert.equal(installation.version, '2.1.317');
    assert.equal(installation.executablePath, fake.executablePath);
    assert.ok(installation.detectedOptions.includes('--model'));
    assert.ok(installation.detectedOptions.includes('--restricted'));
    assert.ok(Object.isFrozen(installation));

    const capabilities = claudeAdapter.capabilities(installation);
    assert.equal(capabilities.explicitModelSelection, true);
    assert.equal(capabilities.reportedModelMetadata, true);
    assert.equal(capabilities.conversationMode, 'not_implemented');
    assert.equal(capabilities.sessionResume.status, 'unverified');
  });
});

test('discovers Codex through an explicit path, including symlinks', async () => {
  await withTemporaryDirectory(async (directory) => {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const fake = createFakeCli(directory, 'codex', {
      version: codexVersionLine,
      help: codexExecHelp,
      steps: [],
    });
    symlinkSync(fake.executablePath, join(bin, 'codex'));
    const installation = installationOf(
      await codexAdapter.detect({ executablePath: join(bin, 'codex') }),
    );
    assert.equal(installation.version, '0.166.0');
    // The canonical target is recorded, so the launch spawns exactly the inspected file.
    assert.equal(installation.executablePath, fake.executablePath);
    const capabilities = codexAdapter.capabilities(installation);
    assert.equal(capabilities.explicitModelSelection, true);
    assert.equal(capabilities.reportedModelMetadata, false);
  });
});

test('reports a missing or unusable CLI as unavailable', async () => {
  await withTemporaryDirectory(async (directory) => {
    assert.equal(
      unavailableReason(await claudeAdapter.detect({ searchPath: [directory] })),
      'not_found',
    );
    assert.equal(
      unavailableReason(await claudeAdapter.detect({ executablePath: 'claude' })),
      'not_found',
    );
    const notExecutable = join(directory, 'claude');
    writeFileSync(notExecutable, '');
    chmodSync(notExecutable, 0o644);
    assert.equal(
      unavailableReason(await claudeAdapter.detect({ executablePath: notExecutable })),
      'not_executable',
    );
    assert.equal(
      unavailableReason(await claudeAdapter.detect({ executablePath: directory })),
      'not_executable',
    );
  });
});

test('rejects unrecognized, failing, and unassessed older versions', async () => {
  await withTemporaryDirectory(async (directory) => {
    const fake = createFakeCli(directory, 'claude', {
      version: 'Claude Code (dev build)',
      help: claudeHelp,
      steps: [],
    });
    const detect = () => claudeAdapter.detect({ executablePath: fake.executablePath });
    assert.equal(unavailableReason(await detect()), 'version_unrecognized');

    fake.setScenario({
      version: claudeVersionLine,
      versionExitCode: 3,
      help: claudeHelp,
      steps: [],
    });
    assert.equal(unavailableReason(await detect()), 'version_failed');

    fake.setScenario({ version: '2.0.5 (Claude Code)', help: claudeHelp, steps: [] });
    const old = await detect();
    assert.equal(unavailableReason(old), 'version_unsupported');
    assert.equal(old.status === 'unavailable' ? old.version : null, '2.0.5');

    fake.setScenario({ version: '2.2.0 (Claude Code)', help: claudeHelp, steps: [] });
    assert.equal(installationOf(await detect()).version, '2.2.0');
  });
});

test('rejects a CLI whose help lacks required options', async () => {
  await withTemporaryDirectory(async (directory) => {
    const fake = createFakeCli(directory, 'claude', {
      version: claudeVersionLine,
      help: claudeHelp.replace('--restricted', '--something-else'),
      steps: [],
    });
    const detection = await claudeAdapter.detect({ executablePath: fake.executablePath });
    assert.equal(unavailableReason(detection), 'options_missing');
    assert.match(detection.status === 'unavailable' ? detection.message : '', /--restricted/);

    fake.setScenario({ version: claudeVersionLine, help: claudeHelp, helpExitCode: 2, steps: [] });
    assert.equal(
      unavailableReason(await claudeAdapter.detect({ executablePath: fake.executablePath })),
      'help_failed',
    );
  });
});

test('reports explicit model selection as unsupported when --model is not listed', async () => {
  await withTemporaryDirectory(async (directory) => {
    const fake = createFakeCli(directory, 'codex', {
      version: codexVersionLine,
      help: codexExecHelp.replace('-m, --model <MODEL>', ''),
      steps: [],
    });
    const installation = installationOf(
      await codexAdapter.detect({ executablePath: fake.executablePath }),
    );
    assert.equal(codexAdapter.capabilities(installation).explicitModelSelection, false);
  });
});
