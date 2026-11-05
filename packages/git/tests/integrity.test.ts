import assert from 'node:assert/strict';
import { chmodSync, existsSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  captureGitIntegritySnapshot,
  compareGitIntegritySnapshots,
  createTaskWorktree,
  digestGitIntegritySnapshot,
  GitInputError,
  gitIntegritySections,
  verifyGitIntegrity,
  type CaptureGitIntegrityOptions,
  type GitIntegrityComparison,
  type GitIntegrityFindingCode,
  type GitIntegritySnapshot,
} from '../src/index.js';
import { createRepository, git, snapshot, withFixtures, writeFile } from './fixtures.js';

/** Repository with a local bare `origin`, a fetched `origin/main`, and a task worktree. */
const setUp = async (directory: string) => {
  const origin = join(directory, 'origin.git');
  git(directory, 'init', '--quiet', '--bare', origin);
  const root = createRepository(join(directory, 'my project'));
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '--quiet', 'origin', 'main');
  const worktree = await createTaskWorktree({
    repositoryPath: root,
    baseBranch: 'main',
    taskId: 'task-1',
    worktreeRoot: join(directory, 'worktree root'),
  });
  const target: CaptureGitIntegrityOptions = {
    repositoryPath: root,
    worktreePath: worktree.path,
    branchName: worktree.branch,
    baseCommit: worktree.baseCommit,
  };
  return { root, origin, worktree, target };
};

const codes = (comparison: GitIntegrityComparison): GitIntegrityFindingCode[] =>
  [...new Set(comparison.findings.map((finding) => finding.code))].sort();

const subjects = (comparison: GitIntegrityComparison, code: GitIntegrityFindingCode): string[] =>
  comparison.findings.filter((finding) => finding.code === code).map((finding) => finding.subject);

/** Captures a baseline, applies `mutate`, and compares through `verifyGitIntegrity`. */
const runScenario = async (
  target: CaptureGitIntegrityOptions,
  mutate: () => unknown,
): Promise<{ baseline: GitIntegritySnapshot; comparison: GitIntegrityComparison }> => {
  const baseline = await captureGitIntegritySnapshot(target);
  await mutate();
  const { comparison } = await verifyGitIntegrity(baseline);
  return { baseline, comparison };
};

