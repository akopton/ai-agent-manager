import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyMigrations,
  createDatabase,
  findProjectById,
  findProjectByRepository,
  insertProject,
  listProjects,
  ProjectConflictError,
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
