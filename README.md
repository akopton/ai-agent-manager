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
The Projects slices (M2-01 `projects` table and the M3-01 repository library) let the
web app register existing local Git repositories read-only, list them, show live
repository details, edit project settings, and disconnect projects without touching the
repository; see [Projects](#projects). Tasks, boards, scheduling, and agent runs are not
implemented in the web app.
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

Use pnpm 12.16.1, pinned in `package.json`, and **Node.js 24** (declared in the root
`package.json` `engines` field and in `.nvmrc`). The web tooling alone would accept
`^20.19.0 || ^22.13.0 || >=24`, but Node.js 20 caused React `ArrayBuffer` compatibility
errors in this setup, so only Node.js 24 is supported. See
[Node.js 24 on macOS](#nodejs-24-on-macos). The setup uses
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

### Node.js 24 on macOS

On macOS (Apple Silicon), install Node.js 24 with a version manager or Homebrew and make
it the active `node` before running any `pnpm` command:

```sh
# nvm or fnm read .nvmrc in the repository root:
nvm install && nvm use        # or: fnm use --install-if-missing

# Homebrew: node@24 is keg-only, so put it first on PATH for this shell
# (add the line to ~/.zshrc to make it permanent).
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"

node --version                # v24.x
```

`better-sqlite3` is a native module compiled for one Node.js ABI. After switching Node.js
major versions (for example from 20 to 24), rebuild it, or the web app and worker fail to
open the database with a `NODE_MODULE_VERSION` error:

```sh
pnpm rebuild better-sqlite3
```

Apply database migrations once (and after pulling schema changes) before starting:

```sh
pnpm --filter @ai-agent-manager/database db:migrate
```

Open <http://127.0.0.1:3000>. `pnpm dev` also starts the worker in watch mode;
stop both with Ctrl+C. The web `dev` script first builds the workspace packages it
uses (`core`, `database`, `git`), because Next.js consumes their compiled `dist/`
output; rebuild a package (or restart `pnpm dev`) after changing it.
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
orchestrator, worker, web (project service and API routes), and CLI diagnostics tests; they use disposable temporary databases, Git
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

The worker reads these variables when it starts; the web server reads them when it
first opens the database. Only server-side web code (route handlers and server
components, under `apps/web/lib/server`) may import `@ai-agent-manager/database`. Resolved paths must not be passed to client
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
`components/app-shell.tsx` layout with `components/main-nav.tsx`. `app/page.tsx` is
the overview. Project boards still have a disabled navigation placeholder, and no
sample task counts or agent activity are displayed.

## Projects

| Route                             | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `/projects`                       | Persisted project list, with empty and error states            |
| `/projects/new`                   | Check a repository path, review it, then add it                |
| `/projects/[projectId]`           | Details (HEAD, working tree, branches, remotes); disconnect    |
| `/projects/[projectId]/edit`      | Edit name, priority, instructions, base branch and remote      |
| `GET /api/projects`               | List projects                                                  |
| `POST /api/projects/preview`      | Validate a path and describe the repository (no writes)        |
| `POST /api/projects`              | Register a repository                                          |
| `GET /api/projects/:projectId`    | Project plus live, read-only repository information            |
| `PATCH /api/projects/:projectId`  | Update settings (partial); the repository path is not editable |
| `DELETE /api/projects/:projectId` | Disconnect: remove the project record only                     |

Registration accepts an absolute path or one starting with `~/`, anywhere on the local
filesystem. The server canonicalizes it (symlinks resolved) and requires the root of a
main working tree with at least one local branch; nested folders, bare repositories,
linked worktrees, `.git` directories and other users' repositories are rejected with
an actionable error. The default base branch and the remote must exist in the
repository. A repository is registered at most once: duplicates are detected by both
the canonical root and the canonical common Git directory.

Registration and details are read-only for the repository: they use the inspection
functions from `packages/git` (no fetch, checkout, branch, worktree, commit, or config
writes). Registration re-inspects the path instead of trusting the preview, and the
details view inspects only the stored canonical path.

Editing changes only the stored settings. Priority is an integer from -100 to 100
(default 0); lower numbers are scheduled first. Project instructions hold up to 10,000
characters and are kept separate from global instructions and from the repository's own
instruction files. The canonical path and common Git directory never change: to use a
repository at a new location, disconnect the project and add it again. A changed base
branch or remote must exist in the live repository at the registered path; if the
repository is missing, moved, inaccessible, or replaced by a different repository, the
request fails with a clear error, while name, priority, and instructions stay editable.

Disconnecting asks for confirmation and deletes only the project row in SQLite. It never
inspects or touches the repository: files, uncommitted changes, branches, worktrees,
remotes, Git configuration, and history stay as they are, and the repository can be
registered again afterwards. It fails closed with `project_has_dependents` (HTTP 409) if
any table declares a foreign key to `projects` and still has rows for the project; no
such tables exist yet, so future tasks, runs, and workspaces are covered automatically
instead of being removed by a cascade.

Request handling (`apps/web/lib/server`): request bodies are validated with Zod and
errors use `{ error: { code, message, details? } }`. `proxy.ts` rejects requests whose
`Host` is not a loopback address (DNS rebinding). `POST`, `PATCH`, and `DELETE` routes
also require an `Origin` header equal to the app's own origin (and `POST`/`PATCH` require
JSON), so other websites cannot use the browser to reach them; non-browser clients must
send that header explicitly.

To try it with a disposable repository and database:

```sh
export AI_AGENT_MANAGER_DATABASE_PATH="$HOME/tmp/ai-agent-manager-dev/database.sqlite"
pnpm --filter @ai-agent-manager/database db:migrate
mkdir -p ~/tmp/demo-repo && git -C ~/tmp/demo-repo init -b main
git -C ~/tmp/demo-repo commit --allow-empty -m "Initial commit"
pnpm --filter @ai-agent-manager/web dev
```

Then open <http://127.0.0.1:3000/projects> and add `~/tmp/demo-repo`.

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
Button, Card, and Badge were installed in `components/ui/`; Input (with a styled
native select), Label, and Alert were added by hand in the same style. Components use named
exports and arrow functions, and `lib/utils.ts` re-exports the generated `cn`
utility. Icons use Lucide.

To add a component later, run from the repository root:

```sh
pnpm dlx shadcn@4.23.0 add <component> --cwd apps/web
```

Review generated code against `AGENTS.md`, then run formatting, lint, typecheck,
and build. Drag/drop, task boards, and execution
remain deferred.

Installation permits the existing `esbuild` dependency's build script for the
PoC's `tsx` tooling.
pnpm also recorded version-specific release-age exceptions for Next.js 16.4.5
and its matching packages in `pnpm-workspace.yaml` during installation.
`apps/web/AGENTS.md` contains the version-matched documentation guidance generated
by `next dev`; the repository's existing root instructions remain unchanged.
