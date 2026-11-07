# AI Agent Manager — MVP Implementation Plan

**Status:** Draft v0.7 — AI Conversations C2 (CLI-backed conversations, provider-specific model selection) delivered (§8); v0.6: AI Conversations roadmap reset to C1–C4 and C1 (conversation foundation) delivered (§8); v0.5: TM-02 task archiving and managed worktree cleanup recorded as a focused slice (M2-02, M3-02, M7-02); v0.4 added SEC-02 execution security modes and staged plan (§9.3, §9.4); v0.3 added platform strategy and SEC-01 (§9); v0.2 added AI Conversations (§8)  
**Date:** 2026-11-07 (v0.6: 2026-11-06, v0.4: 2026-11-04, v0.1: 2026-11-03)  
**Based on:** [`SPEC.md`](./SPEC.md) v0.8 and [`ARCHITECTURE.md`](./ARCHITECTURE.md) v0.7  
**Scope:** Single-user, local-first macOS MVP

## 1. Purpose and delivery rules

This is the executable plan for implementing AI Agent Manager. Product behavior is defined by `SPEC.md`; technical boundaries are defined by `ARCHITECTURE.md`. If an implementation task exposes a conflict, document it and resolve it explicitly before changing scope.

- Build **vertical, demonstrable increments**, not all packages simultaneously.
- Use **disposable Git repositories and local bare remotes** for integration tests. Never use company repositories in automated tests.
- Preserve `poc/` as verified experiments. Refactor ideas into production packages; do not treat PoC scripts as hardened components.
- Every milestone closes with working tests, manual verification instructions, and a commit. Keep documentation synchronized.
- Track the distinction between **confirmed** (PoC) and **not yet verified** (provider permissions, resume, crash recovery, review integrity).
- The application must never silently delete generated files and must never publish changes without explicit user approval.
- **macOS-first, cross-platform-ready** (§9.1): implement and test for macOS only; keep platform-specific code behind module boundaries; do not add Windows, WSL2 or Linux support or speculative abstraction layers.

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

M1 and M2 can proceed independently after M0. Do not connect real work repositories until the security gate in M1 is understood and accepted. *(2026-11-04: accepted for the personal-use MVP through the explicit Trusted Local Mode, SEC-02 §9.3. This is acceptance of disclosed risks, not verification. Real execution stays off until SEC-02 is implemented and its tests pass.)*

The AI Conversations workstream (C1–C4) is defined separately in §8. It does not change M0–M7.

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

> **Decision 2026-11-04 (SEC-02, §9.3).** The M1-03 criterion stays as written for **Strict Isolated Mode**, which remains fail-closed and unverified.
>
> - Adversarial verification with real CLIs (M1-04B.2, VM-based) is **deferred** and is no longer a prerequisite for the personal-use MVP.
> - For the MVP, M1 is completed by:
>   - the recorded limitations (done: M1-03, M1-04A, M1-04B.1/1a, SEC-01);
>   - the SEC-02 Trusted Local implementation and its tests (§9.3).
> - No strict capability is marked verified. Completed M1 work is unchanged.

### M2 — Persistence and domain logic

**M2-01 — Drizzle and SQLite**
*(2026-11-05: connection settings and migrations exist; the `projects` table is added (migration `0001_projects`) and the `tasks` table (migration `0002_tasks`, `RESTRICT` reference to `projects`, indexes `(status, queued_at)` and `(project_id, status)`). 2026-11-05, execution slice: migration `0003_execution` adds `task_runs`, `workspaces`, `run_events`, a single-row `security_settings`, `worker_commands` and `worker_leases`, and the project trust columns. `git_operations` and `scheduler_settings` remain open. 2026-11-05, M6-02 slice: migration `0004_reviews` adds `reviews` (review decisions; snapshot columns still open). 2026-11-05, M6-03 slice: migration `0005_publications` adds `publications` (approval decision, review snapshot and publish state; the documented `reviews.snapshot_*` columns live here because `reviews.status` has a CHECK that only an additive table can extend) and `git_operations`. `scheduler_settings` remains open.)*
- Implement migrations, foreign keys, WAL mode and `busy_timeout` for both processes.
- Create core tables: `projects`, `tasks`, `task_runs`, `workspaces`, `run_events`, `reviews`, `git_operations`, `scheduler_settings`; add command/lease storage when finalized.
- Keep SQLite user data out of Git; commit migrations and schema source.

