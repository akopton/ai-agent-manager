# Database foundation

SQLite with `better-sqlite3` 12.11.1, Drizzle ORM 0.45.4, and Drizzle Kit 0.31.11.
The driver is pinned to the 12.x line, which was validated on Node 20.20.2 and is used
with the supported Node.js 24 runtime (see the root README). On macOS ARM64 it compiled
locally, so installation requires the Xcode command line tools and Python if no prebuilt
binding is available. pnpm permits its native install script in `pnpm-workspace.yaml`.
The compiled binding matches one Node.js ABI: after switching Node.js major versions,
run `pnpm rebuild better-sqlite3`.

## Connection lifecycle

The database file is resolved by `resolveDatabasePath()` using the runtime path
rules in the next section (by default
`~/Library/Application Support/ai-agent-manager/database.sqlite`). The parent
directory is created (mode `0700` for new directories) only when a connection is
explicitly opened, not on import or during migration generation.

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
The package has no singleton; the web app keeps one connection per server process
(`apps/web/lib/server/database.ts`).

## Runtime paths

This package is the single, Node.js-only resolver for local runtime paths. Path
resolution is pure (no filesystem access) and validated with Zod; directory creation
is a separate, explicit step. Nothing is created on import.

| Variable                         | Purpose                         | Default                                          |
| -------------------------------- | ------------------------------- | ------------------------------------------------ |
| `AI_AGENT_MANAGER_DATA_ROOT`     | Application data directory      | `~/Library/Application Support/ai-agent-manager` |
| `AI_AGENT_MANAGER_DATABASE_PATH` | SQLite database file            | `<data root>/database.sqlite`                    |
| `AI_AGENT_MANAGER_WORKTREE_ROOT` | Managed root for task worktrees | `<data root>/worktrees`                          |

Precedence, highest first:

1. An explicit argument, such as `createDatabase({ path })` (tests and tooling).
2. The specific variable (`AI_AGENT_MANAGER_DATABASE_PATH`, `AI_AGENT_MANAGER_WORKTREE_ROOT`).
3. A path derived from `AI_AGENT_MANAGER_DATA_ROOT`.
4. The macOS default, based on the current user's home directory.

The database and worktree overrides are independent: setting the database path does
not move the data root or the worktree root. The worktree default follows ARCHITECTURE
§8; any other location, such as `~/repos/.agent-worktrees`, is set via the variable.

Validation rules, applied before any side effect:

- Values are trimmed; empty, relative, `~user`, bare `~`, `:memory:`, and null-byte
  values are rejected with a `RuntimeConfigError` naming the variable. Values may be
  absolute or start with `~/`; spaces are supported. Paths are normalized.
- The data root and worktree root must not be the home directory, the filesystem
  root, or a parent of either.
- The worktree root must not be the data root or contain it, and the database file
  must not be inside the worktree root, so agent workspaces cannot reach app data.

```ts
import {
  ensureWorktreeRoot,
  initializeDataRoot,
  resolveRuntimePaths,
} from '@ai-agent-manager/database';

const paths = resolveRuntimePaths(); // { dataRoot, databasePath, worktreeRoot }, frozen
initializeDataRoot(paths); // explicit; creates missing directories with mode 0700
ensureWorktreeRoot(paths); // only when a worktree is about to be created (future milestone)
```

`resolveRuntimePaths({ environment, homeDirectory })` accepts an explicit environment
and home directory for tests. `resolveDataRoot`, `resolveDatabasePath`, and
`resolveWorktreeRoot` resolve individual paths with the same rules. The initialization
helpers never delete, empty, or change permissions of existing directories and fail
if a file occupies the path.

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
  to `migrations/`. Review generated files before applying them. With an unchanged
  schema, generation reports no changes.
- `db:migrate` applies versioned migrations explicitly using Drizzle's
  better-sqlite3 migrator and the configured connection. Exported `applyMigrations`
  uses the same migration directory from source or compiled code, independently
  of the working directory. Keep `migrations/` alongside `dist/` when distributing.
