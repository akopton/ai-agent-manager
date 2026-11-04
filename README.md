# AI Agent Manager

A single-user, local-first application for orchestrating Claude Code and Codex
in dedicated Git worktrees. Product requirements and architecture live in
[`docs/SPEC.md`](docs/SPEC.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Implementation status

M0.2 adds a Next.js App Router web application with a placeholder homepage,
strict TypeScript, and ESLint. Projects, project boards, and the global dashboard
are future features; no data storage, API endpoints, or agents are connected.
The experimental scripts in `poc/` remain separate from production workspaces.

## Workspace layout

| Workspace | Intended responsibility |
| --- | --- |
| `apps/web` | Next.js UI, REST endpoints, and SSE |
| `apps/worker` | Separate Node.js worker and process lifecycle |
| `packages/core` | Framework-independent domain types and validation |
| `packages/database` | SQLite schema, migrations, and access |
| `packages/agents` | Agent contract and CLI adapters |
| `packages/git` | Repository, worktree, review, and publishing operations |
| `packages/orchestrator` | Scheduling and run coordination |

The worker and shared packages remain private ESM package skeletons. They have
no source entry points or inter-package dependencies yet.

## Development commands

Use pnpm 12.16.1, pinned in `package.json`, and Node.js matching
`^20.19.0 || ^22.13.0 || >=24` (the web tooling requirement). The setup uses
Next.js 16.4.5 and React 19.3.1, with ESLint 9 and the matching Next.js config.
ESLint 9 is retained because the bundled React, import, and accessibility plugins
do not yet declare support for ESLint 10; pnpm reports ESLint 9 as deprecated.
The web workspace uses TypeScript 6.0.3 for compatibility with typescript-eslint;
the existing PoC continues using the root TypeScript 7 dependency.

```sh
pnpm install --frozen-lockfile
pnpm list --recursive --depth -1
pnpm dev
```

Open <http://127.0.0.1:3000>. Stop the development server with Ctrl+C. Only the web
workspace currently has a development command; the worker is not implemented.
Both development and production servers bind to `127.0.0.1`.

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @ai-agent-manager/web start
```

`pnpm typecheck` checks the existing PoC using the root strict TypeScript config,
then checks the web workspace. The web check runs `next typegen` first, so it
also works before the first build. Next.js generates ignored `next-env.d.ts`
and `.next/` files. The web workspace uses its own bundler-oriented TypeScript
configuration; the PoC retains its NodeNext configuration.

The root scripts dispatch to workspace scripts when present. `pnpm lint` runs
the web ESLint configuration and `pnpm build` produces its production build.
`pnpm test` currently performs no work: no automated test suite has been added.

## Web structure

`apps/web/app/layout.tsx` provides shared metadata and the page shell;
`app/page.tsx` is the placeholder homepage. Future routes such as `app/projects`,
`app/projects/[projectId]`, and `app/overview` can use that same layout. These
routes do not exist yet. `app/globals.css` provides minimal styling with system
fonts and no external asset downloads. Tailwind, UI components, and drag/drop
tooling remain deferred.

Installation permits the existing `esbuild` dependency's build script for the
PoC's `tsx` tooling.
pnpm also recorded version-specific release-age exceptions for Next.js 16.4.5
and its matching packages in `pnpm-workspace.yaml` during installation.
`apps/web/AGENTS.md` contains the version-matched documentation guidance generated
by `next dev`; the repository's existing root instructions remain unchanged.