**M2-02 — Domain states and transitions**
*(2026-11-05, task slice: task states, Zod input schemas and the named task transitions are in `packages/core/src/task.ts`; `packages/database/src/tasks.ts` applies them transactionally. Execution slice: run states, attempt numbering and the run/task mapping (`resolveRunFinish` in the worker; Git integrity status stored separately). M6-03: publish states (`approved`, `committing`, `committed`, `push_requested`, `pushing`, `pushed`, `failed` with a failure stage) in `packages/core/src/publication.ts`. TM-02 (2026-11-06): archiving is a visibility flag, not a state; an archived task refuses operator transitions and edits (`task_archived`). Open: permanent task deletion (deferred).)*
- Implement typed task/run/publish states and legal transitions; use Zod schemas at boundaries.
- Distinguish `Backlog`, `Queued`, `In Progress`, `Review`, `Done`, `Stopped`, `Interrupted`, `Failed`, `Discarded` and separate publish states.
- Preserve attempts rather than overwriting prior run history.

**M2-03 — Durable command handling**
*(2026-11-05, execution slice: durable start requests (`worker_commands`, one pending per task, expiry after 5 minutes), persisted stop intent (`task_runs.stop_requested_at`), a single-worker lease (`worker_leases`) and transaction-safe claims. Open: pause/retry/publish commands, idempotency keys and priority ordering. TM-03 (2026-11-06): Return to Backlog withdraws a pending start request; see `ARCHITECTURE.md` §5.1 "TM-03 notes".)*
- Persist enqueue, pause, stop, retry and publish intent with idempotency keys.
- Introduce one worker ownership/lease strategy and transaction-safe task claims.
- Add deterministic sorting by urgency, project priority, task priority, enqueue time and ID.

**Done when:** integration tests prove valid transitions, no duplicate active claim, one durable state after restart and no cross-project task leakage.

### M3 — Projects and Kanban slice

**M3-01 — Repository library**
*(2026-11-05, first slice: read-only preview and registration, persisted list and read-only details view; invalid paths and duplicates are rejected. Second slice: editing of name, priority, instructions, base branch and remote (`PATCH /api/projects/:id`, branch/remote checked against the live repository) and disconnect (`DELETE /api/projects/:id`, removes only the project record; fails closed with `project_has_dependents` while any table references the project). Open: task counts and the warning/decision flow for tasks and retained worktrees (need the M2-01 `tasks`/`workspaces` tables), and the SEC-02 `execution_trust` fields. The project REST routes follow M3-03 validation and Origin rules.)*
- Create/list/edit/disconnect project entries with canonical local Git path, remote, default base branch, priority and instructions.
- Reject missing or invalid paths; prevent duplicate connections to the same repository.
- Disconnect must not delete source repositories or retained worktrees.

**M3-02 — Task creation and board**
*(2026-11-05, first slice: task creation (always `Backlog`), per-project board with all nine states (five main columns plus a compact row for Stopped/Interrupted/Failed/Discarded), task details and editing as the domain allows, explicit Queue and Return to Backlog through the named transitions, task counts in the project library and details, and the runtime-change model reset. Deferred: drag-and-drop (must request a named transition), a maintained candidate model list, task deletion and the disconnect decision flow, and actions that need run/review records (Retry, Resume, Request Changes, Discard). Model identifiers are checked for shape only; CLI rejection handling arrives with M4.) (2026-11-06, TM-02: Archive/Restore and an Archived tasks view; archived tasks are excluded from the default board and the active counts. Permanent task deletion stays deferred.)*
- Create tasks with title, prompt, runtime (`claude`/`codex`), model (`Default`/explicit), priority, optional base branch override.
- Reset model when changing runtimes; display rejected/unsupported models as actionable errors.
- Render per-project Kanban with drag/drop transitions; only explicit `Queued` tasks are eligible to run.

**M3-03 — REST boundaries**
*(2026-11-05: task routes are nested under `/api/projects/:projectId/tasks[/:taskId]` so every lookup and mutation is scoped to its project; see `ARCHITECTURE.md` §10. Same Host/Origin/JSON guards and structured errors as the project routes.)*
- Validate requests with Zod; return structured errors and guard mutations against untrusted origins.
- Resolve all registered repo paths on the server; never execute a browser-provided filesystem path directly.

**Done when:** two unrelated local repositories appear as distinct projects, each has its own board, and queueing changes durable state without yet invoking an agent.

