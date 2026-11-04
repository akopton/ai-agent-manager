# AI Agent Manager — MVP Implementation Plan

**Status:** Draft v0.1  
**Date:** 2026-11-03  
**Based on:** [`SPEC.md`](./SPEC.md) v0.3 and [`ARCHITECTURE.md`](./ARCHITECTURE.md) v0.1  
**Scope:** Single-user, local-first macOS MVP

## 1. Purpose and delivery rules

This is the executable plan for implementing AI Agent Manager. Product behavior is defined by `SPEC.md`; technical boundaries are defined by `ARCHITECTURE.md`. If an implementation task exposes a conflict, document it and resolve it explicitly before changing scope.

- Build **vertical, demonstrable increments**, not all packages simultaneously.
- Use **disposable Git repositories and local bare remotes** for integration tests. Never use company repositories in automated tests.
- Preserve `poc/` as verified experiments. Refactor ideas into production packages; do not treat PoC scripts as hardened components.
- Every milestone closes with working tests, manual verification instructions, and a commit. Keep documentation synchronized.
- Track the distinction between **confirmed** (PoC) and **not yet verified** (provider permissions, resume, crash recovery, review integrity).
- The application must never silently delete generated files and must never publish changes without explicit user approval.

## 2. Milestones and dependencies

| Milestone | Outcome | Depends on |
|---|---|---|
| **M0 — Foundation** | Reproducible monorepo, quality tooling, local runtime layout | Existing PoC |
| **M1 — Agent and Git safety spike** | Verified CLI constraints and worktree lifecycle; documented security limits | M0 |
| **M2 — Persistence and domain logic** | Durable project, task, run and command model | M0 |
| **M3 — Projects and Kanban slice** | Connect repos, create tasks, queue them from UI | M2 |
| **M4 — Scheduler and execution** | Queue drives either CLI with one slot per runtime | M1–M3 |
| **M5 — Stop and restart recovery** | Process control, retained partial work, interrupted-run handling | M4 |
| **M6 — Review and safe publishing** | Verified snapshots; feedback, discard, commit and push | M4–M5 |
| **M7 — Dashboard and polish** | Cross-project overview, settings, SSE, robust end-to-end checks | M3–M6 |

M1 and M2 can proceed independently after M0. Do not connect real work repositories until the security gate in M1 is understood and accepted.

## 3. Detailed work packages

### M0 — Foundation

**M0-01 — Baseline and docs**
- Commit `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PROJECT_CONTEXT.md`, root `AGENTS.md`.
- Keep local credentials, SQLite files, logs, managed worktrees and `node_modules` outside version control.
- Verify PoC files remain intact.

**M0-02 — Workspace scaffolding**
- Configure `pnpm-workspace.yaml` with `apps/web`, `apps/worker`, and `packages/{core,database,agents,git,orchestrator}`.
- Set up TypeScript strict mode, formatting/linting, test runner, root scripts (`dev`, `typecheck`, `lint`, `test`).
- Bootstrap Next.js App Router and a separately executable Node.js worker; use Node-supported package versions rather than assuming an old local version is sufficient.

**M0-03 — Runtime configuration**
- Define config for loopback bind address, application data root, managed worktree root and SQLite location.
- Use OS-appropriate writable local data storage; do not commit machine-specific absolute paths.
- Document launch/stop of web and worker with one development command.

**Done when:** fresh checkout installs, typechecks, lints, tests and launches web + worker with no cloud services or secrets.

### M1 — Agent and Git safety spike

**M1-01 — Git fixture tooling**
- Create automated fixtures: temporary source repo, local bare `origin`, initial commit, branch, and clean worktree cleanup.
- Add a worktree manager that resolves canonical paths and checks repository common-dir identity, expected branch and base SHA.

**M1-02 — Adapter contract**
- Define a framework-independent `AgentAdapter`, `AgentHandle`, normalized events, availability check and capabilities.
- Implement Claude and Codex adapters using argument-array process execution, explicit `cwd`, bounded output and no shell interpolation.
- Support `modelId = null` (defer to CLI) and an explicit model; record unsupported-model errors without fallback.