const commit = (cwd: string, file: string, message: string): void => {
  writeFile(join(cwd, file), `${message}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '--quiet', '-m', message);
};

test('a clean baseline compares clean, with every section observed', async () => {
  await withFixtures(async (directory) => {
    const { target } = await setUp(directory);
    const before = await captureGitIntegritySnapshot(target);
    const after = await captureGitIntegritySnapshot(target);

    for (const section of [
      before.repository,
      before.taskWorktree,
      before.worktrees,
      before.refs,
      before.config,
      before.metadataFiles,
      before.hooks,
      before.mainCheckoutStatus,
    ]) {
      assert.equal(section.status, 'observed');
    }
    const comparison = compareGitIntegritySnapshots(before, after);
    assert.equal(comparison.status, 'clean');
    assert.deepEqual(comparison.findings, []);
    assert.deepEqual(comparison.publication, { decision: 'proceed_to_review' });
    assert.equal(comparison.coverage, 'observable_before_after_state');
    assert.equal(comparison.beforeDigest, comparison.afterDigest);
  });
});

test('normal tracked, untracked, staged, and ignored edits in the task worktree are not findings', async () => {
  await withFixtures(async (directory) => {
    const { worktree, target } = await setUp(directory);
    const { comparison } = await runScenario(target, () => {
      writeFile(join(worktree.path, 'README.md'), 'changed\n');
      writeFile(join(worktree.path, 'src', 'deep', 'new file.ts'), 'export {};\n');
      writeFile(join(worktree.path, '.gitignore'), 'build/\n');
      writeFile(join(worktree.path, 'build', 'out.js'), 'ignored\n');
      git(worktree.path, 'add', 'src');
      writeFile(join(worktree.path, 'staged.txt'), 'staged\n');
      git(worktree.path, 'add', 'staged.txt');
    });
    assert.equal(comparison.status, 'clean');
    assert.deepEqual(comparison.findings, []);

    const { comparison: deletion } = await runScenario(target, () => {
      unlinkSync(join(worktree.path, 'README.md'));
    });
    assert.equal(deletion.status, 'clean');
  });
});

test('detects an agent commit in the task worktree as task branch movement', async () => {
  await withFixtures(async (directory) => {
    const { worktree, target } = await setUp(directory);
    const { comparison } = await runScenario(target, () =>
      commit(worktree.path, 'agent.txt', 'agent commit'),
    );
    assert.equal(comparison.status, 'violation');
    assert.deepEqual(codes(comparison), ['task_branch_moved']);
    const [finding] = comparison.findings;
    assert.equal(finding?.subject, `refs/heads/${worktree.branch}`);
    assert.equal(finding?.before, worktree.baseCommit);
    assert.equal(finding?.after, git(worktree.path, 'rev-parse', 'HEAD').trim());
    assert.deepEqual(comparison.publication, {
      decision: 'blocked',
      reason: 'integrity_violation',
    });
  });
});

test('detects a push to a local bare remote through its remote-tracking ref', async () => {
  await withFixtures(async (directory) => {
    const { worktree, target } = await setUp(directory);
    const { comparison } = await runScenario(target, () => {
      commit(worktree.path, 'agent.txt', 'agent commit');
      git(worktree.path, 'push', '--quiet', 'origin', worktree.branch);
    });
    assert.equal(comparison.status, 'violation');
    assert.deepEqual(codes(comparison), ['ref_created', 'task_branch_moved']);
    const created = comparison.findings.find((finding) => finding.code === 'ref_created');
    assert.equal(created?.subject, `refs/remotes/origin/${worktree.branch}`);
    assert.equal(created?.refCategory, 'remote_tracking');
  });
});

test('detects branch, tag, and other ref movement', async () => {
  await withFixtures(async (directory) => {
    const { root, worktree, target } = await setUp(directory);
    git(root, 'branch', 'feature');
    const { comparison } = await runScenario(target, () => {
      git(worktree.path, 'branch', 'side');
      git(worktree.path, 'tag', 'v1');
      commit(worktree.path, 'x.txt', 'x');
      git(worktree.path, 'update-ref', 'refs/heads/feature', 'HEAD');
      git(worktree.path, 'update-ref', 'refs/notes/custom', 'HEAD');
      git(worktree.path, 'reset', '--quiet', '--hard', worktree.baseCommit);
    });
    assert.equal(comparison.status, 'violation');
    assert.deepEqual(subjects(comparison, 'ref_created'), [
      'refs/heads/side',
      'refs/notes/custom',
      'refs/tags/v1',
    ]);
    assert.deepEqual(subjects(comparison, 'ref_moved'), ['refs/heads/feature']);
    // The task branch was reset back to its base: that particular movement is not observable.
    assert.deepEqual(subjects(comparison, 'task_branch_moved'), []);
    const tag = comparison.findings.find((finding) => finding.subject === 'refs/tags/v1');
    assert.equal(tag?.refCategory, 'tag');
  });
});

test('detects main checkout HEAD, branch, and working tree changes', async () => {
  await withFixtures(async (directory) => {
    const { root, target } = await setUp(directory);
    const commitOnMain = await runScenario(target, () => commit(root, 'main.txt', 'main commit'));
    assert.deepEqual(codes(commitOnMain.comparison), ['main_checkout_head_changed', 'ref_moved']);
    assert.deepEqual(subjects(commitOnMain.comparison, 'main_checkout_head_changed'), [root]);

    const switchBranch = await runScenario(target, () => {
      git(root, 'switch', '--quiet', '-c', 'operator-branch');
    });
    assert.deepEqual(codes(switchBranch.comparison), ['main_checkout_head_changed', 'ref_created']);

    const dirty = await runScenario(target, () => writeFile(join(root, 'stray.txt'), 'x\n'));
    assert.deepEqual(codes(dirty.comparison), ['main_checkout_status_changed']);
  });
});

test('detects HEAD and branch changes in other worktrees', async () => {
  await withFixtures(async (directory) => {
    const { root, target } = await setUp(directory);
    const other = join(directory, 'other worktree');
    git(root, 'worktree', 'add', '--quiet', '-b', 'other', other);
    const moved = await runScenario(target, () => commit(other, 'o.txt', 'other commit'));
    assert.deepEqual(codes(moved.comparison), ['other_worktree_head_changed', 'ref_moved']);
    assert.ok(
      subjects(moved.comparison, 'other_worktree_head_changed')[0]?.endsWith('other worktree'),
    );

    const detached = await runScenario(target, () => git(other, 'switch', '--quiet', '--detach'));
    assert.deepEqual(codes(detached.comparison), ['other_worktree_head_changed']);
  });
});

test('detects task worktree HEAD detachment, branch switches, and lock removal', async () => {
  await withFixtures(async (directory) => {
    const { root, worktree, target } = await setUp(directory);
    const detached = await runScenario(target, () =>
      git(worktree.path, 'switch', '--quiet', '--detach'),
    );
    assert.ok(codes(detached.comparison).includes('task_head_changed'));
    assert.ok(codes(detached.comparison).includes('task_worktree_changed'));
    git(worktree.path, 'switch', '--quiet', worktree.branch);

    const unlocked = await runScenario(target, () =>
      git(root, 'worktree', 'unlock', worktree.path),
    );
    assert.deepEqual(codes(unlocked.comparison), [
      'task_worktree_changed',
      'worktree_registry_changed',
    ]);
  });
});

test('detects config changes without storing or reporting config values', async () => {
  await withFixtures(async (directory) => {
    const { worktree, target } = await setUp(directory);
    const secret = 'super-secret-token-4711';
    const { baseline, comparison } = await runScenario(target, () => {
      git(worktree.path, 'config', 'http.extraHeader', `Authorization: Bearer ${secret}`);
      git(worktree.path, 'config', `url.https://agent:${secret}@example.invalid/.insteadOf`, 'x:');
      git(worktree.path, 'config', 'user.name', 'Agent');
    });
    assert.equal(comparison.status, 'violation');
    assert.deepEqual(codes(comparison), ['config_changed', 'remote_config_changed']);
    assert.deepEqual(subjects(comparison, 'config_changed'), [
      'common_config:http.extraheader',
      'common_config:user.name',
    ]);
    assert.deepEqual(subjects(comparison, 'remote_config_changed'), [
      'common_config:url.https://***@example.invalid/.insteadof',
    ]);
    const { after } = await verifyGitIntegrity(baseline);
    for (const text of [JSON.stringify(comparison), JSON.stringify(after)]) {
      assert.ok(!text.includes(secret));
      assert.ok(!text.includes('Bearer'));
    }
  });
});