### M4 — Scheduler and execution

**M4-01 — Scheduler**
*(2026-11-05: not started. The execution slice runs only explicitly requested tasks; the one-run-per-runtime limit is enforced at claim time and by partial unique indexes.)*
- One elected worker polls/wakes on durable commands; respects pause/manual mode, global limit and **one active run per CLI** by default.
- Skip a busy runtime so available capacity in another runtime can be used.
- Atomic reservation before process launch; release only after termination has been reconciled.

**M4-02 — Workspace and run lifecycle**
*(2026-11-05, first slice: operator-started Trusted Local runs with worktree creation from the **local** base branch, Git integrity baseline and post-run comparison, bounded/redacted events, stop, timeout and restart reconciliation; see `ARCHITECTURE.md` §7.5 "Worker integration notes". Not yet: `git fetch` and remote-tracking base resolution, global instructions, SSE (M4-03).)*
- On claim: fetch selected remote when applicable, resolve base ref to exact SHA, create unique task branch and external worktree; record identity.
- Dispatch to adapter with global/project instructions plus task prompt, chosen model and worktree.
- Record normalized, size-bounded events, exit status, summary and session ID when available.

**M4-03 — Event delivery**
- Store run events in SQLite and expose event replay over SSE; browser reconnect must not lose durable run history.

**Done when:** queueing Claude and Codex tasks leads to independent worktrees and visible run progress; simultaneous same-runtime tasks never exceed the configured slot.

*SEC-02 dependency:* M4 runs agents only under an authorization from §9.3 (Trusted Local for the MVP). It records the security mode with every run and runs the post-run Git integrity check.

### M5 — Stop, retry and crash recovery

**M5-01 — Stop**
- Persist stop intent, request graceful shutdown, then escalate after a timeout when necessary.
- Confirm process-group/child termination as far as the platform permits; do not infer full termination from a single parent exit alone.
- Report containment truthfully: process-group cleanup is not complete descendant containment (SEC-01, §9.2).
- Mark `Stopped`, free slot only after reconciliation, retain all changes and logs.

**M5-02 — Retry and conditional Resume**
*(2026-11-05: delivered as the focused slice **TM-01 — Retry, Resume & Discard**, tracked separately and without renumbering; see `ARCHITECTURE.md` §5.1 "TM-01 implementation notes". Retry (Failed) and Resume (Stopped/Interrupted) record a decision (migration `0006_recoveries`) and return the task to Queued; the next attempt runs only after an explicit Start and continues in the retained worktree. Accepted v1 semantics (`SPEC.md` §11, decided 2026-11-05) narrow the bullets below: one worktree per task is kept, so Retry continues the existing changes (and refuses when the worktree cannot be continued safely); Resume starts a new agent session. Discard (M6-02) is a logical transition. Deferred: Retry from scratch (fresh workspace), native session resume, worktree cleanup (delivered in limited form by TM-02, see M7-02).)*
- Retry creates a new attempt and safe workspace by default; never silently overwrite partial files.
- Offer Resume only when adapter capability and compatible saved session/workspace state are validated.
- Retain previous attempts for inspection.

**M5-03 — Recovery**
- Implement graceful worker shutdown and startup reconciliation of persisted active runs, process identity and Git worktrees.
- Mark unresolved attempts `Interrupted`; never auto-retry or auto-resume after restart.

**Done when:** stop works for both CLIs, partial work survives, restart surfaces interrupted work and no duplicate execution starts.

### M6 — Review and safe publishing

