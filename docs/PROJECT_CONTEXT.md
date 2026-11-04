# AI Agent Manager — Project Context and Decision Log

**Status:** Context snapshot v0.1  
**Date:** 2026-11-03  
**Related documents:** [`SPEC.md`](./SPEC.md) v0.3, [`ARCHITECTURE.md`](./ARCHITECTURE.md) v0.1, [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) v0.1

## 1. Why this project exists

The owner uses Claude Code and OpenAI Codex through existing paid accounts and VS Code. Switching between agents and manually coordinating several coding tasks is cumbersome. This project aims to provide **one local web-based control center** for coding tasks across unrelated local Git repositories. The tool is for a **single user**, not for a team or a public hosted service.

The tool's own source may be hosted on GitHub while managed repositories may live on GitHub, Gitea, other Git remotes or locally. They do not need to share a parent directory or remote host.

## 2. Agreed product decisions

| Area | Decision |
|---|---|
| Project library | Connect multiple existing local repositories; one Kanban per project. |
| Dashboard | One global overview for running, queued and attention-required work. |
| Task | Title, prompt, project, agent runtime, optional model, priority and base branch. |
| Agent runtimes | Claude Code and Codex in MVP; implementation stays adapter-extensible. |
| Model selection | Chosen per task; `Default` delegates to CLI configuration. No named agent profiles. |
| Execution capacity | One active task per CLI by default, regardless of model; shared global scheduler. |
| Priorities | Urgent override, then project priority, task priority and enqueue order. |
| Queue | Backlog is inert; explicitly moving to Queued makes a task eligible. Pause queue without killing running tasks. |
| Branching | Each run starts from the selected project's default or task-overridden base branch, resolved at run time to a recorded SHA. Own task branch and worktree. |
| Dependencies | User manages task order manually. No dependency engine in MVP. |
| Instructions | Global instructions + per-project instructions + task prompt; respect repo instruction files. |
| Interaction | No mid-run conversation required. Additional prompt at Review triggers a follow-up run. |
| Review | Inspect tracked and untracked changes; request changes, discard, or approve. |
| Publish | After explicit review approval, commit and push **to the task branch only**. No automatic merge or PR. |
| Stop and recovery | Stop a run without deleting changes; retry safely; resume only when verified supported; unexpected shutdowns require manual reconciliation. |
| Language | Conversations can be Polish; technical docs, prompts, UI, code and commits are English. |

## 3. Agreed technologies

- TypeScript across frontend, backend and worker.
- Next.js + React, Tailwind CSS, shadcn/ui, dnd-kit.
- Local Node.js worker, REST commands and SSE status/log updates.
- SQLite + Drizzle ORM (chosen over Prisma for this private learning-oriented project).
- Zod, Git CLI and Git worktrees; `pnpm` workspaces.
- Local Claude Code CLI and OpenAI Codex CLI; no extra API integration required for the *verified CLI PoC*. Future authentication/entitlement compatibility must be validated for the production-style use case.

## 4. Local development setup observed

The owner develops on macOS using VS Code. During the conversation:

- Git, Node.js, and `pnpm` were installed and working (Node.js was observed at `v20.20.2`, pnpm at `12.16.1`). Confirm current versions before relying on them; these observations are not dependency constraints.
- The Claude and Codex CLI tools were installed and authenticated using the owner's accounts.
- Local development directories were reported under `~/repos/`, with `ai-agent-manager`, `agent-test-repo`, and a sibling `.agent-worktrees/` directory. **Do not hardcode these user-specific paths into production code.**
- The test repo was linked to GitHub; unrelated repositories may use Gitea. Git authentication is supplied by the owner's local Git configuration.

## 5. Confirmed Proof of Concept

The following outcomes were manually observed; they are not production automated tests:

| PoC item | Observed outcome |
|---|---|
| Worktree creation | Multiple branches from the same `main` commit had independent working directories. |
| Claude CLI | A TypeScript `spawn()` runner successfully created `math-utils.ts` in TASK-003; process exited `0`; file remained untracked. |
| Codex CLI | The same TypeScript runner successfully created files in TASK-004. |
| Stop Claude | Script sent stop to TASK-005; process logged exit code `143`, `Stopped manually: true`; partial untracked files remained. |
| Stop Codex | Script sent stop to TASK-006; process logged `Signal: SIGTERM`, `Stopped manually: true`; partial untracked files remained. |
| Isolation | The main checkout stayed clean during worktree tests; no agent-created commits/pushes were observed in tested runs. |

**Interpretation:** both CLIs can be called from Node.js/TypeScript on separate worktrees, and a basic POSIX process-group stop can leave partial work intact. These findings do **not** prove universal prevention of Git mutations or complete descendant-process termination.

## 6. Risks and unresolved questions

1. **Permission boundary:** Prompt instructions are not enough to prevent agent commits, pushes or access outside a worktree. Test actual tool restrictions, sandboxing, subprocesses, network and credential exposure per runtime.
2. **Session continuation:** Resuming a saved Claude/Codex run is not yet verified; implement as a capability-dependent option, not an assumption.
3. **Process supervision:** Verify child process cleanup, cancellation races and accurate slot release after stop or crash.
4. **Restart recovery:** Reconcile durable run records, OS processes and retained worktrees without duplicate launches.
5. **Review integrity:** Collect tracked and untracked files and compare immutable snapshot hashes before staging.
6. **Publishing retries:** A commit followed by failed push must be recoverable without duplicate commits or wrong-branch pushes.
7. **Model availability:** CLI model support varies by installed version/account; `Default` is safest. An unsupported explicit model should cause a clear recoverable error, never silent substitution.
8. **Runtime versions:** Check Node and pnpm requirements when scaffolding Next.js/Drizzle and lock supported versions.
9. **Storage:** Choose a user-writable data root and explicit cleanup/backup processes for SQLite WAL and managed worktrees.

## 7. Current repository/document status

At the point of writing this snapshot:

- Product requirements were reviewed and accepted as `docs/SPEC.md` **v0.3**.
- Technical architecture was prepared as `docs/ARCHITECTURE.md` **v0.1**.
- Small scripts exist in `poc/` for agent execution and stop testing.
- The next document and implementation steps are described in `docs/IMPLEMENTATION_PLAN.md`.
- Actual app scaffolding, SQLite/Drizzle models, scheduler, web UI and production adapters have **not yet been confirmed implemented**.

This document is a **context snapshot**, not an authoritative record of future implementation progress. Update it when major decisions or verified milestones change; prefer Git history and tests for detailed evidence.

## 8. Working with coding agents

When opening the repository in VS Code, ask the coding agent to read `AGENTS.md` and all files under `docs/`, inspect the repository and report its understanding **without changing files**. Then assign one bounded work package from the implementation plan (start with M0) and review its diff and test results before proceeding.

## 9. Future decisions and change control

- A third runtime may be added later through a new code-level adapter; a plugin installation UI is out of scope.
- Automatic task dependencies, cloud runners, automatic merges/PRs and multi-user access remain out of scope.
- If requirements change, update `SPEC.md` first, then reconcile `ARCHITECTURE.md`, this file and the plan.