- `db:migrate:dev` is the step the root `pnpm dev` launcher runs before starting the web app
  and worker (local development only). It lists pending migrations with
  `listPendingMigrations` (read-only, mirroring Drizzle's migrator), backs up an existing
  database with `backupDatabase` (`VACUUM INTO` a new file under `backups/` beside the
  database; never overwrites) only when something is pending, then applies them. It exits
  non-zero on any failure.
- `db:migrate:kit` initializes the file and then invokes `drizzle-kit migrate`
  with the same configuration and migration history. This alternate CLI uses its
  own connection; use `db:migrate` when connection PRAGMAs must govern migration SQL.
- `test` runs all package tests, including runtime path resolution, directory
  initialization, and a check that importing the package has no filesystem side effects.
- `db:smoke` uses temporary directories and never touches the default
  application database. It verifies SQL operations, persistence, connection PRAGMAs,
  rollback, constraints, migration replay, and invalid paths.

For an isolated development database:

```sh
AI_AGENT_MANAGER_DATABASE_PATH=/tmp/ai-agent-manager-dev/database.sqlite pnpm --filter @ai-agent-manager/database db:migrate
```

Environment files are not automatically loaded; export the variable in the shell.
The package scripts run with the database workspace as their working directory,
which Drizzle Kit's relative schema/output paths require.

`0000_foundation.sql` contains only `SELECT 1` and establishes Drizzle's migration
history. `0001_projects.sql` adds the `projects` table. `0002_tasks.sql` adds the
`tasks` table. `0003_execution.sql` adds `security_settings`, `workspaces`, `task_runs`,
`run_events`, `worker_commands` and `worker_leases`, and the project execution trust columns
(see [Execution records](#execution-records)). Later migrations add reviews, publications, recoveries,
task archiving and cleanup, and `0008_conversations` adds the AI Conversations tables (see
[Conversations](#conversations)). Applied migrations are never edited; schema changes get a new migration.
`db:generate` resolves `@ai-agent-manager/core` (task enums used by the schema) from
its TypeScript sources, so it does not require a prior build. The web app and worker never apply
migrations on startup; the root `pnpm dev` launcher runs `db:migrate:dev` before starting them,
and outside it run `db:migrate` after pulling schema changes. The web app
checks that the tables it needs exist and otherwise reports the command to run.

## Projects

`projects` stores registered local Git repositories (M2-01 subset used by the M3-01
repository library). Timestamps are Unix milliseconds.

| Column                | Notes                                                          |
| --------------------- | -------------------------------------------------------------- |
| `id`                  | UUID generated by the application                              |
| `name`                | Display name                                                   |
| `local_path`          | Canonical repository root; unique                              |
| `git_common_dir`      | Canonical common Git directory (repository identity); unique   |
| `remote_name`         | Selected remote, or `NULL`                                     |
| `default_base_branch` | Existing local branch at registration time                     |
| `priority`            | Default `0`; ordering semantics are defined with the scheduler |
| `instructions`        | Default empty; editing is not implemented yet                  |
| `created_at`          | Unix ms                                                        |
| `updated_at`          | Unix ms                                                        |

`insertProject`, `listProjects`, `findProjectById` and `findProjectByRepository` are
plain data access. A unique-constraint violation on insert is raised as
`ProjectConflictError`. Repository validation lives in the caller (the web app).

## Tasks

`tasks` stores the tasks of a project (M2-01/M2-02). Status values, transitions and
input validation come from `@ai-agent-manager/core` (`task.ts`).

| Column          | Notes                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `id`            | UUID generated by the application                                        |
| `project_id`    | `projects.id`; `ON DELETE/UPDATE RESTRICT`                               |
| `title`         | Display title                                                            |
| `prompt`        | Task description sent to the agent                                       |
| `agent_runtime` | `claude` or `codex` (CHECK)                                              |
| `model_id`      | Explicit CLI model identifier, or `NULL` for `Default`                   |
| `base_branch`   | Base branch override, or `NULL` for the project's default base branch    |
| `priority`      | `critical`, `high`, `normal` (default) or `low` (CHECK)                  |
| `urgent`        | Boolean, default `false`                                                 |
| `status`        | `backlog` (default) … `discarded` (CHECK); see the lifecycle in `core`   |
| `queued_at`     | Unix ms of the last entry into `queued`; required while `queued` (CHECK) |
| `created_at`    | Unix ms                                                                  |
| `updated_at`    | Unix ms                                                                  |

Indexes: `(status, queued_at)` and `(project_id, status)`.

`createTask`, `updateTask` and `transitionTask` are domain commands: they validate
their input with the `core` schemas, enforce the lifecycle and throw `TaskError`
(`invalid_task_input`, `project_not_found`, `task_not_found`, `task_not_editable`,
`illegal_transition`). Each runs in one `IMMEDIATE` transaction and changes a row
only if its status is still the one that was checked, so concurrent commands from
the web app and the worker cannot both succeed from the same state. Passing a
transaction composes them with other writes. There is no task deletion yet.
`findTaskById` and `listProjectTasks` are plain reads.

Disconnecting a project with tasks fails with `ProjectHasDependentsError`; the
foreign key also blocks deleting the project row directly.

## Execution records

Added by `0003_execution.sql` for the first execution slice (`src/execution.ts`). Timestamps
are Unix milliseconds; every foreign key is `RESTRICT`.

| Table / columns                                                    | Purpose                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects.execution_trust`, `…_trusted_common_dir`, `…_trusted_at` | Per-project Trusted Local trust (`none` by default), bound to the common Git directory.                                                                                                                          |
| `security_settings` (single row)                                   | Trusted Local enable flag, accepted disclosure version, acceptance time and accepted risks. Disabling clears the acceptance.                                                                                     |
| `worker_commands`                                                  | Operator start requests (`pending` → `accepted`/`rejected` with a reason). One pending request per task (partial unique index).                                                                                  |
| `task_runs`                                                        | One row per attempt (`(task_id, attempt)` unique): run status, security mode and Trusted Local metadata, CLI version, exit data, error code, stop intent, Git integrity status/result/baseline, worker instance. |
| `workspaces`                                                       | Created task worktrees: repository identity, path, branch, base branch and base SHA. Retained.                                                                                                                   |
| `run_events`                                                       | Normalized, redacted events; `(run_id, sequence)` unique; at most 2,000 per run and 8 KiB per payload (`events_dropped` counts the rest).                                                                        |
| `worker_leases` (single row)                                       | The single-worker execution lease (owner, PID, heartbeat, expiry).                                                                                                                                               |

Partial unique indexes allow at most one active run (`pending`, `starting`, `running`,
`stopping`) **per task** and **per agent runtime**, in addition to the checks in
`claimStartCommand`. `requestTaskExecution`, `claimStartCommand`, `requestRunStop` and
`finishTaskRun` each run in one `IMMEDIATE` transaction; the claim and finish compose the
named task transitions (`start`, `complete_execution`, `stop`, `fail`, `interrupt`).

## Conversations

Added by `0008_conversations.sql` for C1, the AI Conversations foundation (`src/conversations.ts`).
The migration is additive and changes no existing table. Timestamps are Unix milliseconds; both foreign
keys are `RESTRICT`, so a project with conversations cannot be disconnected.

| Table                   | Purpose                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversations`         | One project's conversation: title, `agent_runtime`, `model_id` (`NULL` = `Default`), `language_mode` (`pl_technical_en`, `pl`, `en`), settings `revision`, `created_at`, `updated_at`, `last_message_at`. |
| `conversation_messages` | Ordered history: `sequence` (unique per conversation), `role` (`user`/`assistant`), `kind` (`note`/`chat`), `content`, `request_id` (unique; deduplicates submissions), `created_at`.                     |

`createConversation`, `updateConversation` and `addConversationNote` validate their input with the
`core` schemas, throw `ConversationError` and run in one `IMMEDIATE` transaction:

- `invalid_conversation_input`, `project_not_found` and `conversation_not_found` reject bad input or
  missing records.
- `conversation_changed` rejects a stale settings revision.
- `conversation_request_conflict` rejects a request ID that was reused for different content.

Reads and commands take the project ID together with the conversation ID, so another project's
conversation is reported as missing. `addConversationNote` stores only `user` notes; it never
starts an agent or produces a reply. The `assistant` role and the `chat` kind are reserved for C2,
which appends through the same internal sequence allocator.

`findProjectConversation`, `listProjectConversations`, `listConversationMessages` and
`countConversationsByProject` are plain reads.
