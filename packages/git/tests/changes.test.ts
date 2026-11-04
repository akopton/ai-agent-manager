import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createTaskWorktree,
  getTaskFileDiff,
  GitCommandError,
  GitInputError,
  inspectTaskChanges,
  TaskWorktreeError,
  type ChangedFile,
  type TaskChangesOptions,
} from '../src/index.js';
import { createRepository, git, snapshot, withFixtures, writeFile } from './fixtures.js';

const lines = (count: number, prefix = 'line'): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join('');

/** Repository with a committed base, plus a task worktree created from it. */
const setUp = async (directory: string) => {
  const root = createRepository(join(directory, 'main repo'));
  writeFile(join(root, 'src', 'app.ts'), lines(10));
  writeFile(join(root, 'remove me.txt'), lines(3));
  writeFile(join(root, 'image.bin'), 'PNG\0\x01\x02');
  writeFile(join(root, 'notes.md'), lines(5, 'note'));
  symlinkSync('src/app.ts', join(root, 'app-link'));
  writeFile(join(root, '.gitignore'), '.env\nbuild/\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Base');
  const worktree = await createTaskWorktree({
    repositoryPath: root,
    baseBranch: 'main',
    taskId: 'review',
    worktreeRoot: join(directory, 'worktrees'),
  });
  const target: TaskChangesOptions = {
    repositoryPath: root,
    worktreePath: worktree.path,
    branchName: worktree.branch,
    baseCommit: worktree.baseCommit,
  };
  return { root, path: worktree.path, target, baseCommit: worktree.baseCommit };
};

const fileAt = (files: ChangedFile[], path: string): ChangedFile => {
  const file = files.find((candidate) => candidate.path === path);
  assert.ok(file, `${path} is listed`);
  return file;
};

const rejectsWith = (code: TaskWorktreeError['code']) => (error: unknown) =>
  error instanceof TaskWorktreeError && error.code === code;

test('reports a clean worktree with a stable, repeatable revision', async () => {
  await withFixtures(async (directory) => {
    const { target, baseCommit, path } = await setUp(directory);
    const changes = await inspectTaskChanges(target);
    assert.deepEqual(changes.files, []);
    assert.equal(changes.totalFiles, 0);
    assert.equal(changes.headCommit, baseCommit);
    assert.equal(changes.baseIsAncestor, true);
    assert.equal(changes.consistency, 'stable');
    assert.equal(changes.worktreePath, path);
    assert.equal((await inspectTaskChanges(target)).revision, changes.revision);

    writeFile(join(path, 'notes.md'), lines(6, 'note'));
    assert.notEqual((await inspectTaskChanges(target)).revision, changes.revision);
  });
});

test('reports unstaged, staged, and staged-then-modified changes once per file', async () => {
  await withFixtures(async (directory) => {
    const { target, path } = await setUp(directory);
    writeFile(join(path, 'notes.md'), lines(5, 'note').replace('note 2', 'changed 2'));
    writeFile(join(path, 'src', 'app.ts'), `${lines(10)}line 11\n`);
    git(path, 'add', 'src/app.ts');
    writeFile(join(path, 'README.md'), 'staged\n');
    git(path, 'add', 'README.md');
    writeFile(join(path, 'README.md'), 'staged\nthen modified\n');

    const { files } = await inspectTaskChanges(target);
    assert.deepEqual(
      files.map((file) => file.path),
      ['README.md', 'notes.md', 'src/app.ts'],
    );
    assert.deepEqual(
      files.map(({ path: file, change, tracked, staged, unstaged, committed }) => ({
        file,
        change,
        tracked,
        staged,
        unstaged,
        committed,
      })),
      [
        {
          file: 'README.md',
          change: 'modified',
          tracked: true,
          staged: true,
          unstaged: true,
          committed: false,
        },
        {
          file: 'notes.md',
          change: 'modified',
          tracked: true,
          staged: false,
          unstaged: true,
          committed: false,
        },
        {
          file: 'src/app.ts',
          change: 'modified',
          tracked: true,
          staged: true,
          unstaged: false,
          committed: false,
        },
      ],
    );
    const readme = fileAt(files, 'README.md');
    assert.equal(readme.additions, 2);
    assert.equal(readme.deletions, 1);
    assert.equal(readme.binary, false);
    assert.equal(readme.size, 'staged\nthen modified\n'.length);

    const diff = await getTaskFileDiff({ ...target, path: 'README.md' });
    assert.equal(diff.omitted, null);
    assert.match(diff.patch ?? '', /^diff --git a\/README\.md b\/README\.md\n/);
    assert.match(diff.patch ?? '', /^-fixture$/m);
    assert.match(diff.patch ?? '', /^\+staged$/m);
    assert.match(diff.patch ?? '', /^\+then modified$/m);
    assert.equal(diff.consistency, 'stable');
  });
});

