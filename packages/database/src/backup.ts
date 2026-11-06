import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { DatabaseConnection } from './client.js';
import { ensureDirectory } from './directories.js';

export type BackupDatabaseOptions = {
  /** Directory for the copy. Defaults to `backups/` beside the database file. */
  directory?: string;
  /** Used for the file name timestamp. */
  now?: Date;
  /** Label inserted into the file name, for example `pre-migration`. */
  label?: string;
};

const maxNameAttempts = 1000;

const backupFileName = (databasePath: string, label: string, now: Date, attempt: number) => {
  const extension = extname(databasePath) || '.sqlite';
  const stem = basename(databasePath, extname(databasePath));
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = attempt === 0 ? '' : `-${attempt}`;
  return `${stem}-${label}-${timestamp}${suffix}${extension}`;
};

/**
 * Writes a consistent copy of the open database with `VACUUM INTO`, which includes committed WAL
 * content and refuses to overwrite an existing file. Never replaces an earlier backup: a free name
 * is chosen with a numeric suffix when the timestamped name is taken. Returns the backup path.
 */
export const backupDatabase = (
  connection: DatabaseConnection,
  { directory, now = new Date(), label = 'backup' }: BackupDatabaseOptions = {},
): string => {
  const target = directory ?? join(dirname(connection.path), 'backups');
  ensureDirectory(target);

  for (let attempt = 0; attempt < maxNameAttempts; attempt += 1) {
    const path = join(target, backupFileName(connection.path, label, now, attempt));
    if (existsSync(path)) {
      continue;
    }
    connection.sqlite.prepare('VACUUM INTO ?').run(path);
    return path;
  }
  throw new Error(`Could not choose an unused backup file name in ${target}.`);
};