**M1-03 — Permission enforcement validation [SECURITY GATE]**
- For each CLI, verify what can actually be restricted: write paths, command/tool permissions, subprocesses, Git commit/push, environment and credential access.
- Test with disposable repositories and remotes, including adversarial requests to commit/push or write outside the workspace.
- Implement available containment and controls; explicitly document residual risks. **Do not label prompt-only restrictions as enforced safeguards.**

**Done when:** both adapters run in isolated test worktrees and the limitations of write/publish restrictions are recorded. Do not allow automatic publish-on-agent-completion.

### M2 — Persistence and domain logic

**M2-01 — Drizzle and SQLite**
- Implement migrations, foreign keys, WAL mode and `busy_timeout` for both processes.
- Create core tables: `projects`, `tasks`, `task_runs`, `workspaces`, `run_events`, `reviews`, `git_operations`, `scheduler_settings`; add command/lease storage when finalized.
- Keep SQLite user data out of Git; commit migrations and schema source.

**M2-02 — Domain states and transitions**
- Implement typed task/run/publish states and legal transitions; use Zod schemas at boundaries.
- Distinguish `Backlog`, `Queued`, `In Progress`, `Review`, `Done`, `Stopped`, `Interrupted`, `Failed`, `Discarded` and separate publish states.
- Preserve attempts rather than overwriting prior run history.

**M2-03 — Durable command handling**
- Persist enqueue, pause, stop, retry and publish intent with idempotency keys.
- Introduce one worker ownership/lease strategy and transaction-safe task claims.
- Add deterministic sorting by urgency, project priority, task priority, enqueue time and ID.

**Done when:** integration tests prove valid transitions, no duplicate active claim, one durable state after restart and no cross-project task leakage.

### M3 — Projects and Kanban slice

**M3-01 — Repository library**
- Create/list/edit/disconnect project entries with canonical local Git path, remote, default base branch, priority and instructions.
- Reject missing or invalid paths; prevent duplicate connections to the same repository.
- Disconnect must not delete source repositories or retained worktrees.

**M3-02 — Task creation and board**
- Create tasks with title, prompt, runtime (`claude`/`codex`), model (`Default`/explicit), priority, optional base branch override.
- Reset model when changing runtimes; display rejected/unsupported models as actionable errors.
- Render per-project Kanban with drag/drop transitions; only explicit `Queued` tasks are eligible to run.

**M3-03 — REST boundaries**
- Validate requests with Zod; return structured errors and guard mutations against untrusted origins.
- Resolve all registered repo paths on the server; never execute a browser-provided filesystem path directly.

**Done when:** two unrelated local repositories appear as distinct projects, each has its own board, and queueing changes durable state without yet invoking an agent.

### M4 — Scheduler and execution

**M4-01 — Scheduler**
- One elected worker polls/wakes on durable commands; respects pause/manual mode, global limit and **one active run per CLI** by default.
- Skip a busy runtime so available capacity in another runtime can be used.
- Atomic reservation before process launch; release only after termination has been reconciled.

**M4-02 — Workspace and run lifecycle**
- On claim: fetch selected remote when applicable, resolve base ref to exact SHA, create unique task branch and external worktree; record identity.
- Dispatch to adapter with global/project instructions plus task prompt, chosen model and worktree.
- Record normalized, size-bounded events, exit status, summary and session ID when available.

**M4-03 — Event delivery**
- Store run events in SQLite and expose event replay over SSE; browser reconnect must not lose durable run history.

**Done when:** queueing Claude and Codex tasks leads to independent worktrees and visible run progress; simultaneous same-runtime tasks never exceed the configured slot.

### M5 — Stop, retry and crash recovery

**M5-01 — Stop**
- Persist stop intent, request graceful shutdown, then escalate after a timeout when necessary.
- Confirm process-group/child termination as far as the platform permits; do not infer full termination from a single parent exit alone.
- Mark `Stopped`, free slot only after reconciliation, retain all changes and logs.

**M5-02 — Retry and conditional Resume**
- Retry creates a new attempt and safe workspace by default; never silently overwrite partial files.
- Offer Resume only when adapter capability and compatible saved session/workspace state are validated.
- Retain previous attempts for inspection.

