import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  listWorkingSourceTree,
  readWorkingSource,
  resolveWorkingSourceSnapshot,
  verifyWorkingSourceSnapshot,
} from '../src/source-context.js';
import { directoryIdentity, readWorkingTreeFile } from '../src/working-tree-reader.js';
import { createRepository, git, snapshot, withFixtures, writeFile } from './fixtures.js';

const prepare = async (directory: string) => {
  const root = createRepository(join(directory, 'project'));
  writeFile(join(root, 'src/main.ts'), 'export const version = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Source');
  const source = await resolveWorkingSourceSnapshot({
    localPath: root,
    gitCommonDir: join(root, '.git'),
  });
  const tree = await listWorkingSourceTree(source, { maxEntries: 100 });
  const entry = tree.files.find((file) => file.path === 'src/main.ts');
  assert.ok(entry);
  return { root, source, entry };
};

test('tracked current bytes distinguish HEAD matches, unstaged edits, staged edits and additions without Git writes', async () => {
  await withFixtures(async (directory) => {
    const { root, source, entry } = await prepare(directory);
    assert.equal((await readWorkingSource(source, entry, 1000)).state, 'matches_head');
    writeFileSync(join(root, entry.path), 'export const version = 2;\n');
    const before = snapshot(root);
    const result = await readWorkingSource(source, entry, 1000);
    assert.equal(result.state, 'modified');
    assert.equal(result.bytes.toString(), 'export const version = 2;\n');
    assert.equal(result.contentHash, createHash('sha256').update(result.bytes).digest('hex'));
    assert.deepEqual(snapshot(root), before);
    git(root, 'add', '.');
    const staged = (await listWorkingSourceTree(source, { maxEntries: 100 })).files.find(
      (file) => file.path === entry.path,
    );
    assert.ok(staged);
    assert.equal((await readWorkingSource(source, staged, 1000)).state, 'modified');
    writeFileSync(join(root, 'added.ts'), 'tracked addition\n');
    writeFileSync(join(root, 'untracked.ts'), 'excluded\n');
    git(root, 'add', 'added.ts');
    const tree = await listWorkingSourceTree(source, { maxEntries: 100 });
    assert.ok(!tree.files.some((file) => file.path === 'untracked.ts'));
    const added = tree.files.find((file) => file.path === 'added.ts');
    assert.ok(added);
    assert.equal((await readWorkingSource(source, added, 1000)).state, 'added');
  });
});

test('deletion, growth, changed index membership and root replacement fail conservatively', async () => {
  await withFixtures(async (directory) => {
    const { root, source, entry } = await prepare(directory);
    unlinkSync(join(root, entry.path));
    await assert.rejects(readWorkingSource(source, entry, 1000));
    writeFileSync(join(root, entry.path), 'x'.repeat(1001));
    await assert.rejects(readWorkingSource(source, entry, 1000));
    git(root, 'rm', '--cached', entry.path);
    await assert.rejects(readWorkingSource(source, entry, 1000));
    const original = join(directory, 'original');
    renameSync(root, original);
    createRepository(root);
    await assert.rejects(verifyWorkingSourceSnapshot(source));
    // The native boundary also checks root identity independently of the JS precheck.
    assert.ok(source.directories);
    await assert.rejects(readWorkingTreeFile(root, 'README.md', 1000, source.directories.root));
  });
});

test('final and ancestor symlink replacements after discovery never expose outside bytes', async () => {
  await withFixtures(async (directory) => {
    const { root, source, entry } = await prepare(directory);
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    writeFile(join(outside, 'main.ts'), 'OUTSIDE PRIVATE CONTENT\n');
    renameSync(join(root, entry.path), join(root, 'original.ts'));
    symlinkSync(join(outside, 'main.ts'), join(root, entry.path));
    await assert.rejects(readWorkingSource(source, entry, 1000));
    unlinkSync(join(root, entry.path));
    renameSync(join(root, 'src'), join(root, 'saved-src'));
    symlinkSync(outside, join(root, 'src'));
    await assert.rejects(readWorkingSource(source, entry, 1000));
    assert.ok(source.directories);
    for (const path of [
      '../outside/main.ts',
      '/etc/passwd',
      'src/../../outside/main.ts',
      '.git/config',
      '.GiT/config',
      '.g\u200dit/config',
      'src\\main.ts',
    ]) {
      await assert.rejects(readWorkingTreeFile(root, path, 1000, source.directories.root));
    }
  });
});

test('concurrent file replacement yields a coherent captured file or a refusal', async () => {
  await withFixtures(async (directory) => {
    const root = createRepository(join(directory, 'project'));
    const identity = await directoryIdentity(root);
    const first = Buffer.alloc(512 * 1024, 'a');
    const second = Buffer.alloc(512 * 1024, 'b');
    const target = join(root, 'changing.ts');
    writeFileSync(target, first);
    let counter = 0;
    const writer = setInterval(() => {
      const next = join(root, 'replacement.ts');
      writeFileSync(next, counter++ % 2 === 0 ? first : second);
      renameSync(next, target);
    }, 1);
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const result = await readWorkingTreeFile(root, 'changing.ts', first.length, identity);
          assert.ok(result.bytes.equals(first) || result.bytes.equals(second));
        } catch (error) {
          assert.match(String(error), /Source is missing, unsafe, oversized or changed/);
        }
      }
    } finally {
      clearInterval(writer);
    }
  });
});