test('detects hook changes and hooksPath changes', async () => {
  await withFixtures(async (directory) => {
    const { root, worktree, target } = await setUp(directory);
    const hooks = join(root, '.git', 'hooks');
    const added = await runScenario(target, () => {
      writeFile(join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(hooks, 'pre-push'), 0o755);
    });
    assert.deepEqual(codes(added.comparison), ['hooks_changed']);
    assert.deepEqual(subjects(added.comparison, 'hooks_changed'), ['hooks/pre-push']);

    const madeExecutable = await runScenario(target, () =>
      chmodSync(join(hooks, 'pre-push'), 0o644),
    );
    assert.deepEqual(codes(madeExecutable.comparison), ['hooks_changed']);

    const replacedDirectory = await runScenario(target, () => {
      renameSync(hooks, join(root, '.git', 'hooks-old'));
      symlinkSync(join(directory, 'elsewhere'), hooks);
    });
    // The directory itself is reported, and every hook that is no longer visible through it.
    const replaced = subjects(replacedDirectory.comparison, 'hooks_changed');
    assert.ok(replaced.includes('hooks') && replaced.includes('hooks/pre-push'));
    assert.deepEqual(codes(replacedDirectory.comparison), ['hooks_changed']);
    unlinkSync(hooks);
    renameSync(join(root, '.git', 'hooks-old'), hooks);

    const hooksPath = await runScenario(target, () =>
      git(worktree.path, 'config', 'core.hooksPath', join(directory, 'agent hooks')),
    );
    assert.deepEqual(codes(hooksPath.comparison), ['hooks_path_changed']);
  });
});

