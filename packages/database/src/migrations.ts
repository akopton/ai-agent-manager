import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { DatabaseConnection } from './client.js';

// Resolved from this module's file path instead of `new URL('../migrations/', import.meta.url)`:
// bundlers (Next.js Turbopack) treat that URL pattern as a static asset import and fail on a
// directory. `migrations/` sits beside both `src/` and `dist/`.
const migrationsFolder = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const applyMigrations = (connection: DatabaseConnection): void => {
  migrate(connection.db, { migrationsFolder: migrationsFolder() });
};
