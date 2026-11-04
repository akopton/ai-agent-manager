# AI Agent Manager

A single-user, local-first application for orchestrating Claude Code and Codex
in dedicated Git worktrees. Product requirements and architecture live in
[`docs/SPEC.md`](docs/SPEC.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Implementation status

M0.1 provides the initial pnpm workspace structure only. Application code,
framework dependencies, lint tooling, and a test runner are deferred to later
foundation steps. The experimental scripts in `poc/` remain separate from the
production workspaces.

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

Each workspace currently contains only a private ESM package manifest. Source
entry points and inter-package dependencies will be added as implemented.

## Development commands

Use the pnpm version pinned in `package.json` (12.16.1). Initial scaffolding was
validated with Node.js 20.20.2; application runtime requirements will be selected
when framework dependencies are introduced.

```sh
pnpm install --frozen-lockfile
pnpm list --recursive --depth -1
pnpm typecheck
```

`pnpm typecheck` checks the existing PoC using the root strict TypeScript config,
then runs any workspace `typecheck` scripts. Future workspaces should provide
their own TypeScript configuration and check script.

The root `dev`, `lint`, and `test` scripts dispatch to workspace scripts when
present. They currently perform no work: no application, linter, or test suite
has been implemented. A successful dispatch is not a lint or test result.
`pnpm dev` will run workspace development commands in parallel once defined.

Installation permits the existing `esbuild` dependency's build script for the
PoC's `tsx` tooling. No application dependencies have been added.