test('detects remote configuration changes', async () => {
  await withFixtures(async (directory) => {
    const { root, target } = await setUp(directory);
    const added = await runScenario(target, () =>
      git(root, 'remote', 'add', 'exfil', join(directory, 'exfil.git')),
    );
    assert.deepEqual(codes(added.comparison), ['remote_config_changed']);

    const changed = await runScenario(target, () =>
      git(root, 'remote', 'set-url', '--push', 'origin', join(directory, 'other.git')),
    );
    assert.deepEqual(subjects(changed.comparison, 'remote_config_changed'), [
      'common_config:remote.origin.pushurl',
    ]);
  });
});

test('detects worktree additions, removals, and registry changes', async () => {
  await withFixtures(async (directory) => {
    const { root, target } = await setUp(directory);
    const other = join(directory, 'other worktree');
    const added = await runScenario(target, () =>
      git(root, 'worktree', 'add', '--quiet', '-b', 'other', other),
    );
    assert.deepEqual(codes(added.comparison), ['ref_created', 'worktree_added']);

    const locked = await runScenario(target, () => git(root, 'worktree', 'lock', other));
    assert.deepEqual(codes(locked.comparison), ['worktree_registry_changed']);
    git(root, 'worktree', 'unlock', other);

    const removed = await runScenario(target, () => git(root, 'worktree', 'remove', other));
    assert.deepEqual(codes(removed.comparison), ['worktree_removed']);
  });
});

test('detects a replaced repository and does not inspect the replacement', async () => {
  await withFixtures(async (directory) => {
    const { root, target } = await setUp(directory);
    const { comparison } = await runScenario(target, () => {
      renameSync(root, join(directory, 'moved away'));
      createRepository(root);
    });
    assert.equal(comparison.status, 'violation');
    assert.ok(codes(comparison).includes('repository_identity_changed'));
    // Every other section of the after snapshot was refused, not inspected.
    const incomplete = comparison.findings.filter((f) => f.code === 'inspection_incomplete');
    assert.equal(incomplete.length, 7);
    assert.ok(incomplete.every((finding) => finding.after === 'identity_mismatch'));
    assert.deepEqual(comparison.publication, {
      decision: 'blocked',
      reason: 'integrity_violation',
    });
  });
});

test('detects a repository path that resolves to a different repository', async () => {
  await withFixtures(async (directory) => {
    const { root, target } = await setUp(directory);
    const unrelated = createRepository(join(directory, 'unrelated'));
    const link = join(directory, 'project link');
    symlinkSync(root, link);
    const { comparison } = await runScenario({ ...target, repositoryPath: link }, () => {
      unlinkSync(link);
      symlinkSync(unrelated, link);
    });
    assert.equal(comparison.status, 'violation');
    assert.deepEqual(subjects(comparison, 'repository_identity_changed'), [
      'commonDir',
      'commonDirIdentity',
      'root',
      'rootIdentity',
    ]);
  });
});

test('a missing task worktree is reported, not treated as clean', async () => {
  await withFixtures(async (directory) => {
    const { root, worktree, target } = await setUp(directory);
    const { comparison } = await runScenario(target, () => {
      git(root, 'worktree', 'unlock', worktree.path);
      git(root, 'worktree', 'remove', worktree.path);
    });
    assert.equal(comparison.status, 'violation');
    assert.ok(codes(comparison).includes('task_worktree_changed'));
    assert.ok(codes(comparison).includes('worktree_removed'));
  });
});

