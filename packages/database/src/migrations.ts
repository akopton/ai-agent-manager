import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';
import type { DatabaseConnection } from './client.js';

// Resolved from this module's file path instead of `new URL('../migrations/', import.meta.url)`:
// bundlers (Next.js Turbopack) treat that URL pattern as a static asset import and fail on a
// directory. `migrations/` sits beside both `src/` and `dist/`.
const migrationsFolder = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Drizzle's migration history table (its default name; `applyMigrations` does not override it).
const migrationsTable = '__drizzle_migrations';

const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string().min(1), when: z.number().int() })),
});

export type PendingMigration = {
  /** Migration file name without `.sql`, for example `0006_recoveries`. */
  tag: string;
  /** Journal timestamp that Drizzle records as `created_at` once applied. */
  createdAt: number;
};

export const applyMigrations = (connection: DatabaseConnection): void => {
  migrate(connection.db, { migrationsFolder: migrationsFolder() });
};

/**
 * Lists the migrations `applyMigrations` would apply, without writing anything. Mirrors Drizzle's
 * better-sqlite3 migrator: every journal entry newer than the latest recorded `created_at` is
 * pending, and all entries are pending when no history exists yet.
 */
export const listPendingMigrations = (connection: DatabaseConnection): PendingMigration[] => {
  const journal = journalSchema.parse(
    JSON.parse(readFileSync(join(migrationsFolder(), 'meta', '_journal.json'), 'utf8')),
  );
  const historyExists =
    connection.sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(migrationsTable) !== undefined;
  const latest: unknown = historyExists
    ? connection.sqlite
        .prepare(`SELECT created_at FROM "${migrationsTable}" ORDER BY created_at DESC LIMIT 1`)
        .pluck()
        .get()
    : undefined;
  const latestCreatedAt = latest === undefined || latest === null ? undefined : Number(latest);

  return journal.entries
    .filter((entry) => latestCreatedAt === undefined || latestCreatedAt < entry.when)
    .map((entry) => ({ tag: entry.tag, createdAt: entry.when }));
};
