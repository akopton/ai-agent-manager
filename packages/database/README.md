# Database foundation

SQLite with `better-sqlite3` 12.11.1, Drizzle ORM 0.45.4, and Drizzle Kit 0.31.11.
The driver is pinned to the Node-20-compatible 12.x line; 13.x requires Node 22.
On the validated Node 20.20.2/macOS ARM64 setup it compiled locally, so installation
requires the Xcode command line tools and Python if no prebuilt binding is available.
pnpm permits its native install script in `pnpm-workspace.yaml`.

## Connection lifecycle

The default database file is:

```text
~/Library/Application Support/ai-agent-manager/database.sqlite
```

Override it with `AI_AGENT_MANAGER_DATABASE_PATH`, using an absolute filesystem
path or a path starting with `~/`. Empty, relative, null-byte, URL, and `:memory:`
values are rejected. The parent directory is created recursively when a connection
is explicitly opened, not on import or during migration generation. This default
is macOS-specific; another platform should supply an explicit override for now.

Every connection enables foreign keys, WAL mode, and a 5000 ms busy timeout.
Opening a connection never applies migrations. Close each connection when finished.
WAL assumes a suitable local filesystem. SQLite files and their sidecars are ignored
by Git; SQL migrations and Drizzle metadata belong in version control.

After building this package, a future consumer can declare a `workspace:*`
dependency on `@ai-agent-manager/database` and use its ESM entry point:

```ts
import { createDatabase } from '@ai-agent-manager/database';

const connection = createDatabase();
try {
  // connection.db is the typed Drizzle client.
  // connection.sqlite is the underlying better-sqlite3 connection.
} finally {
  connection.close();
}
```

`createDatabase({ path })` provides an explicit per-connection override, useful for
tests. `resolveDatabasePath()` resolves the environment configuration without I/O.
There is no singleton and the web app does not consume the package yet.

## Explicit commands

Run these from the repository root:

```sh
pnpm --filter @ai-agent-manager/database build
pnpm --filter @ai-agent-manager/database db:init
pnpm --filter @ai-agent-manager/database db:generate
pnpm --filter @ai-agent-manager/database db:migrate
pnpm --filter @ai-agent-manager/database db:smoke
```

- `db:init` opens and closes the configured database without applying migrations.
- `db:generate` runs Drizzle Kit against `src/schema.ts` and writes SQL and metadata
  to `migrations/`. Review generated files before applying them. The schema is
  intentionally empty, so generation currently reports no changes.
- `db:migrate` applies versioned migrations explicitly using Drizzle's
  better-sqlite3 migrator and the configured connection. Exported `applyMigrations`
  uses the same migration directory from source or compiled code, independently
  of the working directory. Keep `migrations/` alongside `dist/` when distributing.
- `db:migrate:kit` initializes the file and then invokes `drizzle-kit migrate`
  with the same configuration and migration history. This alternate CLI uses its
  own connection; use `db:migrate` when connection PRAGMAs must govern migration SQL.
- `db:smoke` (also `test`) uses temporary directories and never touches the default
  application database. It verifies SQL operations, persistence, connection PRAGMAs,
  rollback, constraints, migration replay, and invalid paths.

For an isolated development database:

```sh
AI_AGENT_MANAGER_DATABASE_PATH=/tmp/ai-agent-manager-dev/database.sqlite pnpm --filter @ai-agent-manager/database db:migrate
```

Environment files are not automatically loaded; export the variable in the shell.
The package scripts run with the database workspace as their working directory,
which Drizzle Kit's relative schema/output paths require.

The generated `0000_foundation.sql` contains only `SELECT 1`. Applying it records
Drizzle's migration history without introducing domain tables. No schema push,
automatic startup migrations, project/task tables, or application logic is included.
