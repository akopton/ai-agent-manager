import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import {
  getWorkingTreeStatus,
  GitCommandError,
  GitInputError,
  inspectRepository,
} from '../src/index.js';
import { runGitChecked, runProcess } from '../src/process.js';
import { createRepository, git, withFixtures, writeFile } from './fixtures.js';

/** Captures every file under `directory` with its size, mtime, and content hash input. */
const snapshot = (directory: string): Map<string, string> => {
  const entries = new Map<string, string>();
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      const stats = statSync(child);
      entries.set(
        relative(directory, child),
        `${stats.size}:${stats.mtimeMs}:${readFileSync(child).toString('base64')}`,
      );
    }
  };
  visit(directory);
  return entries;
};

test('inspection leaves the repository, index, refs, and config byte-for-byte unchanged', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    git(root, 'remote', 'add', 'origin', join(directory, 'origin.git'));
    writeFile(join(root, 'untracked.txt'), 'new\n');
    // Make a tracked file stat-dirty but content-clean: a writing `git status` would refresh the index.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'README.md'), future, future);

    const before = snapshot(root);
    const inspection = await inspectRepository(root);
    assert.ok(inspection.valid);
    assert.deepEqual(snapshot(root), before);
  });
});

test('status does not execute fsmonitor or filter commands from repository config', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    writeFile(join(root, '.gitattributes'), '*.txt filter=probe\n');
    writeFile(join(root, 'data.txt'), 'data\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'Filtered file');

    const fsmonitorMarker = join(directory, 'fsmonitor ran');
    const filterMarker = join(directory, 'filter ran');
    git(root, 'config', 'core.fsmonitor', `touch '${fsmonitorMarker}'; false`);
    git(root, 'config', 'filter.probe.clean', `touch '${filterMarker}'; cat`);
    git(root, 'config', 'filter.probe.required', 'true');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'data.txt'), future, future);

    const status = await getWorkingTreeStatus(root);
    assert.equal(status.isClean, true);
    assert.equal(existsSync(fsmonitorMarker), false);
    assert.equal(existsSync(filterMarker), false);

    // Control: an unprotected `git status` does run both commands in this fixture.
    git(root, 'status', '--porcelain');
    assert.equal(existsSync(fsmonitorMarker), true);
    assert.equal(existsSync(filterMarker), true);
  });
});

test('ignores inherited GIT_* variables that would redirect inspection', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    const other = createRepository(join(directory, 'other'));
    git(other, 'branch', 'only-in-other');
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, '.git');
    try {
      const inspection = await inspectRepository(root);
      assert.ok(inspection.valid);
      assert.deepEqual(
        inspection.branches.map((branch) => branch.name),
        ['main'],
      );
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previous;
      }
    }
  });
});

test('surfaces non-zero Git exits as typed errors with captured stderr', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'repo'));
    await assert.rejects(
      runGitChecked(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: root }),
      (error: unknown) =>
        error instanceof GitCommandError &&
        error.code === 'GIT_FAILED' &&
        error.exitCode === 128 &&
        error.stderr.includes('Needed a single revision'),
    );
    await assert.rejects(inspectRepository(root, { timeoutMs: 0 }), GitInputError);
  });
});

test('terminates commands that exceed the timeout or the output limit', async () => {
  const started = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 200,
      maxOutputBytes: 1024,
    }),
    (error: unknown) =>
      error instanceof GitCommandError &&
      error.code === 'GIT_TIMEOUT' &&
      error.signal === 'SIGTERM',
  );
  assert.ok(Date.now() - started < 5_000);

  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1_000_000))'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    }),
    (error: unknown) => error instanceof GitCommandError && error.code === 'GIT_OUTPUT_LIMIT',
  );

  await assert.rejects(
    runProcess('/nonexistent/git-binary', ['--version'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 1_000,
      maxOutputBytes: 1024,
    }),
    (error: unknown) => error instanceof GitCommandError && error.code === 'GIT_UNAVAILABLE',
  );
});