**M6-01 — Change inventory and snapshot**
*(2026-11-05, first slice: read-only Review Changes. `GET /api/projects/:projectId/tasks/:taskId/review` (run metadata, Git integrity, eligibility, change inventory) and `GET …/review/diff?path=` (one file's diff, only for inventory paths), page `/projects/:projectId/tasks/:taskId/review`, linked from the Review column and the task page. The worktree comes from the latest run's stored workspace and is verified against the task, project and managed layout before `inspectTaskChanges` reads it. Integrity violations and inconclusive checks are shown and block eligibility. Not yet: the persisted review snapshot (`reviews` table, snapshot hash), actual test results, and an "open in editor" action; an unreadable file makes the whole inventory unavailable instead of being listed.)*
- Inventory staged/unstaged/untracked/deleted/renamed/binary files using robust Git commands and NUL-delimited paths.
- Record branch, HEAD and canonical content hashes in a review snapshot; show diffs and actual test results, not invented pass indicators.

**M6-02 — Review actions**
*(2026-11-05, first slice: Request Changes. `POST /api/projects/:projectId/tasks/:taskId/review/request-changes` (`{runId, revision, feedback}`) re-inspects the review, requires normal-review eligibility, the same latest run and the same change-inventory revision, then stores the feedback in `reviews` (migration `0004_reviews`) and applies `request_changes` (Review → Queued) in one transaction. No agent starts: the follow-up attempt runs only after an explicit Start execution, through the normal claim, consent, trust and per-runtime checks. It continues in the **same** retained worktree and branch (re-verified before launch, never reset or recreated) with the original prompt plus the latest feedback. The Review Changes page has the form, the pending request and the attempt history; the task page explains the continuation. Not yet: Discard, agent session resume, per-attempt file snapshots, and Retry/Resume for a follow-up attempt that failed or was stopped.)*
- Implement `Request Changes` with stored follow-up prompt and new run on the intended retained workspace.
- Implement `Discard` as a state transition; deletion requires a separate explicit cleanup action.

**M6-03 — Approve & Push**
*(2026-11-05, first slice: implemented as specified; see `ARCHITECTURE.md` §9 "M6-03 implementation notes". The web process records an approval bound to a review snapshot after an explicit confirmation (`POST …/review/approve`); the worker re-verifies and commits exactly the snapshot on the task branch, pushes only `refs/heads/<task branch>` to the configured remote without force, and applies `mark_done` only with a confirmed push. Push failures keep the commit and offer Retry push (`POST …/review/retry-push`). Not yet: Discard, `git fetch` before review, and an operator-editable commit message.)*
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
*(2026-11-06: the explicit confirmed worktree cleanup part was delivered early as the focused slice **TM-02 — Task Archiving & Managed Worktree Cleanup**, tracked separately and without renumbering; see `ARCHITECTURE.md` §5.1 and §8 "TM-02 implementation notes" and `SPEC.md` §7.1 and §9.1. Accepted v1 scope: reversible task archiving; read-only worktree inventory on the task page; Remove local worktree for a Done task whose latest attempt was pushed (worktree clean at the pushed commit) or a Discarded task whose worktree is unchanged at the base commit, with no uncommitted, untracked or ignored files; recorded in `workspace_cleanups` (migration `0007_task_archive_cleanup`), executed by the worker after re-verification, branches kept. Deferred: permanent task deletion, forced cleanup or ignored-file override, branch deletion, retention policy, the project-disconnect decision flow for retained worktrees, and the rest of M7-02.)*
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
- Real-time mid-run agent chat, advanced analytics and cost tracking. (Mid-run chat with a running task is distinct from AI Conversations, which are planned in §8.)
- Windows (native or WSL2) and Linux support. Possible future platforms, each requiring its own compatibility and security verification (§9.1).

## 7. Tracking

Use this file as the high-level milestone plan. When implementation starts, track detailed issue state in GitHub issues or a lightweight `docs/PROGRESS.md` if needed; **do not** turn this document into an unstructured activity log.

**Next action:** start **M0 — Foundation**, then perform the **M1 safety gate** before connecting real repositories. *(2026-11-04: the M1 safety gate for the MVP is SEC-02 Trusted Local Mode, §9.3.)*

## 8. Workstream: AI Conversations (C1–C4)

> A separate workstream for `SPEC.md` §18 and `ARCHITECTURE.md` §15. It does **not** renumber or change M0–M7, and it is not part of the MVP "Done when" criteria. The milestones use the `C` prefix to stay distinct from the `M` milestones.

> **Decision 2026-11-06 (operator).** The roadmap is reset from C1–C5 to **C1–C4**, ordered by product value: conversations first, then real CLI replies, then task proposals into Backlog, then deeper project and task awareness.
>
> - The earlier C1 (domain, CLI gate and turn lifecycle together) is split: **C1** is persistence and UI only, and the CLI work moves to **C2**.
> - The earlier C3 (Project AI) becomes the starting point: C1 conversations are **project-scoped only**.
> - The earlier C5 (Planning-to-Kanban) becomes **C3**, and project context assembly becomes **C4**.
> - **Global AI** (earlier C2) and **Architecture Decisions** (earlier C4) stay specified in `SPEC.md` §18.5 and §18.7 but are **unscheduled**. Each needs its own planning decision.
> - The safety requirements of the earlier plan are unchanged and move with their work: the conversation gate and adversarial profile verification go to C2, and the "no queue/run/publish" architecture check goes to C3.

### 8.1 Milestones and dependencies

| Milestone | Outcome | Depends on |
|---|---|---|
| **C1 — AI Conversations Foundation** *(delivered 2026-11-06)* | Project-scoped conversations with runtime, model and language settings; durable, ordered history of operator notes; REST API and UI. No model runs. | M2, M3-01 |
| **C2 — CLI-backed conversations** *(delivered 2026-11-07)* | Real replies from Claude Code or Codex in Conversation Mode: conversation gate and launch profiles, worker-owned turns, streaming, cancellation, restart handling, language-mode instructions. | C1, M1-02, M1-03 verification method, M4-03 (event log + SSE) |
| **C3 — Task proposals to Backlog** | Structured task proposals from a conversation; edit, reject or accept each; accepted proposals create `Backlog` tasks with an origin reference. | C2, M3-02 |
| **C4 — Project and task awareness** | Controlled, read-only context assembly: project instructions, task history and explicitly selected files, with a visible per-turn context manifest. | C2 |

### 8.2 Work packages

#### C1 — AI Conversations Foundation (delivered 2026-11-06)

**Delivered scope:**

- `packages/core/src/conversation.ts`: IDs, the three language modes (`pl_technical_en` default, `pl`, `en`), title and content validation, roles (`user`, `assistant`) and kinds (`note`, `chat`), create/update/note input schemas, the runtime/model reset rule shared with tasks, and `ConversationError`.
- Migration `0008_conversations` (additive): `conversations` and `conversation_messages` (`ARCHITECTURE.md` §15.3 "C1 implementation notes"). No existing table changes.
- `packages/database/src/conversations.ts`: project-scoped commands in `IMMEDIATE` transactions:
  - create;
  - update settings with a settings revision (stale updates rejected);
  - add a note, deduplicated by a client request ID;
  - project-filtered reads.
- REST routes under `/api/projects/:projectId/conversations` with the existing Host, Origin, JSON and size guards (`ARCHITECTURE.md` §15.10).
- UI: a **Conversations** entry in the main navigation, per-project list, New conversation, and a conversation page with history, settings and note composer. Each surface states that AI replies are not enabled yet.

**Scope decisions:**

- Conversations are **project-scoped only**. `project_id` is `NOT NULL`; a global scope would need its own migration and decision.
- A C1 message is an operator **note** (`role = user`, `kind = note`). It is stored only, never sent to a CLI, and never answered. No placeholder assistant message is created.
- The default runtime is Claude Code, matching the task form; there is no stored runtime preference to inherit.
- Model selection follows the task convention: free-text identifier or `Default` (`NULL`), shape-checked only, with no model catalog. Switching the runtime without choosing a model resets it to `Default`. *(Superseded in C2 by the provider-specific selector with a curated catalog and a custom ID option.)*
- **Archive and delete are deferred.** Deletion needs the confirmation and origin-reference rules of `SPEC.md` §18.10, which only matter once proposals exist. A project with conversations cannot be disconnected (`project_has_dependents`), the same as with tasks.
- Notes cannot be edited or deleted yet.
- Markdown is stored as written and displayed as plain text; rendering is deferred.

**Done when** *(met)*: conversations and notes survive a restart in deterministic order; cross-project access is refused; invalid, oversized and duplicate submissions are handled; and tests prove that no task, worker command, run, Git operation or repository change results.

#### C2 — CLI-backed conversations (delivered 2026-11-07)

**Delivered scope** (details: `ARCHITECTURE.md` §15.6 "C2 implementation notes"):

- Separate AI Conversations consent (versioned disclosure `2026-11-07.1`, `conversation_settings`, Settings card). Trusted Local execution consent and project trust do not enable it.
- Conversation launch profiles `claude-conversation-no-tools` and `codex-conversation-read-only`, the fail-closed conversation gate (`authorizeConversationTurn`; Strict Isolated always denied) and a separate launch boundary (`startConversationTurn`) with its own authorization type and in-process provenance registry. Shared process supervision (`supervised-run.ts`, extracted unchanged from `startAgentExecution`).
- Durable, worker-owned turns (`conversation_turns`, migration `0009`): queued → running → completed | failed | cancelled | interrupted (+ stopping); idempotent send and retry; one active turn per conversation; replies stored only for completed turns; Stop through process-group stop; 10-minute timeout; restart reconciliation to `interrupted` without signalling or relaunch; stale queued turns expire; one conversation slot per CLI, separate from execution slots.
- Context: earlier completed exchanges within a 60,000-character budget, notes excluded, language instruction in its own prompt section, per-turn manifest.
- UI: Send to AI / Save as note composer, message bubbles with safe Markdown rendering, turn states (waiting, generating, stopping, failed, stopped, interrupted) with Stop and Retry, runtime/model/language on every reply, auto-refresh while a turn runs, honest notice.
- Provider-specific model selector for tasks and conversations (Default, curated catalog per runtime, custom ID), with server- and client-side provider validation that keeps stored custom IDs editable.
- Tests with fake CLIs, disposable repositories and temporary databases only; static architecture checks that conversation code cannot reach execution authorizations, Git, tasks or publishing.

**Not done in C2 (recorded limitations):** no authenticated real CLI turn and no adversarial verification of the conversation profiles (every control stays `unverified`); no token streaming or SSE (polling refresh); partial text of a stopped reply is not kept; no native session resume; Strict Isolated conversations unavailable; project instructions, task history and files are not sent (C4); no summaries.

**Manual verification (operator):** see the C2 browser test plan in the hand-off report; record its result here when run.

**Original work package:**


- Investigate Conversation Mode per CLI and installed version:
  - streaming format;
  - native session resume;
  - per-turn model switching;
  - effective-model metadata;
  - context limits;
  - which settings, instructions or memory files are loaded.
- Define Conversation Mode launch profiles, preferring no tools. Verify them adversarially with disposable fixtures, using the M1-03 method: no writes, no commands, no Git, no reads outside the scratch directory.
- Implement the fail-closed conversation pre-launch gate and a separate Trusted Local conversation opt-in (`SPEC.md` §18.2). Acknowledgements are informational only, and isolation is never claimed unless enforced.
- Worker-owned turns, built on C1's history:
  - claim;
  - launch in the scratch directory;
  - bounded, persisted events over SSE;
  - cancel via process-group stop;
  - structured errors;
  - `interrupted` on restart, with no automatic retry.
- Assistant messages (`kind = chat`) record the requested runtime and model, and the effective model only when reported trustworthily. They are appended through the same sequence allocator as notes.
- Translate the language mode into CLI instructions. Decide whether C1 notes are included in the context and show it.
- Extend the architecture check: conversation code cannot obtain an execution authorization.

**Done when:** a conversation exchanges messages with both CLIs under a verified conversation profile, or is refused with an actionable reason. Streaming, cancellation and restart behave as specified. No repository is touched. Tests use fake CLIs; live-CLI verification is recorded separately.

#### C3 — Task proposals to Backlog

- Structured proposals parsed and validated into `draft` proposals; edit, reject, accept individually.
- Acceptance reuses the M3 task creation command; tasks enter `Backlog` with origin references.
- Architectural check, backed by tests: the conversations module has no access to queueing, scheduling, worktree, Git mutation or publish commands.
- Conversation archive and confirmed deletion (proposals and origin references), if still open.

**Done when:** `SPEC.md` §18.11 criterion 8 passes, and no conversation path can queue, run or publish a task.

#### C4 — Project and task awareness

- Context sources:
  - project instructions;
  - task history;
  - explicitly selected files, read through `packages/git` from a resolved commit (hardened, read-only, size-limited, binary-aware).
- Visible per-turn context manifest; cross-project isolation in queries and context assembly.
- Summaries and context budgeting for long histories.

**Done when:** `SPEC.md` §18.11 criteria 3 (separate histories, no cross-project context) and 4 pass.

#### Unscheduled (specified, not planned)

- **Global AI** (`SPEC.md` §18.5): conversations without a project. It needs a schema decision, because C1 requires a project.
- **Architecture Decisions** (`SPEC.md` §18.7, `ARCHITECTURE.md` §15.7).

### 8.3 Open questions

Listed in `SPEC.md` §18.12 and `ARCHITECTURE.md` §15.11. Resolve each with a documented decision before building the dependent work:

- per-CLI conversation capabilities and enforceable no-tool profiles (C2: profiles defined and parse-checked; adversarial verification still open);
- capacity sharing with the execution slots (C2: decided, separate conversation slot per CLI);
- summary and context budgeting (C4);
- project disconnect behavior for conversations (C1 refuses disconnect while conversations exist; a decision flow is still open);
- web search, only if Global AI is scheduled.

## 9. Platform strategy and security follow-ups

> Recorded 2026-11-04. These do not renumber or change M0–M7 or the C milestones (§8).

### 9.1 Platform strategy

**macOS-first, cross-platform-ready** (`ARCHITECTURE.md` §16):

- macOS is the only targeted and tested platform. Windows, WSL2 and Linux are possible future platforms, not MVP commitments, and are not implemented now.
- No cross-platform abstraction layers beyond what the code needs today. Platform-specific filesystem behavior, process supervision and sandboxing stay behind their current module boundaries (`packages/database` runtime paths, the `packages/agents` supervisor, security profiles and the gate).
- Shared domain types and business logic must not assume macOS.
- Supporting another platform would be a separate, explicitly planned workstream. It needs its own compatibility and adversarial security verification, and SEC-01 must be re-assessed for that platform.

### 9.2 SEC-01 — Process containment beyond process groups

**Problem.** The supervisor reliably manages the agent CLI's process group, but it cannot guarantee termination of descendants that create their own process group or session. They survive stop and timeout and are not reported. M1-04A demonstrated this with fake CLIs (`ARCHITECTURE.md` §7.4).

**Already in place (M1-04A):**

- `AgentRunResult.processContainment` is always `process_group_only`, and `lingeringProcesses` describes the process group only.
- A regression test documents that a new-session descendant survives stop.
- The `stop_with_subprocesses` diagnostic probe reports survivors explicitly.

**Requirements:**

- Keep the limitation visible in execution results, and later in run events and the UI. Never describe process-group cleanup as complete descendant containment.
- No speculative process-tree tracking (PID scans, name matching, broad kills).
- Choose and verify a containment strategy before **unattended execution of untrusted agent workloads**, at the latest before automatic scheduling (M4) runs agents against real repositories without supervision. *(Amended 2026-11-04 by SEC-02: for operator-trusted repositories under Trusted Local Mode, SEC-01 is an accepted, disclosed risk instead of a prerequisite. It remains a prerequisite for Strict Isolated Mode and for untrusted workloads.)* Candidate mechanisms (dedicated OS user per runtime, OS sandbox policy, VM) need a documented decision, especially where they touch the "no Docker" direction in `AGENTS.md`.

**Done when:**

- A containment mechanism is chosen and documented.
- Supervised real-CLI runs of the `stop_with_subprocesses` probe show no surviving descendants, including new-session ones, for each supported runtime and CLI version.
- Results report the stronger containment scope only once that verification exists.

Until then, the limitation stays documented and visible.

### 9.3 SEC-02 — Trusted Local Execution (personal-use MVP)

> Decided 2026-11-04. Design: `ARCHITECTURE.md` §7.5; product rules: `SPEC.md` §12.1. Stages a–d are implemented (d as a library: the worker integration is part of M4); e is open.

**Decision.** The MVP executes agents in an explicit **Trusted Local Mode**:

- operator opt-in and a versioned disclosure;
- trusted repositories only;
- the existing binding, worktree, version, timeout, output-limit and process-group safeguards;
- a new post-run Git integrity check;
- publishing only through Approve & Push.

The existing fail-closed gate becomes **Strict Isolated Mode**. It stays unchanged and unverified, and it is never silently downgraded.

**Staged implementation** (each stage is a separate, reviewed task; real execution remains disabled until stage E):

| Stage | Scope | Package(s) |
| --- | --- | --- |
| **SEC-02a — Types** *(done 2026-11-04; see `ARCHITECTURE.md` §7.5 implementation notes)* | `ExecutionSecurityMode`; the discriminated `ExecutionSecurityPolicy` (Strict = today's v1 policy with `mode: 'strict_isolated'`, no default mode); `TrustedLocalPolicy`; the discriminated `ExecutionAuthorization` (Strict keeps `controls`; Trusted Local has `controlAssessments`, `acceptedRisks`, `safeguards`, no `enforced` claim); new denial codes. Strict behavior identical. | `core` |
| **SEC-02b — Gate** *(done 2026-11-04; `authorizeTrustedLocalExecution`)* | `authorizeTrustedLocalExecution` sharing the existing preflight (worktree, executable, arguments, deny list, version); trusted-repository identity match; non-root; acceptance and disclosure version; mandatory timeout. `authorizeAgentExecution` unchanged. | `orchestrator` (+ `git` for identity) |
| **SEC-02c — Launch boundary** *(done 2026-11-04; see `ARCHITECTURE.md` §7.5 SEC-02c notes)* | `startAgentExecution` checks the authorization per mode (exhaustive switch). Trusted Local: all binding, freshness and single-use checks, timeout required, non-root re-check; no control-enforcement claim. `securityMode` in events and results. | `agents` |
| **SEC-02d — Git integrity check** *(done 2026-11-04; check and comparison exist, not yet wired into a run; see `ARCHITECTURE.md` §7.5 SEC-02d notes)* | Read-only before/after inventory: branch refs, worktree HEADs, remote-tracking refs, common config and hooks digests, main checkout HEAD and status. Result attached to the run. | `git` |
| **SEC-02e — Trusted Local smoke runs** *(design and runbook 2026-11-05; runner implemented and tested offline in SEC-02e.1; SEC-02e.4 added `--permission-mode acceptEdits` to the Claude profile, so earlier Claude smoke results do not apply: `packages/cli-diagnostics/docs/trusted-local-smoke-runs.md`)* | Operator-approved, **benign** real runs on the host in a disposable local repository (no VM): compatibility checks C-03 to C-13 from the runbook, with captures checked by `replay`. No adversarial probes. | `cli-diagnostics` runbook |
| Persistence and UI | Settings (enable flag, acceptance), project `execution_trust`, run security metadata, mode badge, disclosure page, attention banner. | M2, M3, M7 |

**Tests required before Trusted Local execution may be enabled** (offline: fake CLIs and disposable repositories):

1. **Strict mode unchanged.** The shipped profiles are still denied with `control_not_enforced`; `riskAcknowledgements` still never authorize.
2. **No implicit mode.**
   - A policy without `mode` is invalid.
   - A Strict request never yields a Trusted Local authorization, even after a Strict denial.
   - A Strict authorization never passes the Trusted Local launch checks, and vice versa.
3. **Trusted Local denials:**
   - disabled;
   - acceptance missing or stale (disclosure version);
   - repository not trusted, including the same path with a different common Git directory;
   - worktree not verified;
   - unsafe arguments;
   - executable changed;
   - elevated UID (injected);
   - missing or excessive timeout.
4. **Binding at launch.** Tampered arguments, environment, working directory or executable are rejected for Trusted Local authorizations; authorizations are single-use and expire.
5. **Honest reporting.**
   - A Trusted Local authorization has no `enforced` field.
   - `controlAssessments` equals `assessControl` output.
   - `acceptedRisks` equals the required controls that are not enforced.
   - `securityMode` and `processContainment` appear in events and results.
6. **Run controls in Trusted Local Mode.** Timeout, output limit, stop and process-group cleanup work (fake CLIs). The escaped-descendant limitation stays reported (T1–T3 follow-up).
7. **Git integrity check.** It detects an agent commit in the task worktree, a push to a local bare remote (remote-tracking or remote ref), a common config or hooks change, a main checkout change, and another worktree's HEAD change. It reports no false positive for ordinary file edits inside the task worktree.
8. **Architecture checks.** Conversation code cannot obtain or use an execution authorization. *(C1, 2026-11-06: a static import check in `apps/web/tests/conversations-ui.test.ts` keeps the conversation modules free of the agents, Git, orchestrator, execution, worker-command and task-command modules. C2, 2026-11-07: extended by `apps/worker/tests/conversation-boundaries.test.ts` to the worker, gate, launch and persistence conversation code; the separate authorization types are rejected by the other launch boundary in tests.)*

**Exit criteria.**

- All tests above pass, and the SEC-02e smoke runs are recorded.
- The disclosure text is reviewed by the operator.
- Execution is enabled only through Settings by the operator.

### 9.4 Deferred: Strict Isolated Mode and VM-based verification

- **M1-04B.2 (supervised real-CLI verification in a disposable macOS VM) is deferred.** Its plan and runbook remain valid: `packages/cli-diagnostics/docs/real-cli-verification.md`. The VM preparation (M1-04B.2a) was planned but not carried out.
- **Strict Isolated Mode** becomes available only after verified enforcement exists for every required control. That needs:
  - VM-based adversarial verification;
  - OS-level mechanisms for the controls the CLIs cannot cover (credential isolation, subprocess coverage);
  - SEC-01.
- The G2 real-CLI diagnostic runner and the SEC-01 regression tests T1–T3 stay deferred follow-ups.
