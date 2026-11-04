# AI Agent Manager — Agent Instructions

These instructions apply to coding agents working **on the AI Agent Manager repository itself**. They are not automatically the instructions sent to agents executing third-party project tasks.

## Project and sources of truth

AI Agent Manager is a single-user, local-first application that orchestrates Claude Code and OpenAI Codex against separate Git worktrees of external repositories. Its main workflow is task creation → queue → agent execution → review → explicit approval → commit and push to the task branch.

Read these documents before planning or implementing changes:

1. `docs/SPEC.md` — required product behavior and acceptance criteria; authoritative for **what**.
2. `docs/ARCHITECTURE.md` — architecture and safety constraints; authoritative for **how**.
3. `docs/IMPLEMENTATION_PLAN.md` — milestone scope and definition of done.
4. `docs/PROJECT_CONTEXT.md` — verified PoC findings, local setup history and open risks.

If docs conflict, flag the mismatch and propose a focused resolution rather than silently choosing a different product behavior.

## Communication and code conventions

- Write code, identifiers, comments, tests, commit messages, technical documentation, prompts and UI copy **in English**.
- Keep changes small and targeted. Follow existing project conventions; prefer simple TypeScript over unnecessary abstractions.
- Use TypeScript strict mode and Zod for untrusted inputs. Maintain clear module boundaries.
- Prefer arrow functions assigned to `const` over function declarations. Allow function declarations when framework conventions, overloads, or ambient TypeScript declarations require them.
- Prefer named exports. Use default exports when a framework or tool requires them (for example, Next.js pages, layouts, and configuration files).
- Prefer `type` over `interface`; use interfaces when declaration merging or an extensible public contract makes them more appropriate. Document intentional lint exceptions locally.
- Avoid `any` and unnecessary type assertions. Narrow unknown values and let TypeScript infer types where possible.
- Prefer early returns to deeply nested branches, and async/await for asynchronous control flow.
- Use kebab-case for filenames and directories, camelCase for variables and functions, and PascalCase for components and types. Preserve framework filenames, dynamic route segments, and established documentation names such as `AGENTS.md`.
- Use Prettier for formatting: single quotes, semicolons, two-space indentation, a print width of 100, trailing commas, and parentheses around all arrow function parameters.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm format:check` before handing off changes. Existing experimental `poc/` scripts and baseline `docs/` documents are excluded from lint/format migration; do not refactor them incidentally.
- Work within the selected milestone; do not implement speculative post-MVP features.
- Report what was **actually tested**. Never claim tests pass if they were not run.

## Agreed technical direction

- TypeScript, Next.js/React, Tailwind CSS, shadcn/ui and dnd-kit.
- Local Node.js worker separate from Next.js; REST for commands and SSE for events.
- SQLite with Drizzle ORM; durable scheduler and run history.
- `pnpm` workspaces; shared packages for `core`, `database`, `agents`, `git` and `orchestrator`.
- Claude Code and Codex adapters. Model is selected **per task**; `Default` means no CLI override.
- One concurrent task per CLI by default, regardless of model; global and per-project priorities.
- Dedicated Git branch and worktree per task, outside the main checkout.

Avoid adding tRPC, Prisma, Redis, Docker, Electron, a hosted DB, a plugin marketplace or separate agent profiles without a deliberate documented decision.

## Safety and Git rules

- **Never run destructive commands against real work/company repositories.** Use temporary test repositories and disposable local bare remotes for integration tests.
- **Never make a commit, push, merge, open a PR, delete a worktree, or rewrite Git history unless explicitly requested by the user.** This rule governs your work on this repository; production publishing behavior is separately specified in the product docs.
- Do not treat prompt text or Git worktrees as security boundaries. Validate provider tool permissions and sandbox behavior before asserting that an agent cannot publish or modify other paths.
- Do not expose or commit credentials, CLI authentication files, `.env` values, SQLite data, user prompts/logs from third-party repositories or machine-specific paths.
- Use `spawn` with argument arrays and `shell: false` for external processes. Validate and canonicalize filesystem paths and Git refs; never interpolate user data into shell command strings.
- Preserve partially generated worktree files on stop/failure/interruption/discard. Deleting resources requires explicit confirmation and identity checks.
- Agent-produced source is never published automatically. The product's trusted review/publish component must verify the exact approved snapshot before commit/push.
- Bind the local API to loopback and defend state-changing endpoints against untrusted origins.

## Working method

1. Read the documents above and inspect the relevant files and current Git state.
2. Restate the smallest meaningful work package and its acceptance criteria.
3. Implement the minimum coherent change and accompanying tests.
4. Run typecheck, lint and relevant tests; inspect diffs for secrets and scope creep.
5. Summarize changes, commands/results, risks, and next step. Stop at review unless asked to commit/push.

## Current project state

- `poc/agent-runner.ts` and `poc/stop-agent.ts` are **experimental code**, not production-hardened infrastructure.
- PoC verified local CLI execution and manual stop for both Claude and Codex on disposable Git worktrees.
- Resume, cleanup of all descendant processes, post-crash reconciliation, enforceable commit/push restrictions, complete review snapshots and safe publishing are **not yet validated**.
- Begin with **M0 — Foundation** in `docs/IMPLEMENTATION_PLAN.md` unless the user selects a different bounded task.
