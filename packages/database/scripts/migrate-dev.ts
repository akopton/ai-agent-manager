// Local development only (`pnpm dev`): applies pending migrations to the configured database,
// backing up an existing file first. Not part of production startup; the worker never migrates.
import { existsSync } from 'node:fs';
import {
  applyMigrations,
  backupDatabase,
  createDatabase,
  listPendingMigrations,
  resolveRuntimePaths,
} from '../src/index.js';

// Validate every runtime path before touching the filesystem, exactly as the worker does.
const { databasePath } = resolveRuntimePaths();
const existed = existsSync(databasePath);

const connection = createDatabase();
try {
  if (connection.path !== databasePath) {
    throw new Error(`Resolved database path changed during startup: ${connection.path}`);
  }
  console.log(`[db] Database: ${connection.path}${existed ? '' : ' (new file)'}`);

  const pending = listPendingMigrations(connection);
  if (pending.length === 0) {
    console.log('[db] Schema is up to date; no migrations to apply.');
  } else {
    console.log(`[db] Pending migrations: ${pending.map((migration) => migration.tag).join(', ')}`);
    if (existed) {
      const backupPath = backupDatabase(connection, { label: 'pre-migration' });
      console.log(`[db] Backup written to ${backupPath}`);
    }
    applyMigrations(connection);
    console.log(`[db] Applied ${pending.length} migration(s).`);
  }
} finally {
  connection.close();
}