test('includes commits after the base and later modifications of the same file', async () => {
  await withFixtures(async (directory) => {
    const { target, path, baseCommit } = await setUp(directory);
    writeFile(join(path, 'notes.md'), `${lines(5, 'note')}committed\n`);
    writeFile(join(path, 'committed only.txt'), 'from a commit\n');
    git(path, 'add', '.');
    git(path, 'commit', '--quiet', '-m', 'Agent commit');
    writeFile(join(path, 'notes.md'), `${lines(5, 'note')}committed\nthen edited\n`);

    const changes = await inspectTaskChanges(target);
    assert.notEqual(changes.headCommit, baseCommit);
    assert.equal(changes.baseIsAncestor, true);
    const notes = fileAt(changes.files, 'notes.md');
    assert.equal(notes.committed, true);
    assert.equal(notes.unstaged, true);
    assert.equal(notes.additions, 2);
    const committedOnly = fileAt(changes.files, 'committed only.txt');
    assert.deepEqual(
      [committedOnly.change, committedOnly.committed, committedOnly.staged, committedOnly.unstaged],
      ['added', true, false, false],
    );

    const patch = (await getTaskFileDiff({ ...target, path: 'notes.md' })).patch ?? '';
    assert.match(patch, /^\+committed$/m);
    assert.match(patch, /^\+then edited$/m);

    // A branch reset behind the base is reported, not hidden.
    git(path, 'reset', '--quiet', '--hard', `${baseCommit}~1`);
    const rewound = await inspectTaskChanges(target);
    assert.equal(rewound.baseIsAncestor, false);
    assert.equal(fileAt(rewound.files, 'notes.md').change, 'deleted');
  });
});

