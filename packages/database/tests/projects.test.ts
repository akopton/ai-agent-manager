import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyMigrations,
  createDatabase,
  deleteProject,
  findProjectById,
  findProjectByRepository,
  insertProject,
  listProjects,
  ProjectConflictError,
  ProjectHasDependentsError,
  updateProject,
  type DatabaseConnection,
  type NewProjectRecord,
} from '../src/index.js';

const withDatabase = (run: (connection: DatabaseConnection, path: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-projects-'));
  const path = join(directory, 'database.sqlite');
  const connection = createDatabase({ path });
  try {
    applyMigrations(connection);
    run(connection, path);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

const record = (overrides: Partial<NewProjectRecord> = {}): NewProjectRecord => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Website',
  localPath: '/repos/website',
  gitCommonDir: '/repos/website/.git',
  remoteName: 'origin',
  defaultBaseBranch: 'main',
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

test('stores a project with defaults and persists it across connections', () => {
  withDatabase(({ db }, path) => {
    const stored = insertProject(db, record());
    assert.deepEqual(stored, { ...record(), priority: 0, instructions: '' });
    assert.deepEqual(findProjectById(db, stored.id), stored);
    assert.equal(findProjectById(db, '00000000-0000-4000-8000-00000000ffff'), undefined);

    const reopened = createDatabase({ path });
    try {
      assert.deepEqual(listProjects(reopened.db), [stored]);
    } finally {
      reopened.close();
    }
  });
});

test('rejects a second project for the same path or the same common Git directory', () => {
  withDatabase(({ db }) => {
    insertProject(db, record());
    assert.throws(
      () =>
        insertProject(
          db,
          record({ id: '00000000-0000-4000-8000-000000000002', gitCommonDir: '/elsewhere/.git' }),
        ),
      ProjectConflictError,
    );
    assert.throws(
      () =>
        insertProject(
          db,
          record({ id: '00000000-0000-4000-8000-000000000003', localPath: '/repos/website-link' }),
        ),
      ProjectConflictError,
    );
    assert.equal(listProjects(db).length, 1);
  });
});

test('finds projects by path or common Git directory and lists them by name', () => {
  withDatabase(({ db }) => {
    const website = insertProject(db, record());
    const api = insertProject(
      db,
      record({
        id: '00000000-0000-4000-8000-000000000002',
        name: 'api',
        localPath: '/repos/api',
        gitCommonDir: '/repos/api/.git',
        remoteName: null,
        createdAt: 2_000,
        updatedAt: 2_000,
      }),
    );
    assert.deepEqual(
      listProjects(db).map(({ name }) => name),
      ['api', 'Website'],
    );
    assert.deepEqual(
      findProjectByRepository(db, { localPath: '/repos/website', gitCommonDir: '/none' }),
      website,
    );
    assert.deepEqual(
      findProjectByRepository(db, { localPath: '/none', gitCommonDir: '/repos/api/.git' }),
      api,
    );
    assert.equal(
      findProjectByRepository(db, { localPath: '/none', gitCommonDir: '/none/.git' }),
      undefined,
    );
  });
});

test('updates settings and the update time, but never the repository identity', () => {
  withDatabase(({ db }) => {
    const stored = insertProject(db, record());
    const updated = updateProject(
      db,
      stored.id,
      { name: 'Site', priority: -3, instructions: 'Use pnpm.', remoteName: null },
      2_000,
    );
    assert.deepEqual(updated, {
      ...stored,
      name: 'Site',
      priority: -3,
      instructions: 'Use pnpm.',
      remoteName: null,
      updatedAt: 2_000,
    });
    assert.deepEqual(findProjectById(db, stored.id), updated);

    // Omitted fields keep their values.
    const branchOnly = updateProject(db, stored.id, { defaultBaseBranch: 'develop' }, 3_000);
    assert.equal(branchOnly?.name, 'Site');
    assert.equal(branchOnly?.defaultBaseBranch, 'develop');
    assert.equal(branchOnly?.localPath, stored.localPath);
    assert.equal(branchOnly?.gitCommonDir, stored.gitCommonDir);
    assert.equal(branchOnly?.createdAt, stored.createdAt);

    assert.equal(
      updateProject(db, '00000000-0000-4000-8000-00000000ffff', { name: 'X' }, 4_000),
      undefined,
    );
  });
});

test('deletes only the project record and allows the repository to be registered again', () => {
  withDatabase(({ db }) => {
    const stored = insertProject(db, record());
    const other = insertProject(
      db,
      record({
        id: '00000000-0000-4000-8000-000000000002',
        localPath: '/repos/api',
        gitCommonDir: '/repos/api/.git',
      }),
    );
    assert.deepEqual(deleteProject(db, stored.id), stored);
    assert.equal(findProjectById(db, stored.id), undefined);
    assert.deepEqual(listProjects(db), [other]);
    assert.equal(deleteProject(db, stored.id), undefined);

    const again = insertProject(db, record({ id: '00000000-0000-4000-8000-000000000003' }));
    assert.equal(again.localPath, stored.localPath);
    assert.deepEqual(
      findProjectByRepository(db, { localPath: '/none', gitCommonDir: stored.gitCommonDir }),
      again,
    );
  });
});

test('refuses to delete a project that other records reference, even with ON DELETE CASCADE', () => {
  withDatabase(({ db, sqlite }) => {
    const stored = insertProject(db, record());
    const unrelated = insertProject(
      db,
      record({
        id: '00000000-0000-4000-8000-000000000002',
        localPath: '/repos/api',
        gitCommonDir: '/repos/api/.git',
      }),
    );
    // Stand-ins for future dependent tables such as `tasks`.
    sqlite.exec(`
      CREATE TABLE "dependent items" (
        id TEXT PRIMARY KEY,
        owner_project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE notes (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id));
    `);
    sqlite
      .prepare('INSERT INTO "dependent items" (id, owner_project) VALUES (?, ?), (?, ?)')
      .run('a', stored.id, 'b', stored.id);
    sqlite.prepare('INSERT INTO notes (id, project_id) VALUES (?, ?)').run('n', unrelated.id);

    assert.throws(
      () => deleteProject(db, stored.id),
      (error: unknown) => {
        assert.ok(error instanceof ProjectHasDependentsError);
        assert.deepEqual(error.dependents, [
          { table: 'dependent items', column: 'owner_project', count: 2 },
        ]);
        return true;
      },
    );
    assert.deepEqual(findProjectById(db, stored.id), stored);
    assert.deepEqual(sqlite.prepare('SELECT count(*) AS count FROM "dependent items"').get(), {
      count: 2,
    });

    assert.throws(() => deleteProject(db, unrelated.id), ProjectHasDependentsError);
    sqlite.exec('DELETE FROM "dependent items"');
    assert.deepEqual(deleteProject(db, stored.id), stored);
  });
});