**M5-03 — Recovery**
- Implement graceful worker shutdown and startup reconciliation of persisted active runs, process identity and Git worktrees.
- Mark unresolved attempts `Interrupted`; never auto-retry or auto-resume after restart.

**Done when:** stop works for both CLIs, partial work survives, restart surfaces interrupted work and no duplicate execution starts.

### M6 — Review and safe publishing

**M6-01 — Change inventory and snapshot**
- Inventory staged/unstaged/untracked/deleted/renamed/binary files using robust Git commands and NUL-delimited paths.
- Record branch, HEAD and canonical content hashes in a review snapshot; show diffs and actual test results, not invented pass indicators.

**M6-02 — Review actions**
- Implement `Request Changes` with stored follow-up prompt and new run on the intended retained workspace.
- Implement `Discard` as a state transition; deletion requires a separate explicit cleanup action.

**M6-03 — Approve & Push**
- Lock workspace and ensure no agent is active; recompute and match the approved snapshot.
- Stage **only approved files**, verify staged tree, commit with a task-linked message and persist SHA.
- Push explicitly to the configured remote and task branch. Do not merge or open PRs.
- Failed push retries **only push**, never duplicate commits; expose missing credentials, conflicts and changed snapshots clearly.

**Done when:** approve works against a disposable bare remote; adding a file after review blocks publishing; simulated push failure retains a single commit and can be retried safely.

### M7 — Dashboard, UX and completion

**M7-01 — Global dashboard**
- Show active runs across projects, agent capacity, queued order and `Needs Attention` (review, failed, interrupted, publish failed).
- Provide pause/resume queue controls; paused scheduling does not stop existing processes.

**M7-02 — Settings and cleanup**
- Global instructions; runtime availability and concurrency controls; managed roots; explicit confirmed worktree cleanup.
- Document backup/restore and troubleshooting, including SQLite WAL-aware procedures.

**M7-03 — Full acceptance suite**
- Execute all acceptance scenarios from `SPEC.md` §14, including second project, explicit/default models, stop, interrupted run, review feedback, publish integrity and push retry.
- Verify a clean fresh clone can install and run the app following README instructions.

**Done when:** every in-scope acceptance scenario passes and documented security limitations are visible; no outstanding data-loss or accidental-publish bugs.

## 4. Recommended implementation order for the first coding session

1. Read `SPEC.md`, `ARCHITECTURE.md`, `PROJECT_CONTEXT.md`, and root `AGENTS.md`.
2. Check the repository status and the existing PoC; do not modify `poc/` unless instructed.
3. Implement **M0-01 → M0-03** only. Run all documented checks.
4. Create a small disposable Git fixture and begin **M1-01**, without connecting a work repository.
5. Review the results before scheduling later milestones. Do **not** ask the coding agent to implement all milestones in one go.

## 5. Definition of Done for each work package

- Changes stay within the agreed scope, with no unrelated refactor.
- TypeScript typecheck, relevant automated tests and lint pass (or failures are reported honestly).
- New behavior has a focused test covering success and at least one failure/edge case.
- No credentials, personal project paths, real repo data, SQLite data files or generated worktrees are committed.
- User-facing behavior matches `SPEC.md`; architectural deviations are documented.
- The implementation agent reports files changed, commands run, results, known limitations and the recommended next task.
- Commits are prepared only when expressly requested; never push without the user's explicit instruction.

## 6. Deferred beyond MVP

- GUI installation of arbitrary agent runtimes or multiple named agent profiles.
- Automated cross-task dependencies and automatic merge/PR creation.
- Cloud runners, multi-user accounts, remote control, second-agent review and comparative runs.
- Real-time mid-run agent chat, advanced analytics and cost tracking.

## 7. Tracking

Use this file as the high-level milestone plan. When implementation starts, track detailed issue state in GitHub issues or a lightweight `docs/PROGRESS.md` if needed; **do not** turn this document into an unstructured activity log.

**Next action:** start **M0 — Foundation**, then perform the **M1 safety gate** before connecting real repositories.