test('malformed metadata yields an inconclusive result without throwing', async () => {
  await withFixtures(async (directory) => {
    const { root, target } = await setUp(directory);
    const brokenRef = await runScenario(target, () =>
      writeFile(join(root, '.git', 'refs', 'heads', 'broken'), 'not a sha\n'),
    );
    assert.equal(brokenRef.comparison.status, 'inconclusive');
    assert.deepEqual(codes(brokenRef.comparison), ['inspection_incomplete']);
    assert.equal(brokenRef.comparison.findings[0]?.after, 'malformed');
    assert.deepEqual(brokenRef.comparison.publication, {
      decision: 'blocked',
      reason: 'inspection_inconclusive',
    });
    rmSync(join(root, '.git', 'refs', 'heads', 'broken'));

    const brokenConfig = await runScenario(target, () =>
      writeFile(join(root, '.git', 'config'), '[core\n\tbare = = =\n'),
    );
    assert.notEqual(brokenConfig.comparison.status, 'clean');
    assert.ok(codes(brokenConfig.comparison).includes('inspection_incomplete'));
  });
});

test('limits and the deadline fail sections explicitly instead of truncating them', async () => {
  await withFixtures(async (directory) => {
    const { root, target } = await setUp(directory);
    writeFile(join(root, '.git', 'hooks', 'big-hook'), 'x'.repeat(4096));
    const limited = await captureGitIntegritySnapshot({
      ...target,
      limits: { maxRefs: 1, maxHookEntries: 1, maxMetadataFileBytes: 2048, maxWorktrees: 1 },
    });
    assert.equal(limited.refs.status, 'failed');
    assert.equal(limited.hooks.status, 'failed');
    assert.equal(limited.worktrees.status, 'failed');
    for (const section of [limited.refs, limited.hooks, limited.worktrees]) {
      assert.ok(section.status === 'failed' && section.failure.reason === 'limit_exceeded');
    }
    const comparison = compareGitIntegritySnapshots(limited, limited);
    assert.equal(comparison.status, 'inconclusive');

    const rushed = await captureGitIntegritySnapshot({ ...target, limits: { maxDurationMs: 1 } });
    // Commands get at most the remaining time, so a section fails by deadline or by timeout.
    const reasons = gitIntegritySections.map((section) => {
      const observation = rushed[section];
      return observation.status === 'failed' ? observation.failure.reason : 'observed';
    });
    assert.ok(reasons.some((reason) => reason === 'deadline_exceeded' || reason === 'timeout'));
    assert.equal(compareGitIntegritySnapshots(rushed, rushed).status, 'inconclusive');
  });
});

test('invalid, mismatched, and unverified snapshots are inconclusive', async () => {
  await withFixtures(async (directory) => {
    const { root, worktree, target } = await setUp(directory);
    const baseline = await captureGitIntegritySnapshot(target);

    const invalid = compareGitIntegritySnapshots(
      JSON.parse('{"version":1}') as GitIntegritySnapshot,
      baseline,
    );
    assert.equal(invalid.status, 'inconclusive');
    assert.deepEqual(codes(invalid), ['snapshot_invalid']);
    assert.equal(invalid.beforeDigest, null);

    const otherTarget = await captureGitIntegritySnapshot({ ...target, branchName: 'main' });
    assert.deepEqual(codes(compareGitIntegritySnapshots(baseline, otherTarget)), [
      'snapshot_mismatch',
    ]);
    // Reversed order (after captured before the baseline) is refused as well.
    const later = await captureGitIntegritySnapshot(target);
    assert.deepEqual(codes(compareGitIntegritySnapshots(later, baseline)), ['snapshot_mismatch']);

    // A baseline of a worktree that is not verified cannot vouch for anything.
    git(root, 'worktree', 'unlock', worktree.path);
    const unverified = await captureGitIntegritySnapshot(target);
    const result = compareGitIntegritySnapshots(unverified, unverified);
    assert.equal(result.status, 'inconclusive');
    assert.deepEqual(codes(result), ['baseline_not_verified']);

    const missingBase = await captureGitIntegritySnapshot({
      ...target,
      baseCommit: 'a'.repeat(40),
    });
    assert.deepEqual(codes(compareGitIntegritySnapshots(missingBase, missingBase)), [
      'baseline_not_verified',
    ]);
  });
});

