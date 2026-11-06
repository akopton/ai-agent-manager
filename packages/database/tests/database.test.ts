import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { applyMigrations, createDatabase, resolveDatabasePath } from '../src/index.js';

// Fixture schema only: these tables are never added to application migrations.
const smokeItems = sqliteTable('smoke_items', {
  id: integer('id').primaryKey(),
  value: text('value').notNull(),
});

test('resolves the macOS default, environment override, and home-relative paths', () => {
  assert.equal(
    resolveDatabasePath({}),
    join(homedir(), 'Library', 'Application Support', 'ai-agent-manager', 'database.sqlite'),
  );
  const path = join(tmpdir(), 'database-test.sqlite');
  assert.equal(resolveDatabasePath({ AI_AGENT_MANAGER_DATABASE_PATH: path }), path);
  assert.equal(
    resolveDatabasePath({ AI_AGENT_MANAGER_DATABASE_PATH: '~/database-test.sqlite' }),
    join(homedir(), 'database-test.sqlite'),
  );
  for (const value of ['', '  ', 'relative.sqlite', ':memory:', '/invalid\0path']) {
    assert.throws(() => resolveDatabasePath({ AI_AGENT_MANAGER_DATABASE_PATH: value }));
  }
});

test('creates a file, configures SQLite, performs typed CRUD, and persists across connections', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-database-'));
  const path = join(directory, 'nested', 'database.sqlite');
  try {
    assert.equal(existsSync(path), false);
    const connection = createDatabase({ path });
    try {
      assert.equal(existsSync(path), true);
      assert.equal(connection.sqlite.pragma('foreign_keys', { simple: true }), 1);
      assert.equal(connection.sqlite.pragma('journal_mode', { simple: true }), 'wal');
      assert.equal(connection.sqlite.pragma('busy_timeout', { simple: true }), 5000);
      connection.db.run(
        sql`CREATE TABLE smoke_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`,
      );
      connection.db.insert(smokeItems).values({ id: 1, value: 'connected' }).run();
      connection.db.update(smokeItems).set({ value: 'updated' }).run();
      assert.deepEqual(connection.db.select().from(smokeItems).all(), [
        { id: 1, value: 'updated' },
      ]);
      assert.throws(
        () =>
          connection.db.transaction((transaction) => {
            transaction.insert(smokeItems).values({ id: 2, value: 'rolled back' }).run();
            throw new Error('Rollback probe');
          }),
        /Rollback probe/,
      );
      connection.db.run(sql`CREATE TEMP TABLE smoke_parents (id INTEGER PRIMARY KEY)`);
      connection.db.run(
        sql`CREATE TEMP TABLE smoke_children (parent_id INTEGER REFERENCES smoke_parents(id))`,
      );
      assert.throws(() => connection.db.run(sql`INSERT INTO smoke_children VALUES (99)`));
    } finally {
      connection.close();
    }

    const reopened = createDatabase({ path });
    try {
      assert.deepEqual(reopened.db.select().from(smokeItems).all(), [{ id: 1, value: 'updated' }]);
      reopened.db.delete(smokeItems).run();
      assert.deepEqual(reopened.db.select().from(smokeItems).all(), []);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('applies versioned migrations once and creates only the expected application tables', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-migrations-'));
  try {
    const connection = createDatabase({ path: join(directory, 'database.sqlite') });
    try {
      applyMigrations(connection);
      const firstRun = connection.db.all(sql`SELECT * FROM __drizzle_migrations`);
      assert.equal(firstRun.length, 8);
      applyMigrations(connection);
      assert.deepEqual(connection.db.all(sql`SELECT * FROM __drizzle_migrations`), firstRun);
      assert.deepEqual(
        connection.db.all(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        ),
        [
          { name: '__drizzle_migrations' },
          { name: 'git_operations' },
          { name: 'projects' },
          { name: 'publications' },
          { name: 'reviews' },
          { name: 'run_events' },
          { name: 'security_settings' },
          { name: 'task_recoveries' },
          { name: 'task_runs' },
          { name: 'tasks' },
          { name: 'worker_commands' },
          { name: 'worker_leases' },
          { name: 'workspace_cleanups' },
          { name: 'workspaces' },
        ],
      );
    } finally {
      connection.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reports an unusable parent directory without overwriting the existing file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-invalid-database-'));
  try {
    const parent = join(directory, 'file');
    writeFileSync(parent, 'preserve');
    assert.throws(() => createDatabase({ path: join(parent, 'database.sqlite') }));
    assert.equal(readFileSync(parent, 'utf8'), 'preserve');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
