import assert from 'node:assert/strict';
import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RegisterProjectRequest } from '@ai-agent-manager/core';
import type { DatabaseConnection } from '@ai-agent-manager/database';
import {
  getProjectDetails,
  listProjects,
  previewProject,
  ProjectServiceError,
  registerProject,
} from '@/lib/server/projects';
import {
  createFixtureDirectory,
  createMigratedDatabase,
  createRepository,
  git,
  removeFixtureDirectory,
  snapshot,
  writeFile,
} from './fixtures';

type Database = DatabaseConnection['db'];

const withFixtures = async (
  run: (context: { directory: string; db: Database }) => Promise<void>,
): Promise<void> => {
  const directory = createFixtureDirectory();
  const connection = createMigratedDatabase(directory);
  try {
    await run({ directory, db: connection.db });
  } finally {
    connection.close();
    removeFixtureDirectory(directory);
  }
};

const rejectsWith = async (
  promise: Promise<unknown>,
  code: string,
): Promise<ProjectServiceError> => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ProjectServiceError, `expected ProjectServiceError ${code}`);
  assert.equal(caught.code, code);
  assert.ok(caught.message.length > 0);
  return caught;
};

const request = (path: string, overrides: Partial<RegisterProjectRequest> = {}) => ({
  path,
  name: 'Fixture',
  defaultBaseBranch: 'main',
  remoteName: null,
  ...overrides,
});

test('previews a repository with canonical paths, branches, and redacted remotes', async () => {
  await withFixtures(async ({ directory, db }) => {
    const root = createRepository(join(directory, 'my repo'));
    git(root, 'branch', 'develop');
    git(root, 'checkout', '--quiet', 'develop');
    git(root, 'remote', 'add', 'upstream', 'https://user:secret@example.invalid/team/repo.git');
    git(root, 'remote', 'add', 'origin', '../origin.git');
    writeFile(join(root, 'notes.txt'), 'untracked\n');
    const link = join(directory, 'link to repo');
    symlinkSync(root, link);

    const preview = await previewProject(db, `${link}/`);
    assert.equal(preview.path, root);
    assert.equal(preview.gitCommonDir, join(root, '.git'));
    assert.equal(preview.suggestedName, 'my repo');
    assert.deepEqual(preview.branches, ['develop', 'main']);
    assert.equal(preview.suggestedBaseBranch, 'develop');
    assert.equal(preview.suggestedRemoteName, 'origin');
    assert.deepEqual(
      preview.remotes.find(({ name }) => name === 'upstream')?.fetchUrl,
      'https://***@example.invalid/team/repo.git',
    );
    assert.equal(preview.head.kind, 'branch');
    assert.deepEqual(preview.workingTree, {
      isClean: false,
      staged: 0,
      unstaged: 0,
      untracked: 1,
      conflicted: 0,
    });
    assert.equal(preview.existingProject, null);
    assert.deepEqual(listProjects(db), []);
  });
});

test('suggests main, then the first branch, and no remote when none exists', async () => {
  await withFixtures(async ({ directory, db }) => {
    const root = createRepository(join(directory, 'repo'));
    git(root, 'checkout', '--quiet', '--detach');
    assert.equal((await previewProject(db, root)).suggestedBaseBranch, 'main');
    assert.equal((await previewProject(db, root)).suggestedRemoteName, null);

    git(root, 'branch', '-m', 'main', 'trunk');
    assert.equal((await previewProject(db, root)).suggestedBaseBranch, 'trunk');
  });
});

test('rejects invalid paths and non-registrable repositories with actionable errors', async () => {
  await withFixtures(async ({ directory, db }) => {
    const root = createRepository(join(directory, 'repo'));
    const plain = join(directory, 'plain');
    mkdirSync(plain);
    const file = join(directory, 'file.txt');
    writeFile(file, 'x');
    const bare = join(directory, 'bare.git');
    git(directory, 'init', '--quiet', '--bare', bare);
    const empty = createRepository(join(directory, 'empty'), { empty: true });
    const linked = join(directory, 'linked');
    git(root, 'worktree', 'add', '--quiet', '-b', 'feature', linked);
    mkdirSync(join(root, 'src'));

    await rejectsWith(previewProject(db, 'relative/path'), 'invalid_path');
    await rejectsWith(previewProject(db, join(directory, 'missing')), 'path_not_found');
    await rejectsWith(previewProject(db, file), 'not_a_directory');
    await rejectsWith(previewProject(db, plain), 'not_git_repository');
    await rejectsWith(previewProject(db, bare), 'bare_repository');
    await rejectsWith(previewProject(db, join(root, '.git')), 'inside_git_directory');
    await rejectsWith(previewProject(db, linked), 'linked_worktree');
    await rejectsWith(previewProject(db, empty), 'no_local_branches');
    const nested = await rejectsWith(previewProject(db, join(root, 'src')), 'not_repository_root');
    assert.deepEqual(nested.details, { root });

    await rejectsWith(registerProject(db, request(plain)), 'not_git_repository');
    assert.deepEqual(listProjects(db), []);
  });
});

