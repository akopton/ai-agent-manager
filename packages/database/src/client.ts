import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { resolveDatabasePath } from './config.js';
import { ensureDirectory } from './directories.js';
import { schema } from './schema.js';

export type DatabaseConnection = {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
  path: string;
  close: () => void;
};

export const createDatabase = (options: { path?: string } = {}): DatabaseConnection => {
  const path = resolveDatabasePath(
    options.path === undefined ? process.env : { AI_AGENT_MANAGER_DATABASE_PATH: options.path },
  );
  ensureDirectory(dirname(path));
  const sqlite = new Database(path);

  try {
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('foreign_keys = ON');
    const journalMode = sqlite.pragma('journal_mode = WAL', { simple: true });
    if (journalMode !== 'wal') {
      throw new Error('SQLite could not enable WAL mode for the database.');
    }
    return { db: drizzle(sqlite, { schema }), sqlite, path, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
};