test('reports untracked, empty, deleted, and renamed files', async () => {
  await withFixtures(async (directory) => {
    const { target, path, root } = await setUp(directory);
    writeFile(join(path, 'nested', 'deep', 'new file.ts'), 'export const x = 1;\n');
    writeFile(join(path, 'empty.txt'), '');
    rmSync(join(path, 'remove me.txt'));
    git(path, 'mv', 'src/app.ts', 'src/main.ts');
    writeFile(join(path, 'no newline.txt'), 'one\ntwo');

    const { files } = await inspectTaskChanges(target);
    const added = fileAt(files, 'nested/deep/new file.ts');
    assert.deepEqual(
      [added.change, added.tracked, added.binary, added.additions, added.deletions, added.size],
      ['added', false, false, 1, 0, 20],
    );
    assert.deepEqual(
      (await getTaskFileDiff({ ...target, path: 'nested/deep/new file.ts' })).patch,
      [
        'diff --git a/nested/deep/new file.ts b/nested/deep/new file.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/nested/deep/new file.ts',
        '@@ -0,0 +1 @@',
        '+export const x = 1;',
        '',
      ].join('\n'),
    );
    assert.equal(
      (await getTaskFileDiff({ ...target, path: 'no newline.txt' })).patch,
      [
        'diff --git a/no newline.txt b/no newline.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/no newline.txt',
        '@@ -0,0 +1,2 @@',
        '+one',
        '+two',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
    // Untracked files are never staged to produce their diff.
    assert.doesNotMatch(git(path, 'ls-files'), /new file|no newline/);

    const empty = fileAt(files, 'empty.txt');
    assert.deepEqual([empty.additions, empty.size, empty.binary], [0, 0, false]);
    assert.equal(
      (await getTaskFileDiff({ ...target, path: 'empty.txt' })).patch,
      'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n',
    );

    const deleted = fileAt(files, 'remove me.txt');
    assert.deepEqual(
      [deleted.change, deleted.existsInWorktree, deleted.deletions, deleted.size],
      ['deleted', false, 3, null],
    );
    assert.match(
      (await getTaskFileDiff({ ...target, path: 'remove me.txt' })).patch ?? '',
      /^deleted file mode 100644$/m,
    );

    const renamed = fileAt(files, 'src/main.ts');
    assert.deepEqual(
      [renamed.change, renamed.previousPath, renamed.similarity, renamed.staged],
      ['renamed', 'src/app.ts', 100, true],
    );
    assert.equal(files.filter((file) => file.path === 'src/app.ts').length, 0);
    for (const requested of ['src/main.ts', 'src/app.ts']) {
      const patch = (await getTaskFileDiff({ ...target, path: requested })).patch ?? '';
      assert.match(patch, /^rename from src\/app\.ts$/m);
      assert.match(patch, /^rename to src\/main\.ts$/m);
    }
    assert.equal(git(root, 'status', '--porcelain'), '');
  });
});

test('reports a file removed from the index but kept on disk once', async () => {
  await withFixtures(async (directory) => {
    const { target, path } = await setUp(directory);
    git(path, 'rm', '--quiet', '--cached', 'notes.md');
    const { files } = await inspectTaskChanges(target);
    assert.deepEqual(
      files.map((file) => [file.path, file.change, file.staged, file.existsInWorktree]),
      [['notes.md', 'deleted', true, true]],
    );
  });
});

test('identifies binary files by content, attributes, and Git, without diffing them', async () => {
  await withFixtures(async (directory) => {
    const { target, path } = await setUp(directory);
    writeFile(join(path, 'image.bin'), 'PNG\0\x03\x04 changed');
    writeFileSync(join(path, 'blob.dat'), Buffer.from([0, 1, 2, 3]));
    writeFile(join(path, '.gitattributes'), '*.txt -diff\n');
    writeFile(join(path, 'marked.txt'), 'plain text, but marked binary\n');

    const { files } = await inspectTaskChanges(target);
    for (const name of ['image.bin', 'blob.dat', 'marked.txt']) {
      const file = fileAt(files, name);
      assert.equal(file.binary, true, name);
      assert.equal(file.diffOmitted, 'binary', name);
      assert.equal(file.additions, null, name);
      const diff = await getTaskFileDiff({ ...target, path: name });
      assert.deepEqual([diff.patch, diff.omitted], [null, 'binary'], name);
    }
  });
});

test('enforces per-file, per-diff, file-count, read-budget, and output limits', async () => {
  await withFixtures(async (directory) => {
    const { target, path } = await setUp(directory);
    writeFile(join(path, 'huge untracked.txt'), 'x'.repeat(5000));
    writeFile(join(path, 'notes.md'), lines(600, 'note'));
    writeFile(join(path, 'medium.txt'), lines(40));
    const limits = { maxFileBytes: 4000, maxDiffBytes: 300 };

    const { files } = await inspectTaskChanges({ ...target, limits });
    const huge = fileAt(files, 'huge untracked.txt');
    assert.deepEqual([huge.diffOmitted, huge.binary, huge.size], ['too_large', null, 5000]);
    const notes = fileAt(files, 'notes.md');
    assert.deepEqual([notes.diffOmitted, notes.binary], ['too_large', null]);
    assert.equal(fileAt(files, 'medium.txt').diffOmitted, null);

    for (const [name, reason] of [
      ['huge untracked.txt', 'too_large'],
      ['notes.md', 'too_large'],
      ['medium.txt', 'diff_too_large'],
    ] as const) {
      const diff = await getTaskFileDiff({ ...target, path: name, limits });
      assert.deepEqual([diff.patch, diff.omitted], [null, reason], name);
    }

    const truncated = await inspectTaskChanges({ ...target, limits: { maxFiles: 2 } });
    assert.deepEqual([truncated.files.length, truncated.totalFiles], [2, 3]);
    assert.equal(truncated.filesTruncated, true);

    const budget = await inspectTaskChanges({ ...target, limits: { maxTotalReadBytes: 100 } });
    assert.equal(fileAt(budget.files, 'medium.txt').diffOmitted, 'read_budget_exhausted');
    assert.notEqual(
      (await getTaskFileDiff({ ...target, path: 'medium.txt', limits: { maxTotalReadBytes: 100 } }))
        .patch,
      null,
    );

    await assert.rejects(
      inspectTaskChanges({ ...target, maxOutputBytes: 64 }),
      (error: unknown) => error instanceof GitCommandError && error.code === 'GIT_OUTPUT_LIMIT',
    );
    await assert.rejects(inspectTaskChanges({ ...target, limits: { maxFiles: 0 } }), GitInputError);
  });
});

test('handles spaces, tabs, newlines, dashes, globs, and Unicode in file names', async () => {
  await withFixtures(async (directory) => {
    const { target, path, root } = await setUp(directory);
    const names = [
      'with space.txt',
      'tab\there.txt',
      'new\nline.txt',
      '-leading-dash.txt',
      ':(glob)*.txt',
      'zażółć 日本.txt',
      '"quoted"\\back.txt',
    ];
    for (const name of names) {
      writeFile(join(path, name), `${name}\n`);
    }
    // A tracked file with an unusual name, modified in the worktree.
    writeFile(join(root, '-tracked\tname.md'), 'before\n');
    git(root, 'add', '--', '-tracked\tname.md');
    git(root, 'commit', '--quiet', '-m', 'Unusual tracked name');
    git(path, 'merge', '--quiet', '--ff-only', 'main');
    writeFile(join(path, '-tracked\tname.md'), 'after\n');

    const changes = await inspectTaskChanges({ ...target, baseCommit: target.baseCommit });
    const listed = changes.files.map((file) => file.path);
    for (const name of [...names, '-tracked\tname.md']) {
      assert.ok(listed.includes(name), JSON.stringify(name));
      const diff = await getTaskFileDiff({ ...target, path: name });
      assert.notEqual(diff.patch, null, JSON.stringify(name));
    }
    const quoted = (await getTaskFileDiff({ ...target, path: 'new\nline.txt' })).patch ?? '';
    assert.match(quoted, /^diff --git "a\/new\\nline\.txt" "b\/new\\nline\.txt"$/m);
    const unicode = (await getTaskFileDiff({ ...target, path: 'zażółć 日本.txt' })).patch ?? '';
    assert.match(unicode, /^\+zażółć 日本\.txt$/m);
  });
});

test('represents symlinks by their target and never reads outside the worktree', async () => {
  await withFixtures(async (directory) => {
    const { target, path } = await setUp(directory);
    const secret = join(directory, 'outside secret.txt');
    writeFile(secret, 'TOP SECRET CONTENT\n');
    mkdirSync(join(directory, 'outside dir'));
    writeFile(join(directory, 'outside dir', 'inner.txt'), 'TOP SECRET CONTENT\n');
    symlinkSync(secret, join(path, 'absolute-link'));
    symlinkSync('../../../outside secret.txt', join(path, 'relative-link'));
    symlinkSync(join(directory, 'outside dir'), join(path, 'dir-link'));
    symlinkSync('notes.md', join(path, 'inside-link'));
    rmSync(join(path, 'app-link'));
    symlinkSync('notes.md', join(path, 'app-link'));

    const changes = await inspectTaskChanges(target);
    for (const name of ['absolute-link', 'relative-link', 'dir-link']) {
      const file = fileAt(changes.files, name);
      assert.deepEqual(
        [file.kind, file.symlinkEscapesWorktree, file.tracked],
        ['symlink', true, false],
      );
    }
    assert.equal(fileAt(changes.files, 'inside-link').symlinkEscapesWorktree, false);
    assert.equal(fileAt(changes.files, 'absolute-link').symlinkTarget, secret);

    const tracked = fileAt(changes.files, 'app-link');
    assert.deepEqual(
      [tracked.kind, tracked.change, tracked.symlinkTarget],
      ['symlink', 'modified', 'notes.md'],
    );
    const trackedPatch = (await getTaskFileDiff({ ...target, path: 'app-link' })).patch ?? '';
    assert.match(trackedPatch, /^-src\/app\.ts$/m);
    assert.match(trackedPatch, /^\+notes\.md$/m);

    const linkPatch = (await getTaskFileDiff({ ...target, path: 'absolute-link' })).patch ?? '';
    assert.match(linkPatch, /^new file mode 120000$/m);
    assert.match(
      linkPatch,
      new RegExp(`^\\+${secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
    );

    const everything = JSON.stringify([
      changes,
      ...(await Promise.all(
        changes.files.map((file) => getTaskFileDiff({ ...target, path: file.path })),
      )),
    ]);
    assert.doesNotMatch(everything, /TOP SECRET CONTENT/);
  });
});

test('rejects traversal and paths that are not changed files', async () => {
  await withFixtures(async (directory) => {
    const { target, path } = await setUp(directory);
    writeFile(join(path, 'nested', 'file.txt'), 'nested\n');
    for (const requested of [
      '',
      '../outside.txt',
      '/etc/passwd',
      'nested/../notes.md',
      './nested/file.txt',
      'nested//file.txt',
      'notes.md',
      '.env',
      'nested',
    ]) {
      await assert.rejects(
        getTaskFileDiff({ ...target, path: requested }),
        GitInputError,
        requested,
      );
    }
    assert.notEqual((await getTaskFileDiff({ ...target, path: 'nested/file.txt' })).patch, null);
  });
});

test('lists ignored paths without ever reading their content', async () => {
  await withFixtures(async (directory) => {
    const { target, path } = await setUp(directory);
    writeFile(join(path, '.env'), 'API_KEY=very-secret-value\n');
    writeFile(join(path, 'build', 'out.js'), 'console.log("build");\n');
    const changes = await inspectTaskChanges(target);
    assert.deepEqual(changes.files, []);
    assert.deepEqual(changes.ignoredPaths.sort(), ['.env', 'build/']);
    assert.doesNotMatch(JSON.stringify(changes), /very-secret-value/);
  });
});

test('validates the recorded base commit without substituting another', async () => {
  await withFixtures(async (directory) => {
    const { target, root } = await setUp(directory);
    for (const baseCommit of ['', 'abc123', 'HEAD', 'main', target.baseCommit.toUpperCase()]) {
      await assert.rejects(
        inspectTaskChanges({ ...target, baseCommit }),
        GitInputError,
        baseCommit,
      );
    }
    const tree = git(root, 'rev-parse', 'HEAD^{tree}').trim();
    for (const baseCommit of ['0'.repeat(40), 'f'.repeat(40), tree]) {
      await assert.rejects(
        inspectTaskChanges({ ...target, baseCommit }),
        rejectsWith('BASE_COMMIT_NOT_FOUND'),
        baseCommit,
      );
    }
  });
});

test('rejects unverified worktrees: wrong repository, branch, detached HEAD, missing lock', async () => {
  await withFixtures(async (directory) => {
    const { target, path, root } = await setUp(directory);
    const other = createRepository(join(directory, 'other'));
    await assert.rejects(
      inspectTaskChanges({ ...target, repositoryPath: other }),
      rejectsWith('NOT_VERIFIED'),
    );
    await assert.rejects(
      inspectTaskChanges({ ...target, branchName: 'agent/other' }),
      rejectsWith('NOT_VERIFIED'),
    );
    await assert.rejects(
      getTaskFileDiff({ ...target, worktreePath: root, branchName: 'main', path: 'README.md' }),
      rejectsWith('NOT_VERIFIED'),
    );

    git(path, 'checkout', '--quiet', '--detach');
    await assert.rejects(inspectTaskChanges(target), rejectsWith('NOT_VERIFIED'));
    git(path, 'checkout', '--quiet', target.branchName);

    git(root, 'worktree', 'unlock', path);
    await assert.rejects(inspectTaskChanges(target), rejectsWith('NOT_VERIFIED'));
  });
});

test('reports merge conflicts in the worktree', async () => {
  await withFixtures(async (directory) => {
    const { target, path, root } = await setUp(directory);
    writeFile(join(root, 'notes.md'), 'main side\n');
    git(root, 'commit', '--quiet', '-am', 'Main change');
    writeFile(join(path, 'notes.md'), 'task side\n');
    git(path, 'commit', '--quiet', '-am', 'Task change');
    assert.throws(() => git(path, 'merge', '--quiet', 'main'));

    const notes = fileAt((await inspectTaskChanges(target)).files, 'notes.md');
    assert.equal(notes.change, 'conflicted');
    const patch = (await getTaskFileDiff({ ...target, path: 'notes.md' })).patch ?? '';
    assert.match(patch, /^\+<<<<<<< HEAD$/m);
  });
});

test('ignores repository diff drivers, textconv, external diff, filters, and output config', async () => {
  await withFixtures(async (directory) => {
    const { target, path, root } = await setUp(directory);
    // Fixture Git runs unprotected, so all fixture commands happen before the hostile config.
    git(path, 'mv', 'src/app.ts', 'src/renamed.ts');
    const markers = join(directory, 'markers');
    mkdirSync(markers);
    const marker = (name: string) => `touch "${markers}/${name}"`;
    writeFile(join(path, '.gitattributes'), '*.md diff=probe filter=probe\n');
    for (const [key, value] of [
      ['diff.external', `${marker('external')}; true`],
      ['diff.probe.command', `${marker('command')}; true`],
      ['diff.probe.textconv', `${marker('textconv')}; cat`],
      ['filter.probe.clean', `${marker('clean')}; cat`],
      ['core.fsmonitor', `${marker('fsmonitor')}; false`],
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.relative', 'true'],
      ['diff.context', '0'],
      ['diff.renames', 'false'],
      ['color.ui', 'always'],
      ['color.diff', 'always'],
      ['core.quotePath', 'false'],
    ]) {
      git(root, 'config', key ?? '', value ?? '');
    }
    writeFile(join(path, 'notes.md'), lines(5, 'note').replace('note 3', 'changed 3'));
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(path, 'notes.md'), future, future);

    const changes = await inspectTaskChanges(target);
    assert.equal(fileAt(changes.files, 'src/renamed.ts').change, 'renamed');
    const patch = (await getTaskFileDiff({ ...target, path: 'notes.md' })).patch ?? '';
    assert.match(patch, /^diff --git a\/notes\.md b\/notes\.md$/m);
    assert.match(patch, /^@@ -1,5 \+1,5 @@$/m);
    assert.equal(patch.includes(String.fromCharCode(0x1b)), false, 'no ANSI color codes');
    assert.deepEqual(readdirSync(markers), [], 'no repository-configured program ran');

    // Control: plain Git in the same worktree does run the external diff driver.
    git(path, 'diff', target.baseCommit, '--', 'notes.md');
    assert.ok(readdirSync(markers).length > 0);
  });
});

test('never modifies repository files, the index, refs, or config', async () => {
  await withFixtures(async (directory) => {
    const { target, path, root } = await setUp(directory);
    writeFile(join(path, 'notes.md'), 'changed\n');
    writeFile(join(path, 'untracked.txt'), 'new\n');
    git(path, 'mv', 'src/app.ts', 'src/main.ts');
    // Stat-dirty but content-clean: a writing command would refresh the index.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(path, 'README.md'), future, future);

    const mainBefore = snapshot(root);
    const worktreeBefore = snapshot(path);
    const changes = await inspectTaskChanges(target);
    for (const file of changes.files) {
      await getTaskFileDiff({ ...target, path: file.path });
    }
    // The stat-dirty but content-clean file is not reported as a change.
    assert.deepEqual(
      changes.files.map((file) => file.path),
      ['notes.md', 'src/main.ts', 'untracked.txt'],
    );
    assert.deepEqual(snapshot(root), mainBefore);
    assert.deepEqual(snapshot(path), worktreeBefore);
  });
});

test('flags inspections that overlap with concurrent changes', async () => {
  await withFixtures(async (directory) => {
    const { target, path } = await setUp(directory);
    writeFile(join(path, 'busy.txt'), 'start\n');
    let counter = 0;
    const writer = setInterval(() => {
      counter += 1;
      writeFileSync(join(path, 'busy.txt'), `write ${counter}\n`);
    }, 2);
    try {
      const results = await Promise.all([
        inspectTaskChanges(target),
        inspectTaskChanges(target),
        inspectTaskChanges(target),
      ]);
      assert.ok(results.some((result) => result.consistency === 'changed_during_inspection'));
    } finally {
      clearInterval(writer);
    }
    const settled = await inspectTaskChanges(target);
    assert.equal(settled.consistency, 'stable');
  });
});