test('comparison is deterministic and independent of order and capture time', async () => {
  await withFixtures(async (directory) => {
    const { worktree, target } = await setUp(directory);
    const before = await captureGitIntegritySnapshot(target);
    git(worktree.path, 'branch', 'b1');
    git(worktree.path, 'branch', 'b2');
    const after = await captureGitIntegritySnapshot(target);

    const roundTripped = JSON.parse(JSON.stringify(after)) as GitIntegritySnapshot;
    assert.equal(digestGitIntegritySnapshot(roundTripped), digestGitIntegritySnapshot(after));
    const shuffled: GitIntegritySnapshot = {
      ...roundTripped,
      capturedAt: new Date(Date.now() + 1000).toISOString(),
      refs:
        roundTripped.refs.status === 'observed'
          ? { status: 'observed', value: [...roundTripped.refs.value].reverse() }
          : roundTripped.refs,
    };
    assert.equal(digestGitIntegritySnapshot(shuffled), digestGitIntegritySnapshot(after));
    const first = compareGitIntegritySnapshots(before, after);
    assert.deepEqual(compareGitIntegritySnapshots(before, shuffled), first);
    assert.deepEqual(compareGitIntegritySnapshots(before, after), first);
    assert.deepEqual(subjects(first, 'ref_created'), ['refs/heads/b1', 'refs/heads/b2']);
  });
});

test('inspection writes nothing and runs no repository-defined commands', async () => {
  await withFixtures(async (directory) => {
    const { root, worktree, target } = await setUp(directory);
    writeFile(join(root, '.gitattributes'), '*.txt filter=probe\n');
    commit(root, 'data.txt', 'filtered');
    const marker = join(directory, 'command ran');
    git(root, 'config', 'core.fsmonitor', `touch '${marker}'; false`);
    git(root, 'config', 'filter.probe.clean', `touch '${marker}'; cat`);
    for (const hook of ['post-index-change', 'reference-transaction', 'post-checkout']) {
      writeFile(join(root, '.git', 'hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(join(root, '.git', 'hooks', hook), 0o755);
    }
    writeFile(join(worktree.path, 'untracked.txt'), 'x\n');

    const before = snapshot(directory);
    const baseline = await captureGitIntegritySnapshot(target);
    await verifyGitIntegrity(baseline);
    assert.deepEqual(snapshot(directory), before);
    assert.equal(existsSync(marker), false);
  });
});

test('transient mutations and pushes that leave no local trace are not detectable', async () => {
  await withFixtures(async (directory) => {
    const { worktree, target } = await setUp(directory);
    const unrelatedRemote = join(directory, 'unconfigured.git');
    git(directory, 'init', '--quiet', '--bare', unrelatedRemote);
    const { comparison } = await runScenario(target, () => {
      // A commit that is reset away again, and a push by URL that updates no local ref.
      commit(worktree.path, 'transient.txt', 'transient');
      git(worktree.path, 'push', '--quiet', unrelatedRemote, 'HEAD:refs/heads/leaked');
      git(worktree.path, 'reset', '--quiet', '--hard', worktree.baseCommit);
    });
    // Documented limitation: a clean result does not prove that nothing happened.
    assert.equal(comparison.status, 'clean');
    assert.ok(git(unrelatedRemote, 'rev-parse', 'refs/heads/leaked').trim().length > 0);
  });
});

test('rejects invalid capture arguments before running Git', async () => {
  await withFixtures(async (directory) => {
    const { target } = await setUp(directory);
    await assert.rejects(
      captureGitIntegritySnapshot({ ...target, repositoryPath: 'relative' }),
      GitInputError,
    );
    await assert.rejects(
      captureGitIntegritySnapshot({ ...target, baseCommit: 'HEAD' }),
      GitInputError,
    );
    await assert.rejects(
      captureGitIntegritySnapshot({ ...target, branchName: '../escape' }),
      GitInputError,
    );
    await assert.rejects(
      captureGitIntegritySnapshot({ ...target, limits: { maxRefs: 0 } }),
      GitInputError,
    );
  });
});
