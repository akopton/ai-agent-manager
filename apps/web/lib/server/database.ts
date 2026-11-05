import { createDatabase, type DatabaseConnection } from '@ai-agent-manager/database';

// One SQLite connection per web server process. It is kept on `globalThis` so development hot
// reloads reuse it instead of leaking connections. Server-only: never import from client code.

export const databaseMigrateCommand = 'pnpm --filter @ai-agent-manager/database db:migrate';

/** Tables this web build reads or writes. Migrations are applied explicitly, never on startup. */
const requiredTables = ['projects', 'tasks'] as const;

export class DatabaseNotReadyError extends Error {
  override name = 'DatabaseNotReadyError';
}

type DatabaseCache = { aiAgentManagerDatabase?: DatabaseConnection };

const cache = globalThis as typeof globalThis & DatabaseCache;

const missingTables = (connection: DatabaseConnection): string[] => {
  const statement = connection.sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  return requiredTables.filter((name) => statement.get(name) === undefined);
};

/**
 * Returns the shared Drizzle client. Throws `DatabaseNotReadyError` if the configured database
 * cannot be opened or its schema has not been migrated; the next call retries, so applying
 * migrations does not require a server restart.
 */
export const getDatabase = (): DatabaseConnection['db'] => {
  if (cache.aiAgentManagerDatabase !== undefined) {
    return cache.aiAgentManagerDatabase.db;
  }

  let connection: DatabaseConnection;
  try {
    connection = createDatabase();
  } catch (error) {
    // Details (including local paths) stay in the server log, not in responses.
    console.error('Failed to open the AI Agent Manager database.', error);
    throw new DatabaseNotReadyError(
      'The database could not be opened. Check the AI_AGENT_MANAGER_* path settings and the server log.',
    );
  }

  if (missingTables(connection).length > 0) {
    connection.close();
    throw new DatabaseNotReadyError(
      `The database schema is not up to date. Run \`${databaseMigrateCommand}\` with the same AI_AGENT_MANAGER_* settings, then reload.`,
    );
  }

  cache.aiAgentManagerDatabase = connection;
  return connection.db;
};

/** Closes the shared connection, if open. Used by tests and graceful shutdown. */
export const closeDatabase = (): void => {
  cache.aiAgentManagerDatabase?.close();
  cache.aiAgentManagerDatabase = undefined;
};
