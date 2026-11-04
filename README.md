# AI Agent Manager

A single-user, local-first application for orchestrating Claude Code and Codex
in dedicated Git worktrees. Product requirements and architecture live in
[`docs/SPEC.md`](docs/SPEC.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Implementation status

M0.4 adds an explicit SQLite/Drizzle database foundation alongside the web shell.
M0.5 adds shared `core` contracts and a standalone Node.js worker process that opens
the configured database and shuts down gracefully. Projects, project boards, and
dashboard data remain future features. M0-03 adds validated runtime configuration for
the data root, database file, and managed worktree root. M1-01 adds read-only Git
repository inspection in `packages/git`, and M1-02 adds the task worktree lifecycle
(create, inspect, and safely remove locked worktrees on task branches), and M1-03 adds read-only
change inventories and file diffs against the recorded base commit for review.
The web app is not connected to the database, and no scheduling, API endpoints, or
agents are implemented.
The experimental scripts in `poc/` remain separate from production workspaces.

## Workspace layout

| Workspace                  | Intended responsibility                                 |
| -------------------------- | ------------------------------------------------------- |
| `apps/web`                 | Next.js UI, REST endpoints, and SSE                     |
| `apps/worker`              | Separate Node.js worker and process lifecycle           |
| `packages/core`            | Framework-independent domain types and validation       |
| `packages/database`        | SQLite schema, migrations, and access                   |
| `packages/agents`          | Agent contract and CLI adapters                         |
| `packages/git`             | Repository, worktree, review, and publishing operations |
| `packages/orchestrator`    | Scheduling and run coordination                         |
| `packages/cli-diagnostics` | CLI compatibility/security diagnostics (dev tooling)    |

The database package exports a connection factory and migration helper; `core`
exports framework-independent types and Zod schemas; `git` provides read-only
repository inspection and the task worktree lifecycle (see [`packages/git/README.md`](packages/git/README.md)).
`agents` and `orchestrator` remain private ESM package skeletons.

## Development commands

Use pnpm 12.16.1, pinned in `package.json`, and Node.js matching
`^20.19.0 || ^22.13.0 || >=24` (the web tooling requirement). The setup uses
Next.js 16.4.5 and React 19.3.1, with ESLint 9 and the matching Next.js config.
ESLint 9 is retained because the bundled React, import, and accessibility plugins
do not yet declare support for ESLint 10; pnpm reports ESLint 9 as deprecated.
Both the root and web workspace use TypeScript 6.0.3 for compatibility with
typescript-eslint. Strict mode remains enabled for the web and PoC checks.

```sh
pnpm install --frozen-lockfile
pnpm list --recursive --depth -1
pnpm dev
```

Open <http://127.0.0.1:3000>. `pnpm dev` also starts the worker in watch mode;
stop both with Ctrl+C.
Both development and production servers bind to `127.0.0.1`.

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm --filter @ai-agent-manager/web start
```

`pnpm typecheck` checks the existing PoC using the root strict TypeScript config,
then checks the web, core, database, git, and worker workspaces. The web check runs `next typegen` first, so it
also works before the first build. Next.js generates ignored `next-env.d.ts`
and `.next/` files. The web workspace uses its own bundler-oriented TypeScript
configuration; the PoC retains its NodeNext configuration.

`pnpm lint` checks JavaScript and TypeScript across apps, packages, and root
tooling using `eslint.config.mjs`. Next.js Core Web Vitals rules apply only to
`apps/web`; TypeScript recommended rules apply throughout the monorepo.
`pnpm build` produces the web production build, core and database ESM/declaration
files, git ESM/declaration files, and the compiled worker. `pnpm test` runs the core, database, git, agents,
orchestrator, worker, and CLI diagnostics tests; they use disposable temporary databases, Git
repositories and fake CLIs only, and never need an authenticated Claude Code or Codex session.

`packages/cli-diagnostics` is a separate development harness for checking the real CLIs' compatibility
and security behavior. It is not part of the production execution path and never authorizes runs.
See [`packages/cli-diagnostics/README.md`](packages/cli-diagnostics/README.md).

## Worker and shared packages

`apps/worker` is a separate Node.js process. It never imports Next.js. At startup it
resolves and validates all runtime paths (see [Runtime configuration](#runtime-configuration)),
logs them, and only then opens SQLite through `createDatabase()` from
`@ai-agent-manager/database`. Invalid configuration fails startup with exit code 1 before
any file is touched. It does not create the worktree root, apply migrations, poll, or
run jobs yet. A single idle timer keeps it alive
until SIGINT or SIGTERM, which stop the worker, close the database connection, and exit
with code 0.

```sh
AI_AGENT_MANAGER_DATABASE_PATH=/tmp/ai-agent-manager-dev/database.sqlite pnpm --filter @ai-agent-manager/worker dev
pnpm build && pnpm --filter @ai-agent-manager/worker start
```

`packages/core` holds framework-independent domain contracts (currently the agent
runtime and model-selection schemas plus worker lifecycle enums) and depends only on Zod.

Workspace packages export `dist/` for production. They also declare a
`@ai-agent-manager/source` export condition pointing at `src/index.ts`. The worker's
`dev`, `test`, and `typecheck` use that condition (through `tsx --conditions` and
TypeScript `customConditions`), so they work without building dependencies first. The
worker build clears the condition and compiles against the built packages; `pnpm build`
builds dependencies first in topological order.

## Runtime configuration

All local paths come from one Node.js-only resolver in `@ai-agent-manager/database`
(`resolveRuntimePaths()`). Environment files are not loaded automatically; export
variables in the shell.

| Variable                         | Default                                          |
| -------------------------------- | ------------------------------------------------ |
| `AI_AGENT_MANAGER_DATA_ROOT`     | `~/Library/Application Support/ai-agent-manager` |
| `AI_AGENT_MANAGER_DATABASE_PATH` | `<data root>/database.sqlite`                    |
| `AI_AGENT_MANAGER_WORKTREE_ROOT` | `<data root>/worktrees`                          |

A specific variable wins over a path derived from the data root, which wins over the
macOS default; the home directory is resolved at run time. Values must be absolute or
start with `~/`, may contain spaces, and are validated before any filesystem access. See
[`packages/database/README.md`](packages/database/README.md#runtime-paths) for the full
precedence and validation rules. Directories are created only by explicit calls,
never on import; the worktree root is created only when a worktree is needed.

```sh
# Keep task worktrees beside local repositories (the PoC development layout).
export AI_AGENT_MANAGER_WORKTREE_ROOT="$HOME/repos/.agent-worktrees"

# Use an isolated data root, for example on another volume.
export AI_AGENT_MANAGER_DATA_ROOT="/Volumes/Work Disk/ai-agent-manager"

# Only move the database; the data and worktree roots keep their defaults.
export AI_AGENT_MANAGER_DATABASE_PATH="$HOME/tmp/ai-agent-manager/database.sqlite"

pnpm dev
```

The worker reads these variables when it starts. The web app does not consume them
yet; when it does, only server-side code (route handlers and server components) may
import `@ai-agent-manager/database`. Resolved paths must not be passed to client
components or exposed through `NEXT_PUBLIC_*` variables.

## Database foundation

See [`packages/database/README.md`](packages/database/README.md) for client usage,
path configuration, native build requirements, and the versioned migration workflow.
The default file is `~/Library/Application Support/ai-agent-manager/database.sqlite`.
Importing the package does not open a connection or run migrations.

```sh
pnpm --filter @ai-agent-manager/database db:init
pnpm --filter @ai-agent-manager/database db:generate
pnpm --filter @ai-agent-manager/database db:migrate
pnpm --filter @ai-agent-manager/database db:smoke
```

## Coding standards and formatting

See `AGENTS.md` for conventions. ESLint enforces arrow-style function declarations,
arrow callbacks where safe, `const` where possible, type aliases, and no explicit
`any`. Default-exported framework functions and ambient TypeScript declarations
are supported; an interface needed for declaration merging or a public contract
can use a documented local rule suppression. Naming, named exports, early returns,
async/await, and avoiding unnecessary assertions remain code review conventions.

`pnpm format` applies Prettier; `pnpm format:check` checks without writing. Prettier
uses single quotes, semicolons, two spaces, width 100, trailing commas, and
parentheses around arrow parameters. ESLint disables conflicting formatting rules.
Both tools exclude dependencies, generated output, and local runtime data.
The existing experimental `poc/` scripts remain outside lint/format migration
(but are still typechecked). Prettier also preserves baseline `docs/`, the generated
Next.js instructions, and the generated lockfile to avoid unrelated rewrites.

## Web structure

`apps/web/app/layout.tsx` provides shared metadata and uses the reusable
`components/app-shell.tsx` layout; `app/page.tsx` is the placeholder overview.
Future routes such as `app/projects`,
`app/projects/[projectId]`, and `app/overview` can use that same layout. These
routes do not exist yet. Projects and project boards have disabled navigation
placeholders; the Add project button is also disabled. No sample task counts or
agent activity are displayed.

## UI foundation

Tailwind CSS 4.3.4 uses `@tailwindcss/postcss` in the web workspace's
`postcss.config.mjs`, following the [Next.js setup](https://tailwindcss.com/docs/installation/framework-guides/nextjs).
`app/globals.css` imports Tailwind, animation utilities, and shadcn styles. It
defines semantic color and radius tokens, including dark and sidebar variables,
using Tailwind's CSS-first configuration. The app currently uses the light theme;
no theme switcher is implemented. Fonts use the system stack, so builds do not
download font assets.

shadcn/ui was initialized in `apps/web` with the Radix/Nova preset and neutral
base color. `components.json` and the web TypeScript `@/*` alias keep components
and utilities local to this workspace; no shared UI package was added. Only
Button, Card, and Badge are installed in `components/ui/`. Components use named
exports and arrow functions, and `lib/utils.ts` re-exports the generated `cn`
utility. Icons use Lucide.

To add a component later, run from the repository root:

```sh
pnpm dlx shadcn@4.23.0 add <component> --cwd apps/web
```

Review generated code against `AGENTS.md`, then run formatting, lint, typecheck,
and build. Drag/drop, real navigation destinations, data storage, and execution
remain deferred.

Installation permits the existing `esbuild` dependency's build script for the
PoC's `tsx` tooling.
pnpm also recorded version-specific release-age exceptions for Next.js 16.4.5
and its matching packages in `pnpm-workspace.yaml` during installation.
`apps/web/AGENTS.md` contains the version-matched documentation guidance generated
by `next dev`; the repository's existing root instructions remain unchanged.
