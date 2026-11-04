import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  cleanupFixture,
  createDiagnosticFixture,
  DiagnosticsPathError,
  validateExplicitParent,
  type ProtectedRoot,
} from '../src/index.js';
import { defaultProtectedRoots, sourceRepositoryRoot } from '../src/paths.js';

const harnessEntries = (parent: string): string[] =>
  existsSync(parent)
    ? readdirSync(parent).filter((name) => name.startsWith('ai-agent-manager-diagnostics-'))
    : [];

const withScratch = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'aam-parent-test-')));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('creates and cleans up a fixture in a validated explicit parent', async () => {
  await withScratch(async (scratch) => {
    const parent = join(scratch, 'fixtures');
    mkdirSync(parent, { mode: 0o700 });
    writeFileSync(join(parent, 'unrelated.txt'), 'keep\n');
    const fixture = await createDiagnosticFixture({ parentDirectory: parent });
    assert.equal(fixture.manifest.parentDirectory, parent);
    assert.equal(dirname(fixture.manifest.paths.root), parent);
    assert.equal(dirname(fixture.manifest.resultsDirectory), parent);

    const result = await cleanupFixture(fixture, { includeResults: true });
    assert.equal(result.status, 'removed');
    assert.deepEqual(readdirSync(parent), ['unrelated.txt'], 'only harness directories removed');
  });
});

test('rejects unsafe explicit parents before creating anything', async () => {
  const protectedRoots = await defaultProtectedRoots();
  await withScratch(async (scratch) => {
    const real = join(scratch, 'real');
    mkdirSync(join(real, 'sub'), { recursive: true, mode: 0o700 });
    symlinkSync(real, join(scratch, 'alias'));
    writeFileSync(join(scratch, 'file.txt'), 'x');
    const shared = join(scratch, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o775);
    const repository = join(scratch, 'repository');
    mkdirSync(join(repository, 'nested'), { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: repository });

    const cases: Array<[string, RegExp]> = [
      ['relative/path', /absolute/],
      [`${real}/../real`, /not normalized/],
      [`${real}/`, /not normalized/],
      [join(scratch, 'missing'), /does not exist/],
      [join(scratch, 'file.txt'), /not a directory/],
      [join(scratch, 'alias'), /symbolic link/],
      [join(scratch, 'alias', 'sub'), /not canonical/],
      [shared, /writable by group or others/],
      [repository, /inside a Git repository/],
      [join(repository, 'nested'), /inside a Git repository/],
      [realpathSync(homedir()), /home directory/],
      [sourceRepositoryRoot(), /AI Agent Manager source repository|inside a Git repository/],
    ];
    for (const [path, message] of cases) {
      await assert.rejects(
        createDiagnosticFixture({ parentDirectory: path, protectedRoots }),
        (error: Error) => error instanceof DiagnosticsPathError && message.test(error.message),
        path,
      );
    }
    for (const directory of [scratch, real, join(real, 'sub'), shared, repository]) {
      assert.deepEqual(harnessEntries(directory), [], `${directory} must stay untouched`);
    }
  });
});

test('rejects a parent that is or is inside a protected application root', async () => {
  await withScratch(async (scratch) => {
    const dataRoot = join(scratch, 'app-data');
    mkdirSync(join(dataRoot, 'inner'), { recursive: true, mode: 0o700 });
    chmodSync(dataRoot, 0o700);
    const protectedRoots: ProtectedRoot[] = [{ label: 'application data root', path: dataRoot }];
    for (const parent of [dataRoot, join(dataRoot, 'inner')]) {
      await assert.rejects(
        validateExplicitParent(parent, protectedRoots),
        /overlaps the application data root/,
      );
    }
    // A sibling of the protected root is fine.
    const sibling = join(scratch, 'fixtures');
    mkdirSync(sibling, { mode: 0o700 });
    assert.equal(await validateExplicitParent(sibling, protectedRoots), sibling);
    assert.deepEqual(harnessEntries(dataRoot), []);
  });
});