test('registers a repository without modifying it and stores canonical identity', async () => {
  await withFixtures(async ({ directory, db }) => {
    const root = createRepository(join(directory, 'repo'));
    git(root, 'remote', 'add', 'origin', '../origin.git');
    writeFile(join(root, 'dirty.txt'), 'untracked\n');
    const before = snapshot(root);

    await previewProject(db, root);
    const project = await registerProject(db, request(`${root}/`, { remoteName: 'origin' }), {
      now: () => 1_700_000_000_000,
      createId: () => '00000000-0000-4000-8000-000000000001',
    });

    assert.deepEqual(project, {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Fixture',
      localPath: root,
      gitCommonDir: join(root, '.git'),
      remoteName: 'origin',
      defaultBaseBranch: 'main',
      priority: 0,
      instructions: '',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    assert.deepEqual(listProjects(db), [project]);
    assert.deepEqual(snapshot(root), before, 'registration must not change the repository');
    assert.equal(git(root, 'status', '--porcelain'), '?? dirty.txt\n');
  });
});

test('rejects duplicate registration through the same path or a symlink', async () => {
  await withFixtures(async ({ directory, db }) => {
    const root = createRepository(join(directory, 'repo'));
    const project = await registerProject(db, request(root));
    const link = join(directory, 'alias');
    symlinkSync(root, link);

    for (const path of [root, link]) {
      const error = await rejectsWith(
        registerProject(db, request(path)),
        'project_already_registered',
      );
      assert.deepEqual(error.details, { projectId: project.id, projectName: 'Fixture' });
    }
    assert.deepEqual((await previewProject(db, link)).existingProject, {
      id: project.id,
      name: 'Fixture',
    });

    const second = createRepository(join(directory, 'second'));
    await registerProject(db, request(second, { name: 'Second' }));
    assert.deepEqual(
      listProjects(db).map(({ name }) => name),
      ['Fixture', 'Second'],
    );
  });
});

test('rejects a base branch or remote that does not exist in the repository', async () => {
  await withFixtures(async ({ directory, db }) => {
    const root = createRepository(join(directory, 'repo'));
    git(root, 'update-ref', 'refs/remotes/origin/release', 'HEAD');
    await rejectsWith(
      registerProject(db, request(root, { defaultBaseBranch: 'release' })),
      'base_branch_not_found',
    );
    await rejectsWith(
      registerProject(db, request(root, { remoteName: 'origin' })),
      'remote_not_found',
    );
    assert.deepEqual(listProjects(db), []);
  });
});

test('reports live repository details and problems without changing the registration', async () => {
  await withFixtures(async ({ directory, db }) => {
    const root = createRepository(join(directory, 'repo'));
    git(root, 'branch', 'develop');
    git(root, 'remote', 'add', 'origin', 'git@example.invalid:team/repo.git');
    const project = await registerProject(
      db,
      request(root, { defaultBaseBranch: 'develop', remoteName: 'origin' }),
    );

    const details = await getProjectDetails(db, project.id);
    assert.equal(details?.repository.status, 'available');
    if (details?.repository.status === 'available') {
      assert.deepEqual(details.repository.branches, ['develop', 'main']);
      assert.equal(details.repository.baseBranchExists, true);
      assert.equal(details.repository.remoteExists, true);
      assert.equal(details.repository.workingTree.isClean, true);
    }

    git(root, 'branch', '-D', 'develop');
    git(root, 'remote', 'remove', 'origin');
    const changed = await getProjectDetails(db, project.id);
    assert.equal(
      changed?.repository.status === 'available' && changed.repository.baseBranchExists,
      false,
    );
    assert.equal(
      changed?.repository.status === 'available' && changed.repository.remoteExists,
      false,
    );

    renameSync(root, join(directory, 'moved'));
    const moved = await getProjectDetails(db, project.id);
    assert.equal(moved?.repository.status, 'unavailable');

    // A working tree of a different repository at the registered path must not be presented as
    // the project. (A repository re-created in place keeps the same common Git directory, which is
    // the documented identity, so it counts as the same repository.)
    const other = createRepository(join(directory, 'other'));
    git(other, 'worktree', 'add', '--quiet', '-b', 'elsewhere', root);
    const replaced = await getProjectDetails(db, project.id);
    assert.equal(replaced?.repository.status, 'identity_changed');
    assert.equal(
      replaced?.repository.status === 'identity_changed' && 'branches' in replaced.repository,
      false,
    );

    assert.deepEqual(listProjects(db), [project]);
    assert.equal(await getProjectDetails(db, '00000000-0000-4000-8000-00000000ffff'), undefined);
    assert.equal(await getProjectDetails(db, '../../etc'), undefined);
  });
});
