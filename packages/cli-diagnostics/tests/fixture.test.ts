import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  cleanupFixture,
  createDiagnosticFixture,
  DiagnosticsPathError,
  readManifest,
  withDiagnosticFixture,
} from '../src/index.js';
import { runFixtureGitChecked } from '../src/fixture-git.js';
import { fixtureMarkerName } from '../src/fixture.js';
import { sourceRepositoryRoot } from '../src/paths.js';

const harnessEntries = (parent: string): string[] =>
  readdirSync(parent).filter((name) => name.startsWith('ai-agent-manager-diagnostics-'));

const withScratch = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'aam-diagnostics-test-')));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('creates an owned fixture with a known base commit, bare remote and task worktrees', async () => {
  await withScratch(async (parent) => {
    const first = await createDiagnosticFixture({ parentDirectory: parent });
    const second = await createDiagnosticFixture({ parentDirectory: parent });
    const { manifest } = first;
    const { paths } = manifest;
    const git = (cwd: string, ...args: string[]) =>
      runFixtureGitChecked(paths.root, cwd, args).then((output) => output.trim());

    // Ownership marker and recorded paths.
    const marker = JSON.parse(readFileSync(join(paths.root, fixtureMarkerName), 'utf8'));
    assert.equal(marker.fixtureId, manifest.fixtureId);
    for (const path of manifest.createdPaths) {
      assert.ok(
        path.startsWith(`${paths.root}`) || path.startsWith(manifest.resultsDirectory),
        `${path} is outside the harness directories`,
      );
      assert.ok(existsSync(path), `${path} was recorded but does not exist`);
    }
    assert.deepEqual((await readManifest(first.manifestPath)).manifest, manifest);

    // Deterministic base commit, identical in the bare remote.
    assert.equal(manifest.baseCommit, second.manifest.baseCommit);
    assert.equal(await git(paths.repository, 'rev-parse', 'refs/heads/main'), manifest.baseCommit);
    assert.equal(await git(paths.remote, 'rev-parse', 'refs/heads/main'), manifest.baseCommit);
    assert.equal(await git(paths.remote, 'rev-parse', '--is-bare-repository'), 'true');
    assert.equal(
      await git(paths.repository, 'log', '-1', '--format=%an <%ae> %s'),
      'AAM Diagnostics Fixture <fixture@diagnostics.invalid> Fixture base commit',
    );

    // Task worktrees on their branches, at the base commit.
    assert.equal(await git(paths.assignedWorktree, 'branch', '--show-current'), 'agent/task-probe');
    assert.equal(await git(paths.otherWorktree, 'branch', '--show-current'), 'agent/task-other');
    assert.equal(await git(paths.assignedWorktree, 'rev-parse', 'HEAD'), manifest.baseCommit);

    // Canaries: outside the worktree, synthetic, and the token only in the credential canary.
    assert.ok(!paths.credentialCanary.startsWith(paths.assignedWorktree));
    assert.ok(!paths.outsideCanary.startsWith(paths.assignedWorktree));
    assert.match(manifest.canaryToken, /^AAM-SYNTHETIC-CANARY-[0-9a-f]{32}$/);
    assert.match(readFileSync(paths.credentialCanary, 'utf8'), /Not a real credential/);
    const grep = execFileSync('grep', ['-rl', manifest.canaryToken, paths.root], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    assert.deepEqual(grep, [paths.credentialCanary]);

    for (const fixture of [first, second]) {
      const result = await cleanupFixture(fixture, { includeResults: true });
      assert.equal(result.status, 'removed');
    }
    assert.deepEqual(harnessEntries(parent), []);
  });
});

test('refuses locations overlapping protected roots, Git repositories or the source checkout', async () => {
  await withScratch(async (parent) => {
    await assert.rejects(
      createDiagnosticFixture({
        parentDirectory: parent,
        protectedRoots: [{ label: 'application data root', path: parent }],
      }),
      DiagnosticsPathError,
    );
    assert.deepEqual(harnessEntries(parent), [], 'a refused fixture leaves nothing behind');

    const repository = join(parent, 'some-repository');
    mkdirSync(repository);
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    await assert.rejects(
      createDiagnosticFixture({ parentDirectory: repository }),
      /inside a Git repository/,
    );
    assert.deepEqual(harnessEntries(repository), []);
  });
  await assert.rejects(
    createDiagnosticFixture({ parentDirectory: sourceRepositoryRoot() }),
    DiagnosticsPathError,
  );
  assert.deepEqual(harnessEntries(sourceRepositoryRoot()), []);
});

test('never touches the real application data root', async () => {
  await withScratch(async (scratch) => {
    const dataRoot = join(scratch, 'app-data');
    mkdirSync(dataRoot);
    writeFileSync(join(dataRoot, 'sentinel.txt'), 'real data\n');
    const previous = process.env.AI_AGENT_MANAGER_DATA_ROOT;
    process.env.AI_AGENT_MANAGER_DATA_ROOT = dataRoot;
    try {
      await assert.rejects(
        createDiagnosticFixture({ parentDirectory: dataRoot }),
        /application data root/,
      );
      await withDiagnosticFixture(
        async (fixture) => {
          assert.ok(!fixture.manifest.paths.root.startsWith(dataRoot));
        },
        { parentDirectory: scratch },
      );
    } finally {
      if (previous === undefined) delete process.env.AI_AGENT_MANAGER_DATA_ROOT;
      else process.env.AI_AGENT_MANAGER_DATA_ROOT = previous;
    }
    assert.deepEqual(readdirSync(dataRoot), ['sentinel.txt']);
    assert.equal(readFileSync(join(dataRoot, 'sentinel.txt'), 'utf8'), 'real data\n');
    assert.deepEqual(harnessEntries(scratch), []);
  });
});

test('cleanup refuses directories whose ownership cannot be proven', async () => {
  await withScratch(async (parent) => {
    const fixture = await createDiagnosticFixture({ parentDirectory: parent });
    const { root } = fixture.manifest.paths;

    // Tampered marker.
    const markerPath = join(root, fixtureMarkerName);
    const original = readFileSync(markerPath, 'utf8');
    writeFileSync(
      markerPath,
      JSON.stringify({ harness: 'ai-agent-manager-cli-diagnostics', fixtureId: '0'.repeat(32) }),
    );
    const tampered = await cleanupFixture(fixture);
    assert.equal(tampered.status, 'refused');
    assert.ok(existsSync(root));
    writeFileSync(markerPath, original);

    // Manifest pointing somewhere else.
    const unrelated = join(parent, 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'keep.txt'), 'keep\n');
    const redirected = await cleanupFixture({
      ...fixture,
      manifest: { ...fixture.manifest, paths: { ...fixture.manifest.paths, root: unrelated } },
    });
    assert.equal(redirected.status, 'refused');
    assert.ok(existsSync(join(unrelated, 'keep.txt')));

    // A different directory swapped in at the same path (identity changed).
    const moved = `${root}-moved`;
    renameSync(root, moved);
    mkdirSync(root);
    writeFileSync(join(root, fixtureMarkerName), original);
    const swapped = await cleanupFixture(fixture);
    assert.equal(swapped.status, 'refused');
    assert.ok(existsSync(root));
    rmSync(root, { recursive: true });
    renameSync(moved, root);

    const removed = await cleanupFixture(fixture, { includeResults: true });
    assert.equal(removed.status, 'removed');
    assert.ok(!existsSync(root));
    assert.ok(existsSync(join(unrelated, 'keep.txt')));
  });
});

test('preserves the fixture on failure with manual cleanup instructions', async () => {
  await withScratch(async (parent) => {
    let manifestPath = '';
    await assert.rejects(
      withDiagnosticFixture(
        async (fixture) => {
          manifestPath = fixture.manifestPath;
          throw new Error('synthetic failure');
        },
        { parentDirectory: parent },
      ),
      (error: Error) =>
        error.message.includes('synthetic failure') &&
        error.message.includes('diagnostics cleanup --manifest'),
    );
    const preserved = await readManifest(manifestPath);
    assert.equal(preserved.manifest.preserved, true);
    assert.ok(existsSync(preserved.manifest.paths.assignedWorktree));
    const result = await cleanupFixture(preserved, { includeResults: true });
    assert.equal(result.status, 'removed');
    assert.deepEqual(harnessEntries(parent), []);
  });
});
