import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  applyMigrations,
  backupDatabase,
  createDatabase,
  listPendingMigrations,
} from '../src/index.js';

const journalTags = (): string[] => {
  const journal: { entries: { tag: string }[] } = JSON.parse(
    readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
  );
  return journal.entries.map((entry) => entry.tag);
};

const withDirectory = (run: (directory: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-dev-migrations-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('lists every migration for a new database and none after applying them', () => {
  withDirectory((directory) => {
    const connection = createDatabase({ path: join(directory, 'database.sqlite') });
    try {
      assert.deepEqual(
        listPendingMigrations(connection).map((migration) => migration.tag),
        journalTags(),
      );
      // Read-only: listing must not create Drizzle's history table.
      assert.equal(
        connection.sqlite
          .prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'")
          .get(),
        undefined,
      );
      applyMigrations(connection);
      assert.deepEqual(listPendingMigrations(connection), []);
    } finally {
      connection.close();
    }
  });
});

test('lists only migrations newer than the latest applied one', () => {
  withDirectory((directory) => {
    const connection = createDatabase({ path: join(directory, 'database.sqlite') });
    try {
      applyMigrations(connection);
      const tags = journalTags();
      const last = tags.at(-1);
      // Simulate a database created before the newest migration existed.
      connection.sqlite
        .prepare(
          'DELETE FROM __drizzle_migrations WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations)',
        )
        .run();
      assert.deepEqual(
        listPendingMigrations(connection).map((migration) => migration.tag),
        [last],
      );
    } finally {
      connection.close();
    }
  });
});

test('backs up a consistent copy without overwriting an earlier backup', () => {
  withDirectory((directory) => {
    const connection = createDatabase({ path: join(directory, 'database.sqlite') });
    try {
      applyMigrations(connection);
      connection.sqlite.exec(
        "CREATE TABLE backup_probe (value TEXT); INSERT INTO backup_probe VALUES ('kept')",
      );
      const now = new Date('2026-11-06T10:00:00.000Z');

      const first = backupDatabase(connection, { label: 'pre-migration', now });
      const second = backupDatabase(connection, { label: 'pre-migration', now });

      assert.equal(
        first,
        join(directory, 'backups', 'database-pre-migration-2026-11-06T10-00-00-000Z.sqlite'),
      );
      assert.equal(
        second,
        join(directory, 'backups', 'database-pre-migration-2026-11-06T10-00-00-000Z-1.sqlite'),
      );
      for (const path of [first, second]) {
        assert.equal(existsSync(path), true);
        const copy = new Database(path, { readonly: true });
        try {
          assert.deepEqual(copy.prepare('SELECT value FROM backup_probe').all(), [
            { value: 'kept' },
          ]);
        } finally {
          copy.close();
        }
      }
    } finally {
      connection.close();
    }
  });
});
