import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { DatabaseConnection } from './client.js';

export const applyMigrations = (connection: DatabaseConnection): void => {
  migrate(connection.db, {
    migrationsFolder: fileURLToPath(new URL('../migrations/', import.meta.url)),
  });
};
