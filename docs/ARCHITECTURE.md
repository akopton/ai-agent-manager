# AI Agent Manager — Technical Architecture

**Status:** Draft v0.12 — C4.2 nonignored untracked source discovery; v0.11 — C4.1 descriptor-anchored working-tree source reads; v0.10 — C4 project-aware conversations with controlled source-code context (§15.4 "C4", §15.10, §15.11); v0.9: C3.1 source-scoped proposal generation (§15.3, §15.8, §15.10); v0.8: AI Conversations C3 implementation notes: task proposal generation, editing and approval (§15.3, §15.8, §15.10, §15.11); v0.7: AI Conversations C2 implementation notes (§15.6, §15.10, §15.11) and the model catalog (§7.2); v0.6: AI Conversations C1 implementation notes (§15.3, §15.10); v0.5: TM-02 task archiving and managed worktree cleanup (§5.1, §8); v0.4 added execution security modes SEC-02 (§7.5); v0.3 added platform strategy (§16) and SEC-01 (§7.4); v0.2 added AI Conversations (§15)\
**Date:** 2026-11-07 (v0.8: 2026-11-07, v0.7: 2026-11-07, v0.6: 2026-11-06, v0.4: 2026-11-04, v0.1: 2026-11-03)  
**Product specification:** [`SPEC.md`](./SPEC.md) v0.12\
**Scope:** Single-user, local-first MVP

> This document describes **how** we intend to implement the requirements in `SPEC.md`. Where implementation details are not yet proven, they are called out as validation gates rather than assumed capabilities.

## 1. Architecture goals

1. Make local Git repositories available as independent projects and keep their normal checkouts untouched.
2. Execute one Claude Code task and one Codex task concurrently at most (configurable later).
3. Keep task queue state, execution history, review decisions, and Git publishing operations durable across restarts.
4. Preserve generated files on Stop, failure, and interruption.
5. Prevent agent-produced changes from being published before explicit user approval.
6. Support selecting an agent runtime and optional model **per task**; do not create named agent profiles in MVP.
7. Keep the web UI independent of provider-specific agent output and execution details.
8. Avoid unnecessary infrastructure: no hosted database, Redis, Docker, or remote workers required for MVP.
9. *(Planned, §15.)* Support AI Conversations in a global or project scope through the same adapters, with separate runtime policies, and without giving conversations authority to modify repositories, start agents, or publish.

## 2. Runtime topology

```text
Browser (127.0.0.1)
    |
    | HTTP REST + SSE
    v
Next.js web process (Node.js)
    |                  \
    | SQLite            \ read-only queries / command API
    v                    v
SQLite DB <--------> Local worker process (Node.js)
                          |
                    Global scheduler
                          |
                     Agent registry
                     /           \
               Claude CLI      Codex CLI
                     \           /
                      Task worktrees
                            |
                   Git CLI / local remotes
                       GitHub or Gitea
```

- **Web process:** UI, REST endpoints, SSE subscriptions, input validation, read operations, and submission of durable commands.
- **Worker process:** owns scheduling, run claims, child process supervision, stop requests, reconciliation, and Git mutations.
- **SQLite:** authoritative store for tasks, runs, queue claims, reviews, and publishing state. Use WAL mode, foreign keys, and a `busy_timeout` in both processes.
- **Communication:** web writes command records (or transactional state changes) into SQLite; worker polls/wakes to process them. Worker writes persistent events, which the web process forwards over SSE. Prefer this to maintaining untracked in-memory queues.
- Bind HTTP to `127.0.0.1` by default and validate `Origin` on all state-changing endpoints. The local application has no login UI, but **localhost does not imply an unauthenticated API is safe from other websites**.

The simplest development setup runs `web` and `worker` as two supervised processes through one pnpm command. Production local startup and graceful shutdown behavior will be addressed before calling the MVP complete.

## 3. Repository structure

```text
ai-agent-manager/
  apps/
    web/                        # Next.js App Router, screens, REST, SSE
    worker/                     # Scheduler, jobs, process lifecycle
  packages/
    core/                       # Domain types, enums, Zod schemas
    database/                   # Drizzle schemas, migrations, database access
    agents/                     # AgentAdapter contract + Claude/Codex adapters
    git/                        # Repositories, worktrees, review snapshots, publish
    orchestrator/               # Scheduling policy, run state machine, commands
  docs/
    SPEC.md
    ARCHITECTURE.md
    IMPLEMENTATION_PLAN.md      # Created next
  poc/                          # Preserved experimental scripts, not production code
  AGENTS.md
  README.md
  pnpm-workspace.yaml
  package.json
  pnpm-lock.yaml
  .gitignore
```

`packages/core` must not import framework or infrastructure code. Agent adapters must not import Next.js, Drizzle, or UI components. The worker composes the adapters, Git services, scheduler, and repositories.

The planned AI Conversations module (§15.1) initially reuses these packages. This is the preferred starting point, not a prohibition: a dedicated package may be introduced later if clear modularity or dependency boundaries justify it.

## 4. Domain model and SQLite tables

Use Drizzle ORM with SQLite. Generate IDs in the application (e.g., UUID or ULID); do not use user-facing task numbers as primary keys. Store timestamps consistently (Unix milliseconds or ISO-8601 UTC; choose one and apply everywhere). Add foreign keys, indexed status columns, and unique constraints.

Planned conversation, decision and task-proposal tables are described in §15.3 and are not part of the MVP schema.

| Table | Essential fields | Notes |
|---|---|---|
| `projects` | `id`, `name`, `local_path`, `remote_name`, `default_base_branch`, `priority`, `instructions`, timestamps | `local_path` is a canonicalized absolute path; prevent duplicate connections to same repository. |
| `tasks` | `id`, `project_id`, `title`, `prompt`, `agent_runtime`, `model_id` nullable, `base_branch`, `priority`, `urgent`, `status`, `queued_at`, timestamps | Runtime identifiers are data, not provider-specific database tables. `model_id = NULL` means `Default`. *(TM-02, migration `0007_task_archive_cleanup`: nullable `archived_at`, the archive visibility flag; `NULL` = active. Not a status.)* |
| `task_runs` | `id`, `task_id`, `attempt`, `agent_runtime`, `requested_model_id`, `effective_model_id` nullable, `status`, `session_id` nullable, `started_at`, `ended_at`, `exit_code`, `signal`, `error_code`, `summary` | Snapshot runtime/model for each attempt. `(task_id, attempt)` unique. |
| `workspaces` | `id`, `task_id`, `attempt_or_generation`, `path`, `branch`, `base_ref`, `base_sha`, `status`, timestamps | Support retained workspaces across safe retries; never assume task names are unique. *(Implemented with `generation`, `repository_root`, `git_common_dir`, `worktree_root`; `status` is `retained` only (CHECK). Rows are never deleted; a removed worktree is recorded in `workspace_cleanups`.)* |
| `run_events` | `id`, `run_id`, `sequence`, `kind`, `payload_json`, `created_at` | Store normalized events. Sequence unique per run; redact secrets and cap output size. |
| `reviews` | `id`, `task_id`, `run_id`, `workspace_id`, `snapshot_hash`, `snapshot_manifest_json`, `status`, `feedback` nullable, timestamps | Review is tied to a specific filesystem snapshot, not only a task. *(M6-02, migration `0004_reviews`: implemented without the snapshot columns, which arrive with the Approve & Push snapshot; adds `inventory_revision` (the change-inventory revision the reviewer saw) and `follow_up_run_id` (the attempt that continued from a change request). `status` is `changes_requested` only so far.)* |
| `git_operations` | `id`, `task_id`, `review_id`, `kind`, `status`, `commit_sha` nullable, `remote`, `branch`, `error_json` nullable, timestamps | Durable, retryable commit and push operations. *(M6-03, migration `0005_publications`: references `publications` (`publication_id`) instead of `review_id`; one row per commit and per push attempt, with `attempt`, `outcome`, `error_code`/`error_message`.)* |
| `publications` *(M6-03)* | `id`, `request_id` unique, `task_id`, `run_id`, `workspace_id`, `status`, `failure_stage`, `inventory_revision`, `snapshot_hash`, `snapshot_json`, `base_commit`, `branch`, `remote_name`, `remote_url` (redacted), `remote_url_digest`, `commit_message`, `commit_sha`, `tree_sha`, timestamps | The Approve & Push decision, its review snapshot and publish state. Holds the documented `reviews.snapshot_*` fields, because `reviews.status` has a CHECK that only an additive table can extend. At most one active publication per task (partial unique index). |
| `workspace_cleanups` *(TM-02)* | `id`, `request_id` unique, `task_id`, `workspace_id`, `status` (`requested`/`removing`/`removed`/`failed`), `basis` (`published`/`discarded_unchanged`), `task_status` (`done`/`discarded`), `expected_commit`, `branch_commit`, `error_code`, `error_message`, `worker_instance_id`, timestamps, `removed_at` | One row per confirmed Remove local worktree request and its outcome. Additive table, because `workspaces.status` has a CHECK that only `retained` passes. At most one requested, running or completed removal per workspace (partial unique index); `failed` rows remain as history. Migration `0007_task_archive_cleanup`. |
| `scheduler_settings` | single row: `paused`, `mode`, `global_limit`, `claude_limit`, `codex_limit`, `updated_at` | Defaults: auto, global 2, per-runtime 1. Limits must be enforced by reservations. |
| `worker_leases` / `commands` | `id`, owner/lease expiry or command kind/payload/status, timestamps | Track process ownership, stop/publish commands, and restart reconciliation. Final schema chosen during implementation. |

**Constraints and indexes**

- Index `tasks(status, queued_at)`, `tasks(project_id, status)`, `task_runs(task_id, attempt)`, and `run_events(run_id, sequence)`.
- Store a task's branch/workspace association explicitly; don't infer it by scanning directory names.
- Use uniqueness / leases to ensure only one active run per task and runtime capacity is reserved atomically.
- Persist *only metadata* in SQLite. Source code remains in Git and worktrees; do not store CLI auth tokens or provider passwords in the DB.
- Keep `task.status`, `task_run.status`, and publishing state separate, because a task can be awaiting a failed push even after its agent has completed.

## 5. Task state machines

### 5.1 Product-level task states

`Backlog -> Queued -> In Progress -> Review -> Done`

Additional states: `Stopped`, `Interrupted`, `Failed`, `Discarded`.

- **Create**: task starts `Backlog`; no worktree created.
- **Queue**: explicit user action (`Queued`).
- **Claim**: worker reserves capacity, creates/validates the workspace, transitions to `In Progress`.
- **Successful execution**: transition to `Review` even if no changes were made; show truthful execution outcome.
- **Stop**: `Stopping` as an internal transient run state, then `Stopped` after confirming termination; preserve files.
- **Crash**: reconcile any previously active runs; mark unreconciled `Interrupted`, never auto-resume.
- **Request Changes**: record feedback and enqueue a new run on the retained branch/workspace.
- **Discard**: mark `Discarded`; keep workspace until explicit cleanup.
- **Approve**: freeze/validate reviewed snapshot, commit, push, then transition to `Done`.

Implement transitions through named domain methods / transactions; reject invalid actions rather than setting arbitrary statuses directly.

**TM-01 implementation notes (2026-11-05, Retry, Resume & Discard).**

- **Eligibility.** Retry from `Failed`; Resume from `Stopped` and `Interrupted`; Discard from `Review`, `Stopped`, `Interrupted`, `Failed` (the domain's `discard`). The domain table also allows `retry` from Stopped/Interrupted; TM-01 deliberately offers only one recovery per state, because both continue in the same worktree. All three are refused while a run is active or an Approve & Push publication holds the task, and for a stale attempt (`runId` must be the latest run).
- **Decision record.** `task_recoveries` (migration `0006_recoveries`, additive) stores one Retry/Resume per source run: kind, source run and status, retained workspace (or none), the latest review whose feedback is still unaddressed, how a prior process was ruled out, and `follow_up_run_id` (bound by the claim, at most one pending per task). The record and the named `retry`/`resume` transition (→ Queued) share one transaction; no start request is created. Discard is the named `discard` transition only; nothing is deleted.
- **Workspace continuation.** One worktree per task is kept. Before recording, the web process re-verifies the retained worktree read-only (`verifyRetainedTaskWorktree`, `packages/git`: record matches task/repository, Git confirms a locked linked worktree at the managed location, on the task branch, HEAD and branch at the base SHA) and refuses with `workspace_unavailable` otherwise; nothing is reset, cleaned, moved or recreated. The worker repeats the check before launch (as for Request Changes). A source attempt that ended before a worktree existed gets a new one on the next Start.
- **Prior process.** If the source run recorded a PID, its process group is probed with signal 0 (`isProcessGroupAlive`, fail-closed) at request time and again in the claim; a live group refuses the request or the start (task stays Queued). If a restarted worker reconciled the run after authorization but before a PID was recorded, the operator must confirm that no agent is running; the claim requires that recorded confirmation. Descendants outside the process group (SEC-01) are not covered.
- **Prompt.** Original prompt; the latest review feedback when a change request preceded the failed follow-up; and a note that this is a new attempt in a new agent session that continues from the existing changes. Native CLI session resume is not used. The claim, consent re-read, trust, per-runtime limit, gate, launch boundary, Stop, timeout, reconciliation and post-run integrity check are unchanged.
- **Accepted v1 semantics (decided 2026-11-05, `SPEC.md` §11).** Retry and Resume both continue the retained worktree and start a new agent session; nothing is reset or overwritten. Retry from scratch (fresh workspace) and native CLI session resume are future capabilities and would need a second-workspace or adapter-session design.

**TM-03 notes (2026-11-06, Manual Task Management v1 lifecycle QA).**

- **Withdrawn start requests.** `transitionTask(return_to_backlog)` rejects the task's pending `worker_commands` row (`task_not_queued`) in the same IMMEDIATE transaction. Before, a request left by a stopped worker stayed pending for up to 5 minutes and could be claimed after the task was queued again, without a new Start.
- **Base branch fixed by the worktree.** `updateTask` refuses a base-branch change (`task_not_editable`, `details.field = 'baseBranch'`) once the task has a workspace record, because follow-up and recovered attempts continue in the retained worktree and never read `tasks.base_branch`. The edit page disables the field and names the worktree's base.
- **Journeys.** `apps/worker/tests/lifecycle-journeys.test.ts` runs complete v1 journeys end to end (fake CLIs, disposable repository and bare remote): Request Changes → failure → Retry → Stop → Resume → Approve & Push with a failed push and Retry push → Archive → Remove local worktree → Restore; Discard → Archive/Restore with a fail-closed cleanup; and Start → Return to Backlog → Queue without execution.

**TM-02 implementation notes (2026-11-06, Task Archiving; accepted v1 semantics in `SPEC.md` §7.1).**

- **Not a state.** Archive sets `tasks.archived_at`; Restore clears it. No named transition is applied and no other column (including `updated_at`) or table changes. Rules in `packages/core/src/task-archive.ts`; commands `archiveTask`/`restoreTask` in `packages/database/src/task-archive.ts`, each one IMMEDIATE transaction that re-reads the facts; both are idempotent.
- **Eligibility.** Status `backlog`, `done`, `discarded`, `failed`, `stopped` or `interrupted`; no active run, no pending start command, no blocking publication (`findBlockingPublication`), no requested/removing worktree cleanup. Otherwise `task_not_archivable` (409).
- **Guard.** `transitionTask` refuses every operator action on an archived task with `task_archived`, and `updateTask` refuses edits. Run-outcome actions (`complete_execution`, `stop`, `fail`, `interrupt`, `mark_done`) are not blocked so a run can never lose its outcome; archiving requires that no run is active, so they do not meet an archived task in practice.
- **Visibility.** The board page partitions tasks into active and archived (`?view=archived`); project counts exclude archived tasks and report them separately. Board cards offer Archive for Done and Discarded tasks; the task page offers Archive (or the reason it is unavailable) for every task and Restore for archived ones, and hides lifecycle actions while archived.
- **Routes.** `POST …/tasks/:taskId/archive` and `…/restore`, body-less, with the usual loopback Host and same-origin guards.

### 5.2 Execution state versus publishing state

`Run`: `pending | starting | running | stopping | completed | stopped | failed | interrupted`.

`Publish`: `not_requested | reviewing | committing | committed_pending_push | pushing | pushed | failed`.

A successful commit followed by a failed push must leave the task review/publishing path recoverable; **do not create a duplicate commit when retrying push**.

## 6. Global scheduler and queue

A single worker scheduler evaluates all queued tasks. Candidate order:

1. `urgent DESC`
2. `project.priority ASC` (smaller number = higher priority)
3. `task.priority` (`Critical`, `High`, `Normal`, `Low`)
4. `queued_at ASC`, then task ID for deterministic ties

Scheduler skips tasks whose runtime is at capacity so a busy Claude doesn't block an available Codex. `Pause Queue` prevents new claims but never kills existing runs.

**Atomic claim algorithm** (one SQLite write transaction):

1. Verify scheduler is not paused and task remains `Queued`.
2. Count valid runtime/global active reservations and inspect worker lease state.
3. Reserve capacity and change the run/task to starting state.
4. Commit transaction; only then start a process.
5. On process startup error, release reservation and persist failure.

Use a single elected worker for MVP to simplify concurrency. Still make claims and commands idempotent to survive restarts; do not rely on a JS `Map` as the source of truth. Avoid holding write transactions while launching CLIs, fetching Git, or reading files.

Manual execution mode means explicitly starting an eligible task; automatic mode claims queued tasks whenever capacity frees up. Never automatically restart `Stopped` or `Interrupted` runs.

## 7. Agent adapters and model selection

### 7.1 Contract

```ts
type AgentRuntime = 'claude' | 'codex';

type AgentStartInput = {
  runId: string;
  workingDirectory: string;
  prompt: string;
  modelId: string | null;     // null = CLI default
  instructions: {
    global: string;
    project: string;
  };
  resumeSessionId?: string;
};

type AgentEvent =
  | { type: 'started'; runId: string; timestamp: string }
  | { type: 'output'; runId: string; text: string; timestamp: string }
  | { type: 'metadata'; runId: string; sessionId?: string; effectiveModelId?: string }
  | { type: 'completed'; runId: string; exitCode: number | null; summary?: string }
  | { type: 'failed'; runId: string; code: string; message: string }
  | { type: 'stopped'; runId: string; signal?: string };

interface AgentAdapter {
  readonly runtime: AgentRuntime | string;
  checkAvailability(): Promise<{ available: boolean; reason?: string }>;
  start(input: AgentStartInput, emit: (event: AgentEvent) => void): Promise<AgentHandle>;
  capabilities(): { resume: boolean; structuredEvents: boolean };
}

interface AgentHandle {
  stop(): Promise<void>;
  completed: Promise<{ exitCode: number | null; signal?: string }>;
}
```

The contract is illustrative, not yet production API. Adapter-specific stdout/stderr and event JSON are normalized before storage and SSE delivery. Always capture bounded log output and distinguish process exit from task correctness.

### 7.2 Model behavior

- Task stores `agent_runtime` (`claude` or `codex`) and optional `model_id`.
- `NULL` means **no model override sent to CLI**; the CLI decides.
- Runtime changes reset incompatible explicit model selections.
- Store requested model on task run creation, and effective model only when surfaced by trustworthy CLI metadata.
- Maintain a small versioned candidate model list per runtime; actual availability is checked by execution and provider error handling. Don't promise an authoritative list without a supported discovery API.
- *C2 (2026-11-07):* the list exists as `modelCatalog` in `packages/core/src/model-catalog.ts` (`modelCatalogVersion`), used by one selector (`apps/web/components/models/model-select.tsx`) in the task and conversation forms. Discovery decision: Claude Code 2.1.317 has no machine-readable model listing; Codex CLI 0.166.0 prints its raw catalog with `codex debug models --bundled` (offline JSON), but that is a `debug` command, not a documented interface, so the application never runs or parses it. The Codex entries were taken from it once (`visibility: "list"`, by `priority`); the Claude entries are the documented aliases (`fable`, `opus`, `sonnet`, plus `haiku`) and pinned names. `describeModelSelectionProblem` refuses a model listed only for the other runtime and malformed identifiers; it runs in the task and conversation database commands (only when the runtime or model changes, so stored custom identifiers stay editable) and in the forms.
- Never silently fall back to another model after an unsupported-model error.
- All models for one CLI share that runtime's concurrency limit.

### 7.3 Process management and permissions

Run CLI processes with `spawn` argument arrays (`shell: false`) and the worktree as `cwd`. Do not shell-interpolate user prompts, paths, branch names, or model IDs.

On macOS/POSIX, the PoC used a dedicated process group and `SIGTERM`, followed by `SIGKILL` after a grace period. Production logic must confirm process-group termination, handle races and retries, persist stop intent first, and release runtime capacity only after final reconciliation. Process-group termination is **not** complete descendant containment; see §7.4.

**Security gate:** Worktrees are *not* sandboxes. CLI flags and prompt-level instructions do not conclusively prevent an agent from running Git commits/pushes or accessing files outside its worktree. Before using company repositories, determine and test actual permission enforcement for each CLI (including tool policies, sandboxing, network and Git credential access). If hard guarantees cannot be established locally, document the limitation clearly and require explicit user acknowledgement rather than claiming full enforcement. Keep publication logic in a separate trusted service; reduce credentials/external side effects where practical. For the personal-use MVP this acknowledgement is realized as the explicit, typed **Trusted Local Mode** (§7.5), not through `riskAcknowledgements`.

### 7.4 Process containment beyond process groups (SEC-01)

**Current guarantee.** The supervisor in `packages/agents` starts each CLI as the leader of its own process group. Stop, timeout and output-limit termination send `SIGTERM` and then `SIGKILL` to that group. After the CLI exits, anything left in the group is terminated the same way. This is reliable for descendants that **stay in the group**.

**Limitation.** A descendant that creates its own session or process group (`setsid`, `setpgid`; for example a daemonizing tool, a background server or a deliberately evasive agent) is outside the group. It survives stop and timeout, and the supervisor neither sees nor reports it. M1-04A demonstrated this with fake CLIs. After a requested stop, the supervisor reports `lingeringProcesses: 'none'` (its group is empty) while the escaped descendant is still running. On macOS there is no unprivileged mechanism to contain a process tree (no cgroups; PID scans are racy and evadable).

**Rules until SEC-01 is resolved:**

- Execution results must keep this limitation visible. `AgentRunResult.processContainment` is always `process_group_only`, and `lingeringProcesses` describes the process group only. UI, logs and docs must not describe a stopped run as "all processes terminated" or call process-group cleanup complete descendant containment.
- Do not add speculative process-tree tracking (PID scans, name matching, broad kills) that would create a false sense of security.
- Unattended execution of untrusted agent workloads requires a **verifiable** containment strategy first. Candidates to evaluate include a dedicated OS user per runtime, whose processes can all be ended, an OS sandbox policy, or a VM. Each would need a documented decision, especially where it touches the "no Docker" direction in `AGENTS.md`. A candidate counts as verified only when supervised real runs of the `stop_with_subprocesses` probe (`packages/cli-diagnostics`) show no surviving descendant, including those in a new session.
- The mechanism lives behind the process-supervision boundary in `packages/agents` and is platform-specific (§16).
- *Decision 2026-11-04 (SEC-02):* repositories the operator trusts and runs under Trusted Local Mode (§7.5) are not "untrusted workloads" in this sense. There, SEC-01 is an **accepted, disclosed risk**, not a prerequisite. SEC-01 remains a prerequisite for Strict Isolated Mode and for any untrusted workload.

### 7.5 Execution security modes (SEC-02)

> Design decided 2026-11-04 for the personal-use MVP. **Partly implemented:** contracts (SEC-02a), gate (SEC-02b), launch boundary (SEC-02c) and the Git integrity check (SEC-02d, not yet wired into a run lifecycle) exist; the smoke runs (SEC-02e) do not. No worker, scheduler or UI calls them yet, so nothing executes agents (`IMPLEMENTATION_PLAN.md` §9.3). Strict Isolated Mode stays fail-closed.

**Threat model** (`SPEC.md` §12.1):

- One trusted operator on their own macOS account, with trusted repositories and the CLIs they already use manually.
- The agent is **not** trusted: model mistakes, overreach, and prompt injection from repository content, dependencies or tool output.
- It runs with the operator's account permissions: file system, credentials, network.

**Two modes, one typed discriminant.** The domain types live in `packages/core`. Neither mode contains OS-specific mechanisms; those stay in the profiles and the supervisor in `packages/agents`.

```ts
type ExecutionSecurityMode = 'strict_isolated' | 'trusted_local';

// Existing v1 policy, unchanged apart from the discriminant.
type StrictIsolatedPolicy = {
  mode: 'strict_isolated'; version: 1;
  workspaceAccess: 'task_worktree_only'; network: 'deny' | 'allow';
  interactiveApproval: 'deny'; gitMutations: 'deny';
  riskAcknowledgements: { control: SecurityControl; reason: string }[]; // informational only
};

type TrustedLocalPolicy = {
  mode: 'trusted_local'; version: 1;
  // Versioned operator acceptance of the Trusted Local disclosure (from Settings).
  acceptance: { disclosureVersion: string; acceptedAt: string };
  interactiveApproval: 'deny';       // runs stay unattended and non-interactive
  timeoutMs: number;                 // mandatory, bounded
};

type ExecutionSecurityPolicy = StrictIsolatedPolicy | TrustedLocalPolicy; // `mode` required, no default

type StrictExecutionAuthorization = {
  mode: 'strict_isolated'; /* existing fields */
  controls: AuthorizedControl[]; // every required control `enforced`, as today
};

type TrustedLocalExecutionAuthorization = {
  mode: 'trusted_local';
  runtime; runtimeVersion; launchProfileId; launchArguments;
  invocation: AuthorizedInvocation;        // executable identity, every argument, env digest
  workspace: VerifiedWorkspace;            // same verification as strict
  policy: TrustedLocalPolicy;
  trustedRepository: { root: string; commonDir: string; trustedAt: string };
  // Honest assessment from `assessControl`, never upgraded. There is deliberately NO
  // `controls`/`enforced` field, so the result cannot be read as an enforcement claim.
  controlAssessments: ControlAssessment[];
  acceptedRisks: SecurityControl[];        // required strict controls that are not enforced
  safeguards: TrustedLocalSafeguard[];     // what was actually applied (list below)
  processContainment: 'process_group_only';
  checkedAt: string;
};

type ExecutionAuthorization = StrictExecutionAuthorization | TrustedLocalExecutionAuthorization;
```

**SEC-02a implementation notes (shared contracts, `packages/core`).** The contracts above exist as Zod schemas with inferred types. They differ from the sketch in four deliberate ways:

- **Naming.**
  - `ExecutionSecurityPolicy`, `executionSecurityPolicySchema` and `ExecutionAuthorization` keep their pre-SEC-02 names as **strict-only** aliases of `StrictIsolatedPolicy` and `StrictExecutionAuthorization`, so the strict gate and launch boundary did not change.
  - The unions are `SecurityModePolicy` / `securityModePolicySchema` and `SecurityModeAuthorization` / `securityModeAuthorizationSchema`.
- **The Trusted Local policy lists `acceptedRisks`** (what the operator accepted). The authorization's `acceptedRisks` (the controls actually not enforced) must be a subset.
- **Both authorizations carry an `authorizationId` (UUID)** besides `checkedAt`. The strict gate generates it. Since SEC-02c the launch boundary enforces single use by this ID in both modes.
- **Schema invariants:**
  - every control is assessed exactly once;
  - accepted risks equal the unenforced assessments;
  - the mandatory safeguards are present (`post_run_git_integrity_check` stays optional until the worker applies it; see the SEC-02d notes);
  - the workspace matches the trusted repository identity;
  - the invocation starts with the launch arguments.

**SEC-02b implementation notes (Trusted Local gate, `packages/orchestrator`).**

- **API.** `authorizeTrustedLocalExecution(request, trustedState)` is a separate function from `authorizeAgentExecution`. It shares the strict gate's preflight (`verifyWorkspace`, `verifyExecutable`, the deny list), which is exported internally.
- **Trusted state.** `trustedState` (`TrustedLocalState`: `enabled`, `currentDisclosureVersion`, the recorded `acceptance` with its `acceptedRisks`, `trustedRepositories`) is a separate argument. It is injected until settings persistence exists (M2/M3). Request fields cannot grant trust or acceptance, and unknown request fields are rejected.
- **Invocation re-preparation.** The gate re-prepares the invocation with the shipped adapter, from the detected `installation`, the request's `modelId` and the launch environment. The arguments, environment digest, executable identity and working directory must match exactly.
- **Version support.** CLI version support uses the adapters' discovery minimums (`isSupportedCliVersion` in `agents`).
- **Control assessments** come from the shipped profile (`getRuntimeSecurityProfile`) through `assessControl`, never from the request.
- **Clock, UID and environment** are dependencies of an internal factory (`createTrustedLocalGate`, tests only). The public function uses the real clock, `process.geteuid()` and `process.env`; an unknown effective UID is denied.
- **Additional denial codes:** `acceptance_invalid` (the policy's acceptance differs from the recorded one, lists unrecorded risks, or is future-dated), `risk_not_accepted` and `cli_version_unsupported`.
- **Safeguards recorded:**
  - verified at authorization: `invocation_binding`, `worktree_verification`, `allow_listed_environment`, `non_root`;
  - bound as obligations of the Trusted Local launch boundary (enforced since SEC-02c): `mandatory_timeout`, `output_limits`, `process_group_stop`;
  - not yet recorded: `post_run_git_integrity_check` (until the worker runs it; see the SEC-02d notes).
- **Run binding (added in SEC-02c).** The request carries `run: { runId, prompt }`. The gate re-prepares the invocation for that run and prompt instead of a probe prompt, and binds the authorization to them (below).

**SEC-02c implementation notes (launch boundary, `packages/agents`).**

- **Explicit mode.** `StartAgentExecutionInput` requires `securityMode`, and `authorization` is the `SecurityModeAuthorization` union. The boundary validates the authorization against the full SEC-02a contract first, so malformed and mixed-mode objects are refused. A `securityMode` that differs from `authorization.mode`, or is missing, is refused with `mode_mismatch`. An exhaustive `switch` on `mode` follows. Nothing is inferred, converted or retried in another mode.
- **Strict Isolated path:** unchanged checks (runtime, version, profile, every required control enforced in the authorization **and** the shipped profile, freshness, working directory). Single use is now tracked by `authorizationId`, so copies and deserialized forms are refused as well. Shipped profiles are still unverified, so every strict launch is still refused.
- **Provenance (Trusted Local).** A schema proves shape, not origin. `packages/agents` keeps an in-memory **issuance registry**:
  - The orchestrator's gate claims the registry's issuer capability once, when its module loads (`claimTrustedLocalIssuer` returns `null` to every later caller). The issuer is exported only from the subpath `@ai-agent-manager/agents/trusted-local-issuer`, not from the main entry point, and ESLint allows that import only in `packages/orchestrator/src/trusted-local-gate.ts`. It registers each authorization it issues: a canonical digest of the authorization, the `runId`, and a SHA-256 digest of the prompt. The prompt itself is never stored, and the authorization contains neither the prompt nor its digest.
  - The launch boundary **redeems** the authorization by ID before any other check and removes the entry. It then requires an identical digest and the same `runId` and prompt. Unregistered (hand-built, deserialized, REST, database), altered, reused, copied and expired authorizations are refused. A failed attempt uses the authorization up.
  - Limits: at most 256 unredeemed entries. An entry is unusable after 65 s (the 60 s freshness limit plus 5 s skew) or when the clock moved backwards. When the registry is full, the gate denies (`inspection_failed`).
  - **Process scope.** The registry lives in memory, so the gate and the launch must run in the same process (the future worker), and a restarted worker invalidates every outstanding authorization. Package import order does not matter: only the gate claims the issuer (tested in fresh processes for both orders). Two copies of `@ai-agent-manager/agents` in one process, for example mixed `dist` and `src` resolution, would have separate registries, and every Trusted Local launch would then fail closed.
  - **This is in-process provenance, not protection against hostile code already running in the worker process.** Such code could claim the issuer before the gate (every Trusted Local authorization is then denied: fail closed, tested), import internal modules, or spawn processes itself. The mechanism protects against untrusted **data** crossing a boundary: forged, deserialized, copied or replayed authorizations.
- **Trusted Local launch checks** (after redemption): the shipped adapter instance for the runtime; the installation's runtime and version equal the authorization's, and the version is supported (`isSupportedCliVersion`); the launch profile ID and arguments; `controlAssessments` equal to `assessControl` on the shipped profile (never upgraded); the acceptance is not later than `checkedAt` or the current time; freshness (60 s, by the boundary's own clock; a caller-supplied `now` is refused); the request's working directory equals the authorized one and lies inside the authorized worktree; and then the shared binding checks for both modes (executable identity re-read from disk, every argument, model, environment digest, canonical `cwd`). The disclosure version's currency and repository trust are checked by the gate against trusted state, which the launch boundary does not have. Provenance makes that check binding.
- **Runtime safeguards (Trusted Local)**, refused with the given code when they cannot be applied:
  - the policy's `timeoutMs` always applies, and a different `request.timeoutMs` is refused;
  - execution limits may only be tightened: finite, positive and at most the defaults (`safeguard_unavailable`);
  - process-group stop must be available on the platform; it is not on Windows (`safeguard_unavailable`);
  - an authorization that lists `post_run_git_integrity_check` is refused until the check is wired into the run lifecycle (`safeguard_unavailable`);
  - the effective UID is checked again and must be known and non-zero (`elevated_privileges`).

  Output limits, SIGTERM/SIGKILL escalation, termination after a throwing `emit`, and `processContainment: 'process_group_only'` come from the existing supervisor, unchanged.
- **Events and results.** The `started` event carries `securityMode` and `processContainment`. `AgentRunResult` carries `securityMode` next to the existing `runId`, `runtime` and `processContainment`, and terminal events carry it through `result`. Other events keep their envelope (`runId`, `runtime`, `sequence`). Prompts, environment values and tool inputs are still never emitted.
- **Not persisted yet.** The run metadata listed below (`task_runs.security_mode`, `accepted_risks_json`, ...) needs the M2 run tables. Until then, the caller receives `securityMode` and `processContainment` in events and results, and the authorization carries the rest.
- **Test-only factories.** `createAgentExecutionLauncher` (clock, effective UID, process-group support) mirrors `createTrustedLocalGate`, and `createIssuanceRegistry` (clock, lifetime, capacity) exists for expiry and capacity tests. None is exported from a package entry point.
- **Diagnostics entry point.** `@ai-agent-manager/agents/diagnostics` exports the raw process supervisor, which spawns any executable **without** any authorization, profile or deny-list check. It is not protected by either security gate. Its only consumer is `packages/cli-diagnostics` (development tooling, fake CLIs only). No application package (`apps/worker`, `apps/web`) depends on `agents`, `orchestrator` or `cli-diagnostics`, so no browser API or worker task path can reach it. ESLint forbids importing it elsewhere, and also forbids reaching into `agents/src` or `agents/dist` by relative path. That is a static rule, not a runtime boundary: dynamic `import()` and `require` are not covered. Closing the subpath export would mean moving the supervisor into the diagnostics package, which is deferred.

**Breaking contract change:** a strict policy now **requires** `mode: 'strict_isolated'`. A policy without a mode is `policy_invalid`, never interpreted as either mode. Strict outcomes are otherwise unchanged; every shipped-profile execution is still denied.

**Mode selection and no silent downgrade.**

- The worker builds the policy only from persisted operator state:
  - a global `trustedLocal.enabled` setting (default off);
  - the current disclosure acceptance;
  - the project's execution trust (`none`, the default, or `trusted_local`).

  Task fields, REST bodies and browser input never select a mode.
- The mode is snapshotted when the run is claimed. A Strict denial is final for that run. Retrying after the operator changes settings is a new attempt, never an automatic fallback.
- Separate gate entry points share one preflight:
  - `authorizeAgentExecution` (Strict, unchanged semantics);
  - `authorizeTrustedLocalExecution`.

  Both return a decision tagged with the requested mode. The launch boundary checks the authorization per mode, using an exhaustive switch on `mode`.

**Trusted Local authorization conditions** (all required; denial otherwise):

| Check | Source |
| --- | --- |
| Trusted Local is enabled globally, and the acceptance matches the current disclosure version | Settings (M2) |
| The repository is trusted, matched by **canonical root and common Git directory**, not by path alone | Project record (M2/M3) |
| The task worktree is verified: registered, locked, on the expected branch, at the expected base | Existing gate preflight |
| The executable is canonical and has the expected file identity; the CLI version is detected and at least the assessed minimum; the launch arguments are the profile's and pass the deny list; the environment digest and working directory are bound | Existing gate and launch boundary |
| The process is not elevated: effective UID ≠ 0 (checked at authorization and again at launch) | New, platform-specific helper |
| A timeout is set and within the maximum; output limits apply | Policy + `ExecutionLimits` |
| The authorization is fresh and single-use | Existing launch boundary |

New denial codes:

- `trusted_local_disabled`;
- `acceptance_missing` / `acceptance_stale`;
- `repository_not_trusted`;
- `elevated_privileges`;
- `timeout_required`.

**Safeguards** (`TrustedLocalSafeguard`):

- `invocation_binding`;
- `worktree_verification`;
- `allow_listed_environment`: drops `SSH_AUTH_SOCK`, `GIT_*` and API keys. This reduces exposure but is **not** credential isolation: SSH key files, `osxkeychain` Git credentials and CLI logins remain usable.
- `non_root`;
- `mandatory_timeout`;
- `output_limits`;
- `process_group_stop`;
- `post_run_git_integrity_check`: new, detect-only (below).

**Post-run Git integrity check** (new, in `packages/git`, read-only):

- **Before and after each run it records:**
  - every branch ref of the repository;
  - the task worktree HEAD and the other worktrees' HEADs;
  - remote-tracking refs;
  - a digest of the common `config` and `hooks/`;
  - a digest of the main checkout's HEAD and status.
- **Any difference** other than working-tree changes inside the task worktree marks the run *needs attention: unexpected Git mutation*. `Approve & Push` stays blocked until the operator reviews it.
- **It detects; it does not prevent.** It cannot see pushes to a URL that update no local ref, changes to other repositories, or file changes outside these repositories. The UI says so.

**SEC-02d implementation notes (Git integrity check, `packages/git`).** Details: `packages/git/README.md`, "Git integrity check".

- **API.**
  - `captureGitIntegritySnapshot(target)` takes repository path, worktree path, branch, base commit, limits and an optional expected repository identity. It returns a versioned, JSON-safe `GitIntegritySnapshot`.
  - `compareGitIntegritySnapshots(before, after)` is pure and returns `GitIntegrityComparison`: `status`, `publication`, `findings`, the digests of both sides and `coverage: 'observable_before_after_state'`.
  - `verifyGitIntegrity(baseline)` captures the after snapshot with the baseline's target, limits and repository identity, then compares.
  - `digestGitIntegritySnapshot` hashes the observed state.
- **Inventory**, extending the sketch above:
  - the repository identity (canonical root and common dir with `dev`/`ino`);
  - the task worktree's verification state;
  - the full worktree registry with every HEAD and branch;
  - every ref (local branches, remote-tracking refs, tags, notes, stash);
  - config keys of the common and per-worktree config files, as value digests only;
  - a fixed set of redirecting metadata files (`objects/info/alternates`, `info/attributes`, the task `.git` file and admin files);
  - the common `hooks/` directory;
  - a digest of the main checkout status.
- **Each section is observed or failed, never partial.** The result is:
  - `violation` if any observable change is found;
  - otherwise `inconclusive` if any section failed, the snapshots are invalid or mismatched, or the baseline worktree was not verified;
  - otherwise `clean`.

  Normal tracked, untracked, staged and ignored edits inside the task worktree are not part of the inventory. A task branch movement (agent commit) is a violation.
- **Inspection safety.** It reuses the inspection runner and environment: hooks, fsmonitor and filters are disabled, there are no optional locks and no lazy fetch. It is bounded by per-command limits, an overall deadline and per-section entry and byte limits. A limit that is exceeded fails its section and never truncates it. Files are read without following symlinks, and config values, stderr and file contents are never stored or reported. If the repository path stops resolving to the expected repository (paths and inodes), nothing else is inspected.
- **Detection limits (stated in the UI and the disclosure).** The check does not detect:
  - transient mutations reverted before the post-run capture;
  - pushes that update no local ref (by URL, to an unconfigured remote);
  - reflogs, unreachable objects, included config files, a custom `core.hooksPath` directory's contents, global config, or other repositories.

  A clean result is "no observable violation", not proof of absence.
- **Publication contract** (for the worker, M4, and Approve & Push, M5/M7):
  - `violation` and `inconclusive` set the run to *needs attention: unexpected Git mutation* or *integrity check inconclusive*. Approve & Push stays blocked. Nothing is repaired, reset or silently accepted.
  - Unblocking needs an explicit operator review decision. It is recorded with the run and bound to `beforeDigest`/`afterDigest`, so a later different state needs a new decision.
  - `clean` only allows the normal human change review; it never approves or publishes anything.
  - The comparison is persisted as `task_runs.git_integrity_result` (M2).
- **When `post_run_git_integrity_check` may be recorded as applied.** It is not recorded today: the gate omits it, and the launch boundary refuses it with `safeguard_unavailable`. It may be recorded only when all of these exist:
  1. the worker captures a baseline whose `repository` and `taskWorktree` sections are observed and whose target equals the authorization's workspace (root, common dir, worktree, branch, base commit), **before** authorizing. A failed baseline denies the launch;
  2. the worker is obligated to run `verifyGitIntegrity` after **every** terminal outcome: completed, failed, timed out, stopped, output-limited, and worker-restart recovery;
  3. the result is persisted with the run, and the publication gate reads it;
  4. the gate adds the safeguard only for a request that carries that baseline, and the launch boundary accepts it only then. Until then, the `safeguard_unavailable` refusal stays.

**Worker integration notes (2026-11-05, first execution slice).** `apps/worker/src/execution/` connects the pieces above for operator-started runs:

- **Consent from persisted state only.** `security_settings` (enable flag, disclosure version `trustedLocalDisclosure.version` in `core`, acceptance time, accepted risks) and the project trust columns are checked in the claim transaction and read again immediately before the gate. The worker builds `TrustedLocalState` and the policy from them; task fields, request bodies and earlier runs never contribute. Strict Isolated Mode is never selected and there is no fallback.
- **No constructed authorizations.** The worker passes the gate's result straight to `startAgentExecution` in the same process. It imports neither `agents/diagnostics` nor the issuer (ESLint plus a source test).
- **Git integrity.** Baseline before authorization (every section observed, task worktree `ready`, otherwise no launch), stored as `task_runs.git_integrity_baseline_json`; `verifyGitIntegrity` after every outcome with a baseline, including restart reconciliation from the stored baseline. Result in `git_integrity_status` / `git_integrity_result_json` (bounded findings, no values). Conditions 1–3 of "When `post_run_git_integrity_check` may be recorded as applied" are met by the worker; condition 4 (gate and launch boundary accepting the safeguard for a request carrying the baseline) is **not** implemented, so the safeguard is still not recorded in authorizations.
- **Deviation needing a decision.** §SEC-02d says a violation or inconclusive check sets the run to *needs attention* with Approve & Push blocked; it does not name a task state. The lifecycle has no such state, so the worker keeps run status `completed` and applies the existing `fail` transition (task `Failed`, error `git_integrity_violation` / `git_integrity_inconclusive`). Only a completed run with a clean check reaches `Review`. Alternatives (a Review sub-state with a publish block, or a new state) need a documented decision before M6.
- **Base ref.** The worktree starts from the **local** base branch (`createTaskWorktree`); SPEC §9.4 (fetch and resolve the remote-tracking ref) is deferred.
- **Restart.** Runs left active by another worker instance are marked `interrupted` (`worker_restarted`); their process groups are not signalled (PID reuse), which the run's message states. A graceful shutdown stops active runs and records them `interrupted` (`worker_shutdown`).
- **Follow-up attempts (M6-02, Request Changes).** `reviews` stores one decision per reviewed run (`run_id` unique) with its `workspace_id`, the feedback and the change-inventory revision the reviewer saw; recording it and the `request_changes` transition (Review → Queued) share one transaction, and no start request is created. The claim binds the next attempt to the pending change request (`follow_up_run_id`) and sets the new run's `workspace_id` to the **same** workspace; a task with a retained workspace but no pending change request is refused (`continuation_unavailable`), so no second worktree or branch is ever created for a task. Before launch the worker re-verifies the retained worktree (record matches task, project and managed root; Git confirms a locked linked worktree at `<root>/<repository key>/<task id>` on the task branch; HEAD and branch at the recorded base SHA) instead of recreating it; any mismatch fails the attempt and leaves the worktree untouched. The rest of the path (consent re-read, baseline, gate, launch boundary, Stop, timeout, reconciliation, post-run integrity) is unchanged. The prompt is project instructions + original task prompt + the latest feedback with a note that the previous changes are present. Because attempts share one worktree, an earlier attempt's file state is not snapshotted; its run record, events and feedback are.

**SEC-02e.4 notes (Claude Code launch profile).** The first real Claude Code 2.1.317 `coding-edit` smoke run completed with exit 0 but changed nothing. Claude's own session transcript showed the exact requested `Write` inside the worktree, refused because it needed approval and `--permission-prompts none` provides none. The profile `claude-print-restricted` is therefore now:

`--print --restricted --strict-mcp-config --permission-prompts none --permission-mode acceptEdits`, followed by `--output-format stream-json --verbose [--model <id>]`.

- **`acceptEdits` is an intentional Trusted Local capability choice**, so the agent can edit files in its working directory without a prompt. It is **not** a verified confinement mechanism, and no capability changes from `unverified`. Strict Isolated Mode is unchanged and still denies every shipped profile.
- **`--permission-prompts none` still auto-denies** every request that needs interactive approval. Per the CLI help, `--restricted` reserves writes to settings, Git and tool-configuration files for a person or a permission handler, so `acceptEdits` does not approve them. This is documented behavior, not tested behavior; adversarial checks remain with the VM plan.
- `auto`, `bypassPermissions`, `--dangerously-*` and `--permission-prompt-tool` stay rejected by the argument deny list.
- **Successful process completion is not proof that the task was done.** Claude reported `result: success` after the denied write. The worker and review (M4/M5) must judge work by the change review, never by the run outcome alone.
- **Earlier Claude smoke results used the old argv** and are not evidence for this profile. Claude `stdin-token` and `coding-edit` must be rerun.
- Claude Code may persist session transcripts under `~/.claude/projects/` (prompts, replies, tool inputs, repository content). The Trusted Local disclosure states this (`SPEC.md` §12.1).

**Accepted risks in Trusted Local Mode** (shown in the disclosure, stored with every run as `acceptedRisks`): all strict controls that are not enforced for the profile. With today's profiles that is all seven:

- writes outside the worktree;
- network access;
- Git history mutation and pushes;
- reading credentials;
- repository-controlled CLI configuration (only partly mitigated by profile flags);
- non-interactive approval (where unverified);
- descendant processes outside the process group (SEC-01).

**Representation outside the authorization:**

- **Run results and events.** `AgentRunResult` and the `started` event carry `securityMode` (plus the existing `processContainment`).
- **Persisted run metadata (M2).** `task_runs` gains:
  - `security_mode`;
  - `launch_profile_id`;
  - `cli_version`;
  - `control_assessment_json` (the honest statuses);
  - `accepted_risks_json`;
  - `safeguards_json`;
  - `disclosure_version`;
  - `process_containment`;
  - `git_integrity_result`.
- **Persisted settings and projects (M2).**
  - `scheduler_settings` (or a `security_settings` row): `trusted_local_enabled`, `trusted_local_disclosure_version`, `trusted_local_accepted_at`.
  - `projects`: `execution_trust` plus `trusted_common_dir` and `trusted_at`.
- **UI (M3/M7):**
  - a persistent mode badge on tasks and runs;
  - a Settings page with the full disclosure and an explicit enable action;
  - a per-project trust toggle that shows the canonical repository identity;
  - Stop wording "terminates the agent's process group";
  - an attention banner for Git integrity findings.

  Strict-mode wording ("enforced", "isolated", "sandboxed") is never shown for Trusted Local runs.

**What does not change:**

- The Strict gate, `assessControl`, the shipped profiles (`unverified`) and the CLI launch arguments.
- The informational-only role of `riskAcknowledgements`.
- The worktree lifecycle and cleanup safeguards.
- The trusted publish flow (§9).
- Execution stays off until the staged implementation (including SEC-02d/e) lands and a worker calls it.

**Conversation Mode** (§15) applies the same pattern with its **own** types:

- `ConversationRuntimePolicy` with `strict_isolated` | `trusted_local`.
- A separate conversation disclosure and acceptance.
- No repository or worktree in the authorization, and a scratch directory as `cwd`.
- A conversation authorization is a different type that `startAgentExecution` rejects. Execution Mode acceptance or repository trust never enables conversations, and conversation acceptance never grants a worktree, task queueing or publishing.

*Implemented in C2 (2026-11-07); see §15.6 "C2 implementation notes".*

## 8. Git repository and worktree management

- Register existing repositories by canonical absolute path; inspect `git rev-parse`, `git remote -v`, and base refs.
- At first run, `fetch` the selected remote and resolve the configured base branch to an exact commit SHA. If no remote ref exists, support an explicit local ref selection instead of guessing.
- Build a unique branch such as `agent/<task-short-id>-<slug>` and create worktree under a managed root **outside all connected repo checkouts and the app source**.
- For example: `~/Library/Application Support/ai-agent-manager/worktrees/<project-id>/<task-id>/<generation>/` (configurable). Existing PoC worktrees under `/Users/akopton/repos/.agent-worktrees/` may remain unchanged.
- Store canonical worktree path, task branch, remote, source ref and base SHA. Confirm expected Git common directory and branch at each mutation.
- Do not modify the user's primary checkout, merge to base branches, or create PRs in MVP.
- Handle same-name projects and same-name tasks through IDs, not folder name assumptions.
- Keep finished/discarded worktrees until explicit cleanup, including confirmation of their state and whether they contain uncommitted files.

**TM-02 implementation notes (2026-11-06, managed worktree cleanup; accepted v1 policy in `SPEC.md` §9.1).** This brings forward only the "explicit confirmed worktree cleanup" part of M7-02.

- **Inventory (web, read-only).** `GET …/tasks/:taskId/workspace` and the task page show the workspace of the latest attempt and `inspectWorktreeForCleanup` (`packages/git`): `inspectTaskWorktree` plus `verifyRetainedTaskWorktree` (record matches task, repository and managed location `<root>/<repository key>/<task id>`; locked linked worktree with the AI Agent Manager marker; on the task branch; HEAD and branch at the expected commit), `git status --porcelain=v2` and the ignored-path listing. Content-read guard (loopback Host, no cross-origin read). Paths always come from the stored record.
- **Record eligibility.** `assessWorkspaceCleanup` (`packages/core/src/workspace-cleanup.ts`): task `done` with the newest publication `pushed` for the latest run and this workspace (expected commit = its `commit_sha`, basis `published`), or task `discarded` (expected commit = `base_sha`, basis `discarded_unchanged`); exactly one workspace record, which the latest run used; no active run, pending start command, pending change request or recovery, blocking publication, or requested/removing/removed cleanup. Any other status refuses.
- **Git eligibility.** No identity issue, no staged/unstaged/conflicted/untracked paths and **no Git-ignored paths** (`git worktree remove` would delete them). There is no override.
- **Request (web).** `POST …/tasks/:taskId/workspace/cleanup` with `{requestId, workspaceId, expectedCommit, confirmed: true}` (strict schema; no path). The server re-assesses the records, requires the operator's `expectedCommit`, checks repository identity and Git state read-only, then `requestWorkspaceCleanup` inserts a `requested` row in an IMMEDIATE transaction that assesses again. A repeated `requestId` returns the existing row; a second request is `cleanup_already_requested`. The web process never removes, unlocks or prunes anything.
- **Removal (worker, one at a time).** `claimWorkspaceCleanup` re-assesses the records in the claim transaction (refusal → `failed`). The worker then re-validates the repository, re-runs `inspectWorktreeForCleanup` against **its own configured worktree root**, and calls `removeTaskWorktree({ expectedCommit })`, which inspects again, unlocks, runs non-forced `git worktree remove` and re-locks if Git refuses. Branches are never deleted; the resulting `branch_commit` is recorded. Requests older than the start-command age limit (5 minutes) expire.
- **Restart.** A `removing` row left by another worker is settled from Git: worktree gone with the branch present → `removed` (`interrupted_after_removal`); still a verified worktree → `failed`; only the lock missing → lock restored with `relockTaskWorktree`, then `failed`; anything else → `failed`, left as it is. Never resumed automatically.
- **After removal.** The workspace, run, review and publication records stay; the task page shows the removal and Review Changes reports `review_unavailable` (`workspace_removed`).
- **Deferred.** Permanent task deletion, forced removal or ignored-file override, branch deletion, retention policy and automatic cleanup.

## 9. Review snapshots and safe publishing

The review screen needs a **complete working-tree manifest**, not just `git diff`: include staged, unstaged, untracked, modified, deleted, renamed, and binary files. Use Git plumbing/status with NUL delimiters for filenames; never parse human-readable `git status` output as the source of truth.

**Snapshot proposal:** at review time, record (a) `HEAD` SHA, (b) current branch, (c) selected file paths and change types, and (d) cryptographic content hashes of files or relevant blob states, including untracked files. Hash a canonical serialized manifest to get `review.snapshot_hash`.

On **Approve & Push**:

1. Acquire a per-task/worktree exclusive publish lock; ensure no agent process is running for the workspace.
2. Recalculate the same manifest and hash. If different, invalidate the prior approval and return to review.
3. Verify the expected repository, branch, HEAD, destination remote, and allowed task branch namespace.
4. Stage only the **approved manifest** (including untracked files), not an unconditional `git add -A` that could silently include new files.
5. Validate the staged tree, run `git diff --cached --check`, and verify the staged content matches the approved snapshot.
6. Commit with a task-linked message and persist commit SHA before attempting push.
7. Push explicitly to the configured remote and task branch; verify remote success; mark task `Done` only after success.
8. If push fails, preserve the committed SHA and retry **push only**, after revalidating destination and local state.

Publish operations must be idempotent, logged, and isolated from agent execution. Never auto-merge. Basic review does not prove generated code is safe; show which checks/tests actually ran.

**M6-03 implementation notes (2026-11-05).**

- **Approval (web).** `POST …/review/approve` with `{requestId, runId, revision, remoteName, branch, confirmed: true}`. The server re-inspects the review, requires the same latest run, normal-review eligibility and the same change-inventory revision, compares `remoteName`/`branch` with the project's configured remote and the recorded task branch (never using the browser's values), captures the review snapshot (`captureReviewSnapshot` in `packages/git`: every inventory path with its mode and the SHA-256 of its exact bytes, read without following symlinks; the revision must be unchanged afterwards) and records a `publications` row (`approved`). A repeated `requestId` returns the same approval. The commit message is generated from the task (`buildPublicationCommitMessage`). Blocked: no changes, commits on the task branch after the base, conflicts, submodules or nested repositories, truncated inventories, no or a mirror remote.
- **Lock.** The task stays in Review while a publication holds it (active, or failed at the push stage). `Request Changes` and new approvals are refused meanwhile, so no agent can start for the task; there is no separate filesystem lock.
- **Execution (worker, one at a time).** Claim by compare-and-swap; re-verify task, latest run, eligibility, workspace record, repository identity, retained worktree (managed location, lock, branch, HEAD and branch at the base commit), project remote and stored snapshot hash. `commitReviewSnapshot` re-captures the snapshot and requires the same hash, re-reads and re-hashes each file while writing blobs (`hash-object --no-filters --stdin`), stages into a **private temporary index**, requires the tree to differ from the base tree in exactly the snapshot's paths with the expected modes and blobs, runs `git diff-tree --check`, runs `commit-tree` with the base commit as the only parent (`user.useConfigOnly=true`: the configured identity is required), persists the commit SHA, then moves `refs/heads/<task branch>` with `update-ref <new> <base>` (compare-and-swap) and points the worktree's index at the new commit (files are not touched). Hooks are disabled for every command.
- **Push.** `git push --porcelain --no-verify --no-follow-tags --no-recurse-submodules <remote> <commit>:refs/heads/<task branch>` after re-verifying the worktree with the branch at the commit and the remote's URL digest from the approval. No force; success only from Git's per-ref status (`*`, ` `, `=`); `!` non-fast-forward is reported as such. `mark_done` is applied in the same transaction that records the push.
- **Failures and recovery.** Failures before a commit are `failed` at `validation` or `commit` (nothing published; approve again after a fresh review). A failed push is `failed` at `push` with the commit kept; `POST …/review/retry-push` queues a push of the same commit (`up_to_date` when the remote already has it). After a restart, in-flight publications are settled from Git state: branch at the recorded commit → push pending (Retry push), branch at the base → commit failed, anything else → `unexpected_branch_state`. Nothing is resumed automatically.
- **Deviation.** `git diff --check` (step 5) blocks a commit with whitespace errors; there is no override. Remote-tracking refs of the task branch are updated by `git push` as usual.

## 10. REST API and events

Illustrative route surface (final endpoints and exact payloads will be refined during implementation):

| Method | Route | Purpose |
|---|---|---|
| `GET/POST` | `/api/projects` | List / connect local repositories |
| `POST` | `/api/projects/preview` | Validate a path and describe the repository before connecting (read-only) |
| `GET/PATCH/DELETE` | `/api/projects/:id` | Details, update, disconnect (without deleting repo) |
| `GET/POST` | `/api/projects/:id/tasks` | Project board and task creation |
| `GET/PATCH` | `/api/tasks/:id` | Task details and editing |
| `POST` | `/api/tasks/:id/queue` | Explicitly enqueue |
| `POST` | `/api/tasks/:id/stop` | Persist stop command to worker |
| `POST` | `/api/tasks/:id/retry` | Safe retry choice |
| `POST` | `/api/tasks/:id/resume` | Only when supported |
| `GET` | `/api/tasks/:id/changes` | Review manifest/diff |
| `POST` | `/api/tasks/:id/request-changes` | Feedback and new run |
| `POST` | `/api/tasks/:id/discard` | Reject without deletion |
| `POST` | `/api/tasks/:id/approve` | Publish approved snapshot |
| `GET` | `/api/dashboard` | Global counts, capacity, attention |
| `GET/PATCH` | `/api/settings` | Scheduler and global instructions |
| `GET` | `/api/events?after=<id>` | SSE stream, supports reconnect replay |

*Implementation note (2026-11-05, M3-02/M3-03):* task routes are nested under their project, `/api/projects/:projectId/tasks/:taskId[/<action>]`, so a task is always resolved within the project in the URL (a task of another project is `task_not_found`). Implemented so far: list/create, details/edit, `queue` and `return-to-backlog` (the named `return_to_backlog` transition, which the table above omits). The remaining task routes in the table are expected to follow the same nesting. *(2026-11-05, M6-03: `POST …/tasks/:taskId/review/approve` and `POST …/tasks/:taskId/review/retry-push` replace `/api/tasks/:id/approve`; same Host/Origin/JSON guards.) (2026-11-05, M6-01 first slice: `GET …/tasks/:taskId/review` and `GET …/tasks/:taskId/review/diff?path=` replace `/api/tasks/:id/changes`. Both are read-only, use the loopback Host check, and reject requests the browser marks as cross-origin (`Origin` other than the app, or `Sec-Fetch-Site` other than `same-origin`/`none`).) (2026-11-06, TM-02: `POST …/tasks/:taskId/archive`, `POST …/tasks/:taskId/restore`, read-only `GET …/tasks/:taskId/workspace` and `POST …/tasks/:taskId/workspace/cleanup`; see §5.1 and §8 TM-02 notes.)*

Validate all bodies, route params, and query params with Zod. Use structured errors (`code`, `message`, `details`) and request/command IDs for deduplication. Never trust a browser-supplied filesystem path after project registration; resolve server-side from the database.

Planned conversation routes are listed in §15.10.

SSE is **one-way** for live task events. Mutations (Stop, Retry, Approve) use REST. Event IDs allow replay after browser reconnection. The DB event log is authoritative; live SSE is a projection, not state storage.

## 11. UI modules

- **Projects:** repository library; add/edit/disconnect; validate paths and remote/base branch.
- **Project Board:** reusable Kanban filtered by project ID, drag between allowed columns only.
- **Task Detail:** prompt, agent/model, base branch, run history, streaming events, actions by state.
- **Review:** change list, text/binary indication, diff, test outcomes, feedback, discard, approve and push.
- **Overview:** active runs across projects, remaining slots, queue order, tasks requiring attention, Pause Queue.
- **Settings:** global instructions, capacity limits, scheduler mode, worktree/data locations.
- *(Planned, §15.)* **Global AI:** global conversation list and chat. **Project AI:** per-project conversations, context selection, decisions and task proposals.

UI state should be refreshed from server-authoritative records; drag-and-drop is a request to transition a task, not an independent change to local state.

## 12. Restart, reconciliation and retention

- Write run state, process metadata, workspace association, and events durably during execution.
- On graceful shutdown, stop starting new jobs and attempt to terminate active agent process groups. Persist final events and status.
- On restart, obtain the single-worker lease, reconcile previously active runs against OS processes and actual Git worktree state; avoid blindly killing a possibly reattached process or launching a duplicate.
- If process identity cannot be safely confirmed, surface `Interrupted` and require user action. Do not auto-retry.
- Preserve outputs and logs after Stop, failure and interruption. Implement configurable retention and explicit cleanup rather than deleting worktrees as a side effect of status changes. *(TM-02: explicit, confirmed, fail-closed worktree removal is implemented (§8); configurable retention is not.)*
- Back up/restore SQLite carefully (including WAL considerations). Database schema migrations are version-controlled; data files are Git-ignored.

## 13. Development practices and validation gates

- Strict TypeScript, ESLint, unit tests for domain transitions and queue ordering, integration tests for SQLite claims, and end-to-end tests against disposable Git repos.
- Test Git operations with temporary repositories and remotes. Never run destructive integration tests against real company repositories.
- Gate 1: verify both CLI adapters can be launched via the unified interface, with explicit model selection and recoverable unsupported-model errors.
- Gate 2: verify stop and process-group cleanup for both CLIs; retain partial files. Containment of descendants that leave the process group is tracked separately as SEC-01 (§7.4).
- Gate 3: verify Git restrictions/sandbox limitations and document precise guarantees.
- Gate 4: verify review snapshot integrity (including untracked files) and commit/push idempotency.
- Gate 5: simulate web/worker restart during task execution and publish failures.
- Gate 6: complete all product acceptance scenarios from `SPEC.md` section 14.

### Existing PoC (verified)

- Claude and Codex launched from Node.js/TypeScript and wrote into independent worktrees.
- Both CLIs were stopped using process signals; partial files remained in their respective worktrees.
- Not yet verified: robust process-tree cleanup, session resume, secure restrictions on Git mutations, crash recovery, and publish workflow.

## 14. Decisions deferred to implementation planning

1. Exact runnable CLI/SDK combinations and their supported permissions and streaming flags for installed versions.
2. Final SQLite schema field types, constraints and migrations, including worker leases and command idempotency keys.
3. Whether a provider requires a separate OS-level sandbox or restricted Git credentials to deliver enforceable no-push guarantees.
4. Detailed rules for session resumption and retry-worktree generation.
5. Log redaction, file size limits, and retention defaults.
6. Local process supervision for a packaged release (development uses two terminal processes).
7. AI Conversations verification gates and open questions are listed separately in §15.11.
8. A verifiable process containment mechanism beyond process groups (SEC-01, §7.4), and the platform-specific mechanisms any future platform would need (§16).
9. Open SEC-02 decisions (§7.5):
   - launch profiles for Trusted Local Mode (today's Claude `--restricted` profile removes command tools, and Codex `workspace-write` denies network by default; either may be too restrictive for real coding tasks, and any change needs its own review);
   - whether automatic scheduling is allowed in Trusted Local Mode from the start;
   - whether a CLI version change requires renewed acceptance;
   - an optional post-stop report of processes whose working directory is inside the worktree.

These are **explicit validation tasks**, not implied guarantees. The architecture should evolve based on their results without widening the MVP feature list.

## 15. AI Conversations (planned extension)

> Conceptual architecture for `SPEC.md` §18. **C1 (persistence and UI), C2 (CLI-backed turns), C3 (task proposals) and C4 (project-aware source context) are implemented**; see the implementation notes in §15.3, §15.4, §15.6, §15.8 and §15.10. Everything else here is not implemented yet. It does not change §1–§14. Table names, routes and module placement are illustrative and are finalized when the workstream starts (`IMPLEMENTATION_PLAN.md` §8). Statements about CLI behavior are **verification targets**, not confirmed capabilities.

### 15.1 Module placement

One **conversations** module serves both scopes (`global` and `project`). It is not split into a Global AI and a Project AI implementation.

| Concern | Location | Notes |
|---|---|---|
| Conversation, message, decision and proposal types; Zod schemas; conversation runtime policy types | `packages/core` | Framework-free, like the existing domain and security types. |
| Tables, migrations and queries | `packages/database` | Same SQLite database, WAL, foreign keys. |
| CLI invocation in Conversation Mode; per-CLI conversation capabilities | `packages/agents` | Reuses the adapter abstraction from §7 with a separate conversation entry point and separate launch profiles. |
| Turn lifecycle, context assembly, conversation pre-launch gate, proposal and decision commands | conversations module, in the worker | Preferred initial approach: start inside `packages/orchestrator`. A dedicated conversations package may be introduced later, through a documented decision, when clear modularity or dependency boundaries justify it (for example, to keep conversation code from depending on scheduler or publish modules). |
| Selected source file reads | `packages/git` | Read-only; see §15.4. *C4:* the restricted subpath `@ai-agent-manager/git/source-context` is the only Git entry point conversation code may import. |
| Screens, REST and SSE | `apps/web` | Same loopback binding and origin checks as §2 and §10. |

The **worker** owns conversation turns, as it owns task runs. CLI processes are never started by the Next.js process. The web process persists commands such as "send message" and "cancel turn", and streams persisted events.

### 15.2 Execution Mode versus Conversation Mode

Both modes use the same adapter infrastructure: CLI discovery and version detection, `spawn` with argument arrays and `shell: false`, bounded output, event normalization and model selection (§7.2). They differ in everything that concerns authority:

| Aspect | Execution Mode | Conversation Mode |
|---|---|---|
| Entry point | `start(AgentStartInput)` with a verified worktree | Separate conversation entry point; no worktree |
| `cwd` | Verified task worktree | A per-conversation **scratch directory** under the application data root. It is outside all connected repositories, the worktree root and the app source, contains no repository content, and is never registered as a Git worktree. |
| Runtime policy | `ExecutionSecurityPolicy` and gate (M1-03) | A separate **conversation runtime policy** and pre-launch gate |
| Launch profiles | Execution profiles | Separate conversation profiles, for example with tools disabled or read-only. They must never reuse an execution profile implicitly. |
| Lifecycle | Task run state machine (§5) | Conversation turn state machine (§15.6) |
| Capacity | Scheduler slots per CLI (§6) | Not yet decided (§15.11) |
| Output | Worktree changes, reviewed and published | Messages; draft decisions and task proposals that need user approval |

**Conversation runtime policy (conceptual).** It requires, at minimum, that the CLI process tree:

- cannot write to connected repositories, task worktrees, the worktree root or application data;
- cannot run Git mutations or pushes;
- loads no repository-controlled CLI settings, hooks or MCP servers;
- never waits for interactive approval.

Network access to the provider is inherent to the CLI. Additional network or web tools are denied unless a policy explicitly allows them and the control is verified.

In **Strict Isolated Mode**, like M1-03, the gate is **fail-closed**. In **Trusted Local Mode** (§7.5), a turn may run under a separate, conversation-specific operator acceptance. It still never receives a repository path, worktree or task authority, and the honest control assessment is recorded and shown. In Strict mode, a required control that is unenforced, unsupported or unverified for the detected CLI version refuses the turn, and acknowledgements never waive it. Running the CLI in a scratch directory **reduces exposure but is not confinement**: without verified isolation, a CLI with file or command tools could still read or write elsewhere. The UI must not call a conversation read-only or sandboxed unless the gate reports the corresponding control as enforced.

### 15.3 Domain model and tables (conceptual)

| Table | Essential fields | Notes |
|---|---|---|
| `conversations` | `id`, `scope` (`global`/`project`), `project_id` nullable, `title`, `agent_runtime`, `model_id` nullable, `status` (`active`/`archived`), timestamps | `CHECK ((scope = 'project') = (project_id IS NOT NULL))`. Runtime and model are the selection for future messages. |
| `conversation_messages` | `id`, `conversation_id`, `sequence`, `role` (`user`/`assistant`/`system_note`), `content`, `status` (`complete`/`streaming`/`cancelled`/`failed`), `agent_runtime`, `requested_model_id`, `effective_model_id` nullable, `error_code` nullable, timestamps | `(conversation_id, sequence)` unique. The runtime and model snapshot is per assistant message. |
| `conversation_turns` | `id`, `conversation_id`, `user_message_id`, `assistant_message_id`, `status`, `context_manifest_json`, `native_session_id` nullable, `exit_code`, `signal`, timestamps | Records **what context was sent** (§15.4) and process outcome, separately from the message text. |
| `conversation_summaries` | `id`, `conversation_id`, `covers_until_sequence`, `content`, `agent_runtime`, `model_id`, `created_at` | Derived context; the full history is never replaced. |
| `conversation_native_sessions` | `conversation_id`, `agent_runtime`, `native_session_id`, `last_sequence`, `status` | At most one active native session per conversation and runtime; never reused across runtimes. |
| `architecture_decisions` | `id`, `project_id`, `title`, `context`, `decision`, `consequences`, `alternatives`, `status` (`proposed`/`accepted`/`rejected`/`superseded`), `superseded_by_id` nullable, `origin_conversation_id` nullable, `origin_message_id` nullable, `accepted_at`, timestamps | Origin foreign keys use `ON DELETE SET NULL`, so accepted decisions survive conversation deletion. |
| `task_proposals` | `id`, `conversation_id`, `target_project_id` nullable, task fields (`title`, `prompt`, `agent_runtime`, `model_id`, `priority`, `base_branch`), `status` (`draft`/`accepted`/`rejected`), `created_task_id` nullable, timestamps | Pending proposals are deleted with their conversation. Accepted proposals point to the created task. |
| `tasks` (existing) | add nullable `origin_conversation_id`, `origin_proposal_id` | `ON DELETE SET NULL`. Tasks never depend on conversations. |

Rules:

- Project scoping is enforced in queries and commands. Every project-scoped read is filtered by `project_id`, and a global conversation's queries never join project tables.
- Messages store content the user deliberately sent and model output. CLI credentials, tokens and environment values are never stored. Logged events are redacted and size-bounded, as for `run_events`.
- Deleting a conversation (explicitly confirmed) deletes its messages, turns, summaries, native session records and pending proposals. Decisions and tasks keep their data with nulled origin references.

#### C1 implementation notes (2026-11-06)

Migration `0008_conversations` adds two tables, **additively**: no existing table is altered. Commands and reads live in `packages/database/src/conversations.ts`; contracts live in `packages/core/src/conversation.ts`.

| Table | Columns | Constraints |
|---|---|---|
| `conversations` | `id`, `project_id` (`NOT NULL`, `RESTRICT`), `title`, `agent_runtime`, `model_id` (`NULL` = `Default`), `language_mode`, `revision`, `created_at`, `updated_at`, `last_message_at` | `CHECK`s on runtime (`claude`/`codex`), language mode (`pl_technical_en`/`pl`/`en`) and `revision >= 1`. Index `(project_id, updated_at)`. |
| `conversation_messages` | `id`, `conversation_id` (`RESTRICT`), `sequence`, `role` (`user`/`assistant`), `kind` (`note`/`chat`), `content`, `request_id` (unique, nullable), `created_at` | `(conversation_id, sequence)` unique; `sequence >= 1`; a `note` must be a `user` message with a `request_id`. |

Deviations from the conceptual model above, all intentional:

- **No `scope` column.** C1 conversations are project-scoped (`IMPLEMENTATION_PLAN.md` §8). Global conversations would need a migration that relaxes `project_id`.
- **No `status`/archive column.** Archive and delete are deferred to C3. The `RESTRICT` reference makes project disconnect fail closed while conversations exist, as for tasks.
- **`kind` in addition to `role`.** It separates operator notes (`note`, stored only) from future CLI exchanges (`chat`). The `CHECK` lists already contain `assistant` and `chat`, so C2 can write them without rebuilding the table, but no C1 code path does. C2 adds the per-message runtime, model, status and error columns (nullable, additive) or a `conversation_turns` table.
- **`revision`** is the settings revision. `PATCH` must name the revision it was based on; a stale one is refused with `conversation_changed`. Notes do not change it.
- **`request_id`** is a client-generated UUID per note submission. A repeat with the same content returns the stored note (`created: false`); reuse for other content or another conversation is refused (`conversation_request_conflict`).

Rules:

- Every read and command filters by **both** project ID and conversation ID. A conversation of another project is reported as `conversation_not_found`, and its messages are never returned.
- `sequence` is allocated as `max + 1` inside the same `IMMEDIATE` transaction as the insert. It gives a gap-free, deterministic order independent of clock values.
- All appends go through one internal function, which C2 reuses for assistant messages.
- Content is trimmed, uses `\n` line endings, is 1–20,000 characters long and contains no NUL. It is stored as plain text (Markdown kept as written).
- The conversations module imports no agents, Git, orchestrator, execution, worker-command or task-command code. A static test enforces this (`apps/web/tests/conversations-ui.test.ts`).

#### C3 implementation notes (2026-11-07)

Migration `0010_task_proposals` adds two tables, **additively**; no existing table (including `tasks`) changes.

| Table | Columns | Constraints |
|---|---|---|
| `task_proposal_generations` | `id`, `conversation_id` (`RESTRICT`), `request_id` (unique), `retry_of_generation_id`, `status` (turn states), runtime/model/language snapshot, `instructions` (operator focus), `based_on_sequence`, launch facts (`security_mode`, `disclosure_version`, `launch_profile_id`, `cli_version`, `context_manifest_json`, `worker_instance_id`, `pid`), outcome (`error_code`, `error_message`, `exit_code`, `signal`, `proposal_count`, `skipped_count`, `output_note`), timestamps | Partial unique index: one active (`queued`/`running`/`stopping`) generation per conversation; `proposal_count = 0` unless `completed`. |
| `task_proposals` | `id`, `project_id` (`RESTRICT`), `conversation_id` (`RESTRICT`), `generation_id` (`RESTRICT`), `position`, `status` (`draft`/`approved`/`rejected`), editable task fields (`title`, `prompt`, `agent_runtime`, `model_id`, `priority`, `base_branch`), AI values (`suggested_title`, `suggested_prompt`, `suggested_priority`, `rationale`, `dependencies`), `revision`, `task_id` (unique, `RESTRICT` to `tasks`), `created_at`, `updated_at`, `approved_at`, `rejected_at` | `(generation_id, position)` unique; `CHECK`s: `approved` ⇔ `task_id` and `approved_at` set; `rejected` ⇔ `rejected_at` set; runtime and priority lists. |

Deviations from the conceptual model above, all intentional:

- **No `target_project_id`.** C3 conversations are project-scoped; `project_id` is copied from the conversation when the proposal is stored and is never written again.
- **No `origin_*` columns on `tasks`.** The origin reference is kept on the proposal (`task_proposals.task_id`, unique), so a task carries no conversation metadata and `tasks` is unchanged. The task page looks the origin up (`findTaskProposalByTask`). Deletion rules (`SET NULL`) are decided together with conversation deletion, which is still deferred.
- **`accepted` is called `approved`**, matching the UI action *Approve to Backlog*.
- **Generations are a separate table, not `conversation_turns` rows.** A turn requires a user message and appends a reply; a generation appends nothing to the history. Reusing the turn table would have needed a table rebuild (`user_message_id NOT NULL`).

**C3.1 (migration `0011_proposal_sources`, additive).** `task_proposal_generations` gains `source_message_id` (nullable, references `conversation_messages`) and `source_content` (nullable snapshot of the reply text at request time), plus an index on `source_message_id`. Both are `NULL` for C3 rows, which therefore keep their meaning ("generated from the answered conversation") and their proposals. Proposals reach their source through `generation_id`; they need no column of their own. SQLite `ADD COLUMN` cannot add `CHECK`s or `ON DELETE` actions, so the rule "a source is a completed AI reply of the same conversation" is enforced by the request command (messages are never deleted).

### 15.4 Context assembly and isolation

The permanent history is the source of truth. The **context sent to a CLI is assembled per turn** by a trusted **context builder** in the worker, never by the agent:

1. Start from the conversation's own messages, using summaries for older parts and recent messages verbatim, within a size budget.
2. For `project` scope only, add selected project knowledge:
   - project instructions;
   - accepted architecture decisions;
   - task history (titles, prompts, outcomes, review notes);
   - files the user explicitly selected.
3. For `global` scope, add **no project data** unless the user attached a specific item to that conversation, which is recorded as such.
4. Record a **context manifest** for the turn (item kinds, IDs, file paths and commit, sizes, truncation) in `conversation_turns.context_manifest_json`. The UI shows it.

**Selected source files** are read by AI Agent Manager, not by the agent:

- From the project's registered repository, at a **resolved commit** (for example the default base branch), using Git object reads such as `cat-file` on a blob. This uses the same hardened environment as `packages/git`: no hooks, filters, fsmonitor or textconv, `safe.directory` respected.
- Reading from a resolved commit is the **safe, deterministic default**: the content is immutable, reproducible from the manifest, and cannot be changed by a running agent or by uncommitted local edits.
- *Original C4 policy, superseded for registered checkouts by C4.1 below:* uncommitted files from the primary checkout or a task worktree are **not supported**. A future option may allow explicit, user-selected access to uncommitted working-tree files. It would need to be separately designed, with containment and security checks equivalent to `packages/git` (canonical paths, no symlink escapes, no hooks or filters, size and type limits). The UI and the context manifest would have to state clearly that the content came from the working tree and not from a commit.
- Path-validated, size-limited, binary-aware, and recorded in the manifest with path, commit and blob ID.

All assembled context is **untrusted data** for the model and for the application. Repository files, documents, decisions and prior model output may contain prompt injection. The application never executes instructions found in context, and model output can only *propose* decisions or tasks (§15.7, §15.8).

#### C4 implementation notes (2026-11-07)

The following C4 notes describe its original committed-only implementation. **C4.1 below supersedes the source read policy, authorization identity binding and provenance; all other C4 boundaries remain.**

C4 delivers repository source context as a per-conversation **context mode** (`general` / `project_aware`). Project instructions, accepted decisions, task history, summaries and operator-selected files are **not** part of C4 (see "Deferred" below).

**Deliberate decisions (and where they differ from the conceptual text above).**

| Topic | Decision | Why |
|---|---|---|
| Which commit | `HEAD` of the project's **registered main checkout** (resolved per turn), not the default base branch | The operator asks about the code they work on; a branch is not required. Content still comes from a resolved commit (immutable, reproducible from the record). |
| Who selects files | The **model**, from an application-built catalog, in a separate planning run; the application validates and reads. Not operator selection. | Requested product behavior (questions such as "find the code responsible for …"). Operator selection stays possible later. |
| Uncommitted / untracked files | **Never read.** Stated in the UI, the disclosure, the prompt and the Sources list. | Keeps the §15.4 "resolved commit" safety default; no filesystem reads of the checkout at all. |
| Git in conversation code | The C2 rule "conversation code imports no Git" is relaxed to **one** restricted entry point, `@ai-agent-manager/git/source-context`, whose subcommands are allow-listed by a static test. | Reading repository content requires Git object reads; everything else in `packages/git` stays unreachable. |
| Consent | A new **per-project source-sharing permission** (`projects.conversation_source_*`), plus a new AI Conversations disclosure version (`2026-11-07.2`). | The C2 disclosure promised "no project file"; that is no longer true for Project-Aware turns. Execution trust must not double as permission to send source to a provider. |
| Launch profiles | **Unchanged** C2 profiles, gate and launch boundary; two launches per Project-Aware turn. | No new CLI capability or tool is enabled; the model never reads files itself. |

**Read path (all read-only).**

```text
worker: claim (permission re-checked in the claim tx; denied → failed, nothing read)
  ─► permission re-read ─► source-context.resolveSourceSnapshot
        validateRepository(localPath) ─ root & common dir == registered, not a linked worktree
        rev-parse --verify HEAD^{commit} ; symbolic-ref --short HEAD
  ─► ls-tree -r -z -l --full-tree <commit>   (regular blobs only; symlinks/submodules skipped)
  ─► ls-files -z --cached --ignored --exclude-standard   (tracked files the ignore rules match)
  ─► core.classifyRepositoryPath + size ─► eligible catalog (+ keyword matches via git grep)
  ─► PLANNING RUN: runCli(composeContextPlanningPrompt) ─ same gate/profile/scratch/timeout/Stop
  ─► core.parseRepositoryContextRequest (≤ 8 files, ≤ 5 searches)  │ unusable → keyword fallback
  ─► permission re-read ─► retrieveRepositoryContext:
        each path must be an exact eligible catalog entry ─► cat-file blob <oid> (≤ 512 KiB)
        content checks (NUL, UTF-8, minified) ─► line/char bounds
        grep -z -n -I -F -i --no-textconv --max-count=3 -e <term> <commit>  ─► match windows
  ─► ANSWER RUN: runCli(composeProjectAwarePrompt) ─ permission re-read before the gate
  ─► record unverified references ─► finishConversationTurn (reply only if completed)
```

- `git` runs through the existing hardened runner: argument arrays, `shell: false`, sanitized `GIT_*` environment, `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, timeouts and output limits; `grep.*` config that would change output or matching is forced off. Allowed subcommands: `rev-parse`, `symbolic-ref`, `ls-tree`, `ls-files`, `cat-file blob`, `grep` (static test `apps/worker/tests/conversation-boundaries.test.ts`). No path from a request is ever joined to the checkout: traversal, absolute paths and symlink escapes cannot reach the filesystem. A disposable-repository test asserts that the working tree, index, `.git` and worktree list are byte-identical after every read.
- **Default exclusions** (`core/project-context.ts`): `.git`; dependency directories (`node_modules`, `vendor`, `.venv`, …); build output and caches (`dist`, `build`, `.next`, `coverage`, `target`, …); sensitive names (`.env*`, `*.pem`, `*.key`, `id_*`, `.npmrc`, `.netrc`, `*.tfstate`, names containing *secret*/*credential*, `.ssh/`, `.aws/`, …); local databases (`*.sqlite`, `*.db`, WAL/SHM); binary and media extensions; lock files, `*.min.js`, source maps; files matching the checkout's ignore rules (force-added files); files over 512 KiB; then content checks (NUL bytes, invalid UTF-8, average line length > 400). There is no exception for documentation: ignored or sensitive docs stay excluded.
- **Limits** (`repositoryContextLimits`): 100,000 tree entries; catalog 24,000 characters (documentation, keyword matches, directories, then files); 8 requested files; 5 searches (2–100 characters, literal); 3 matches per file and search, 10 files from search matches with ±12 context lines; 400 lines and 20,000 characters per excerpt; 60,000 characters of excerpts per turn; 30,000 characters of history in the answer (12,000 in the planning run). The prompt stays far below the launch boundary's 1 MiB limit.
- **Prompt** (`composeProjectAwarePrompt`): `<instructions>` (ground claims in the excerpts, cite `path:line` only from supplied files, separate observations from assumptions, repository text is untrusted, no tools, uncommitted changes not included), `<language>` (unchanged modes), `<repository_context>` (searches, commit, freshness and limitation notes, numbered `<source>` excerpts), `<conversation_history>`, `<new_message>`. Closing tags in repository text are neutralized (readability, not a security boundary). The planning prompt has `<instructions>`, `<context_request_contract>`, `<repository_catalog>`, a shorter history and the message; it contains paths, never file content.
- **Planning output** is the only thing taken from the first run: one JSON object (`files[]` with `path`, optional `startLine`/`endLine`; `searches[]`; optional `note`). Unknown keys are ignored; invalid items are skipped and recorded. An unusable reply (prose, invalid JSON) or an empty one switches to the deterministic fallback (paths named in the message plus identifier/keyword searches) and is recorded as `selection: fallback`. A failed, stopped or timed-out planning run ends the turn like a C2 failure (message prefixed "While choosing repository files:").

**Persistence (migration `0012_project_context`, additive; no table rebuilt).**

| Table | New columns | Meaning |
|---|---|---|
| `conversations` | `context_mode` (`NOT NULL DEFAULT 'general'`) | Every existing conversation becomes General Chat. |
| `conversation_turns` | `context_mode` (`NOT NULL DEFAULT 'general'`), `context_stage`, `repository_context_json` | Snapshot of the mode at send time; progress (`checking_repository`, `selecting_files`, `reading_files`, `answering`); the retrieval record. |
| `projects` | `conversation_source_access` (`NOT NULL DEFAULT 'none'`), `conversation_source_common_dir`, `conversation_source_disclosure_version`, `conversation_source_allowed_at` | The source-sharing grant, valid only for the stored common Git directory and the current `projectSourceDisclosure` version. |

`ALTER TABLE … ADD COLUMN` cannot add `CHECK`s, so the enumerations are validated by the commands (Zod in `core`). The **retrieval record** (`repositoryContextRecordSchema`) stores commit, branch, previous commit, selection and note, catalog counts, searches, sources (path, line range, total lines, characters, origin, documentation, partial), refused and omitted paths, ignored requests, total characters, `limited`, and paths the reply mentions that were not supplied (`unverifiedReferences`). It never stores file content; excerpts exist only in the per-turn prompt. No repository snapshot or index is persisted.

**Freshness.** Each Project-Aware turn resolves HEAD and rereads; nothing is cached between turns. The claim passes the commit of the latest completed Project-Aware turn; when it differs, the prompt and the Sources list say the repository changed and that earlier replies may describe older code. Old excerpts are never resent; only answered history is (as in C2).

**General Chat.** Turns snapshot `context_mode = general` and take the unchanged C2 path (`composeConversationPrompt`, one launch, no Git). Switching a conversation back to General Chat therefore stops all retrieval; earlier Project-Aware **replies** stay in the history, which C2 resends within its budget, so code quoted in replies can still reach the CLI. This is documented in the settings hint rather than filtered, because silently dropping replies would break follow-up questions.

**C3.1 integration.** `claimTaskProposalGeneration` loads the source reply's turn; for a completed Project-Aware turn with sources, and only while the project still allows source sharing, it passes `{ commit, files: ["path:start-end", …] }` to `composeSourceTaskProposalPrompt`, which adds a `<source_references>` section (no content) asking task prompts to name the relevant paths. Everything else (source snapshot, retry, parser, drafts, approval transaction, idempotency, task lifecycle) is unchanged.

**What is guaranteed by the application:** no source is sent unless the conversation is Project-Aware **and** the project's current grant matches the registered repository identity (checked at send, claim, before reading and before each launch); only committed regular files of the registered main checkout that pass the exclusion policy are read; only validated, bounded excerpts are sent; no repository, index, ref, config or worktree is written; no repository script or hook runs through these reads; no task, proposal or approval results from a reply or from repository content; the Sources list shows exactly what was supplied.

**What is not guaranteed:** the CLI still runs as the operator with the C2 profiles (CLI settings, not OS isolation; not adversarially verified), so a CLI could read other files the account can read and reach the network; excerpts go to the provider; a sensitive file with an unrecognized name and content could be sent if the model requests it (mitigated by the exclusion list and the Sources list, not prevented); the model can still cite files it was not shown (detected heuristically and listed, not prevented); prompt injection in repository files can mislead the reply, but cannot trigger actions. Two CLI runs per turn double the time and provider usage; each has the 10-minute timeout.

**Deferred:** operator-selected files and line ranges; uncommitted working-tree files; project instructions, accepted decisions and task history as context; summaries and token-based budgets; adversarial verification of the conversation profiles; a separate repository index or embeddings (not needed at the current limits); global conversations.

#### C4.1 — Current working tree context (2026-11-07)

A narrow refinement before UI-04. The registered checkout remains separate from task worktrees. The model's planning and answering launches keep the C2 launch profiles, gates and scratch directories. No repository scripts or model-selected shell commands run.

**Discovery and selection.** `resolveWorkingSourceSnapshot` resolves HEAD and records root/common-directory device and inode. Renewed per-project grants persist those identities (`projects.conversation_source_identity`, additive migration `0013_source_identity`) and are checked at preparation, across reads and before each launch. This closes C4's same-path replacement gap; old grants are stale under source disclosure `2026-11-07.2`. `ls-files --stage -z --cached` determines tracked regular paths (stage 0 only), including staged additions; `ls-tree` supplies HEAD blob IDs for comparison, not current content. Existing ignore/path exclusions apply before content reads. Protected path segments are matched case-insensitively for macOS, and default-ignorable Unicode code points are refused to prevent disguised filesystem aliases. Index membership and ignore rules are rechecked after planning, and identity/consent are rechecked before either launch. A changed index entry is refused. No catalog text contains source content.

**Native read boundary.** Node.js 24 exposes `open`, but not descriptor-relative `openat`. Using `realpath`/`lstat` followed by `open(O_NOFOLLOW)` leaves an ancestor replacement race. Therefore `packages/git/native/source-reader.c` is an application-owned, minimal helper compiled by `/usr/bin/cc` at build/test time; the worker dev command builds it too. It is not a CLI capability exposed to the model. `working-tree-reader.ts` spawns its fixed application path with argument arrays, `shell: false`, a minimal environment, a 20-second timeout and a byte cap. Never compile or run code from the target repository. Build outputs live in ignored `native-dist/`; the source and build script are versioned. This small C boundary is deliberate: TypeScript alone cannot supply `openat` on the supported runtime.

The helper walks from `/` with directory descriptors, `openat`, `O_DIRECTORY` and `O_NOFOLLOW` for **every** component. It compares the opened root's device/inode with the worker's expected identity, then walks the validated repository-relative path from that descriptor. Source bytes are never read by reopening an absolute pathname. Replacement of the root pathname cannot redirect the captured descriptor into another tree. No traversal, symlink, submodule or special-file read is allowed. `O_NONBLOCK` avoids waiting on a replaced FIFO. `fstat` checks regular type and size before reading; at most 512 KiB + one sentinel byte can be consumed. Device, inode, mode, size, nanosecond mtime and ctime must agree before/after; reopening the relative path must identify the same file before any output is emitted. Failures discard the capture. Node's directory-identity opens additionally use Darwin `O_NOFOLLOW_ANY`, verified with a private disposable symlink probe. Other platforms fail closed. The helper's root-descriptor binding is what handles root replacement; the numeric Darwin flag alone is insufficient for that case.

**Search, consistency and budgets.** Catalog preparation ranks names without reading source. Requested paths are reread after planning. Literal searches use the same per-retrieval file cache as excerpts, so matches cannot refer to different bytes from the supplied ranges. Searches visit at most 200 eligible paths / 8 MiB in total, then report truncation. Existing 8 requested files, 5 searches, 10 search-result files, 512 KiB per file, 400 requested lines, 20,000 characters per excerpt and 60,000 characters per turn remain. Sensitive/binary/minified/generated files still pass through the existing path/content policy. Captures are per file, not an atomic repository snapshot; files changed after capture may differ at answer time. No clean-status or full-analysis claim is made.

**Provenance.** Backward-compatible optional fields extend the version-1 retrieval record: `sourceMode`, `retrievedAt`, `repositoryIdentity`, and per-source `state` (`matches_head`, `modified`, `added`), `contentHash` (SHA-256 of the captured full-file bytes), and `readAt`. HEAD matching compares raw bytes with the Git blob ID, without filters or textconv; it makes no index/status/line-ending cleanliness claim. Legacy records with no mode remain committed-only. Prompts and Sources show the source mode and captured state, line ranges, hash and time. Only metadata is persisted. Each new turn creates fresh captures even for unchanged HEAD. C3.1 carries the source mode with its references so it never relabels working-tree excerpts as commit contents; proposal generation receives no file text.

**Limits and validation.** A C compiler is a new build prerequisite; missing helper/support produces a visible refusal. The compiled helper must accompany `src`/`dist` deployments. The trusted application installation is outside the target repository's trust boundary. These checks do not isolate the provider CLI or protect a compromised operator account. Existing CLI-level restrictions remain unverified. Tests use temporary repositories/databases and fake CLIs only, including root/symlink replacement, concurrent file replacement, current edits and freshness at identical HEAD, exclusions, budgets, metadata immutability, source provenance, existing consent/Stop/recovery/proposal behavior. No authenticated CLI was used for C4.1.

#### C4.2 — Safe untracked source file awareness (2026-11-07)

A small enhancement before UI-04, extending C4.1 without changing the native helper or CLI launch profiles. `listWorkingSourceTree` appends `git ls-files --others --exclude-standard -z` candidates after stage-0 tracked paths, within one 100,000-entry cap. Git commands remain read-only, limited to 20 seconds and 64 MiB of discovery output each; overflow fails closed. Only capped entries are retained in the catalog; no application recursive directory walk runs. Tracked paths take priority when the shared cap is reached. Git handles nested ignore files, info/exclude and global excludes. Nested repositories/linked worktrees appear as directory placeholders, which the path policy refuses; the canonical configured managed-worktree root (even without Git metadata), protected managed directories and registered linked worktrees remain excluded.

The core adds a conservative untracked source/documentation extension and basename allowlist after all existing path exclusions. Unsupported types are refused; binary/UTF-8/generated checks and the 512 KiB limit apply at capture. The planning catalog labels paths Tracked or Untracked · Local and includes separate candidate counts. It contains names only. Model requests and the deterministic fallback share the eligible map; fallback can resolve root filenames. The existing 200-path / 8 MiB literal-search budget, 8 requests, 5 searches and all excerpt/context caps are unchanged.

`readWorkingSource` rechecks exact tracked index identity or exact nonignored untracked membership before and after the descriptor-relative read. Tracked ignored paths are also refused at this boundary. Replaced symlink ancestors/final components, deletion, special files, growth and capture-time identity/timestamp changes are rejected by the existing helper. Final retrieval rechecks catalog membership/tracking and ignore rules. Repository identity and source-sharing permission still gate preparation and both launches. Source disclosure `2026-11-07.3` makes earlier grants stale; no migration is required.

Version-1 records gain optional `catalog.untrackedFiles` and per-source `state: untracked`; catalogs have in-memory tracking labels. Local captures retain hashes, times and ranges, but skip HEAD comparison entirely. Sources call HEAD a repository reference for working-tree records; untracked items explicitly say they have no HEAD provenance. Legacy records keep their original fields and exclusion statement. Proposal reference metadata separately identifies local sources without rereading or sending file content. Later turns rediscover membership and capture bytes again, so staging transitions are reflected without rewriting previous records.

Limits remain per-file captures, macOS/Node.js 24, a compiled trusted helper, bounded/incomplete large catalogs/searches, a recognized-type allowlist for untracked files, and unverified CLI-level restrictions. No task lifecycle, worker-command creation, automatic approval, repository mutation or authenticated CLI session is introduced. Disposable repositories, temporary SQLite and fake CLIs cover discovery, exclusions, safe reads, provenance, freshness and existing conversation behavior.

### 15.5 Native CLI sessions and agent/model switching

- Native CLI sessions (if a CLI supports resuming them) are an **optimization**, not the source of truth. Whether and how each CLI supports resume, and what it stores locally, is a verification target.
- A native session is bound to one conversation and one runtime. **Sessions are never transferred between Claude Code and Codex.**
- Changing the runtime starts a new native session for the new runtime, seeded from assembled context (§15.4). Changing the model within a runtime either continues the session, if the CLI verifiably supports a per-turn model change, or starts a new one.
- If a native session cannot be resumed (expired, missing, CLI upgraded), the turn falls back to a new session with assembled context and records this in the turn, rather than failing silently or replaying stale state.

### 15.6 Turn lifecycle, streaming, cancellation and errors

`Turn`: `pending → starting → streaming → completed | cancelled | failed | interrupted`.

1. The web process persists the user message and a `pending` turn (an idempotent command), then the worker claims it.
2. The worker assembles context, runs the conversation gate, and records a refusal as a `failed` turn with an actionable reason. It then launches the CLI in the scratch directory with the authorized conversation profile.
3. Normalized output events are persisted (size-bounded) and forwarded over SSE. The assistant message stays `streaming` until the CLI exits.
4. **Cancel** persists intent, then stops the process using the same process-group strategy and escalation as task Stop (§7.3). The partial message is kept as `cancelled`.
5. CLI errors (unsupported model, authentication, rate limit, crash, non-zero exit) mark the turn `failed` with a structured error. There is no automatic fallback to another model or runtime.
6. After a worker restart, unreconciled turns become `interrupted`. They are never retried automatically.

At most **one active turn per conversation**. Turns never preempt or delay task runs; capacity accounting is an open question (§15.11).

#### C2 implementation notes (2026-11-07)

**What runs where.**

```text
Browser ──POST /turns──► web: sendConversationMessage (IMMEDIATE tx)
                         user chat message + conversation_turns row (queued) ──► 202 at once
worker tick (lease holder, 1 s) ──► conversation turn service
   expire stale queued ─► forward Stop ─► claimConversationTurn (consent re-read, slot check)
   ─► composeConversationPrompt ─► adapter.detect ─► mkdtemp scratch (0700)
   ─► prepareConversationTurn ─► re-read consent ─► authorizeConversationTurn (gate)
   ─► startConversationTurn (launch boundary) ─► supervised CLI (own process group)
   ─► finishConversationTurn (reply only if completed) ─► rm scratch directory
```

- `packages/core`: `conversation-turn.ts` (turn states, inputs, consent evaluation, language instructions, prompt composition, error codes), `conversation-security.ts` (separate disclosure, `ConversationRuntimePolicy`, `ConversationTurnAuthorization`, denial codes), `model-catalog.ts`.
- `packages/agents`: `conversation-profiles.ts`, `conversation-launch.ts` (`prepareConversationTurn`, `startConversationTurn`), `conversation-issuance.ts` with the restricted subpath `@ai-agent-manager/agents/conversation-issuer`. The supervise-and-classify part of `startAgentExecution` moved unchanged into `supervised-run.ts`, so both boundaries share the process supervisor, parsers, limits and outcome classification.
- `packages/orchestrator`: `conversation-gate.ts` (`authorizeConversationTurn`). It reuses `verifyExecutable`, and nothing from the worktree or Trusted Local execution preflight.
- `packages/database`: migration `0009_conversation_turns` (additive: `conversation_settings`, `conversation_turns`), `conversation-turns.ts`. Assistant replies go through C1's single `appendMessage`.
- `apps/worker`: `conversations/conversation-turn-service.ts`, driven by the execution service's tick, lease, reconciliation and graceful stop. It is enabled when `conversationScratchRoot` is set (`<data root>/conversation-scratch`).

**Persisted turn lifecycle.** `queued → running → completed | failed | cancelled | interrupted`, plus `running → stopping → cancelled`. (The conceptual `pending/starting/streaming` states above are folded into `queued` and `running`; `startedAt` distinguishes "starting" from "generating".)

- At most one active (`queued`, `running`, `stopping`) turn per conversation, enforced by a partial unique index and in the command. Notes are refused while a turn is active.
- The client `requestId` makes sending and retrying idempotent; reuse for other content is `conversation_request_conflict`.
- A turn snapshots runtime, model and language. `finishConversationTurn` finishes an active turn exactly once; only `completed` appends the assistant message (`role = assistant`, `kind = chat`), in the same transaction, and links it (`assistant_message_id`, guarded by a `CHECK` that allows it only for `completed`). Replies above 100,000 characters are truncated and flagged.
- **Restart.** On start the worker marks `running`/`stopping` turns of other worker instances `interrupted` (`worker_restarted`); their process groups are not signalled (PID reuse). Queued turns older than 10 minutes are failed (`request_expired`) instead of starting late. Nothing is retried automatically; **Retry** creates a new turn (`retry_of_turn_id`) for the latest failed, stopped or interrupted turn while its message is still the last one.
- **Stop.** A queued turn is cancelled in the web transaction. A running turn becomes `stopping`; the worker calls the handle's `stop()` (SIGTERM to the process group, SIGKILL after the grace period), and the turn is `cancelled` with no reply. Graceful worker shutdown records active turns as `interrupted` (`worker_shutdown`).
- **Timeout** 10 minutes per turn (`conversationTurnTimeoutMs`), applied by the launch boundary from the authorization.
- **Capacity (decision).** One running conversation turn per CLI, **separate** from the task execution slots, so a 30-minute task never blocks planning and a chat never delays a task. Worst case per CLI: one task run plus one conversation turn.

**Launch profiles (verified only as far as stated).**

| Runtime | Profile | Arguments (then output options, `--model <id>` if not Default) |
|---|---|---|
| Claude Code ≥ 2.1.317 | `claude-conversation-no-tools` | `--print --restricted --strict-mcp-config --permission-prompts none --tools "" --disable-slash-commands --no-session-persistence --safe-mode`, then `--output-format stream-json --verbose` |
| Codex CLI ≥ 0.166.0 | `codex-conversation-read-only` | `exec --sandbox read-only --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --json`, then `-` (prompt on stdin) |

- The execution profiles are not reused: no `acceptEdits`, no `workspace-write`. Conversation-specific forbidden options include resume/continue/session IDs, fallback models, MCP/plugin/agent loading, `--add-dir`, `--cd`, `--search` and `--permission-mode`.
- **Evidence (2026-11-07):** every option is in the installed CLIs' help. Both complete argument lists were run **unauthenticated** in an empty directory (empty `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; no API keys; Claude with `--bare`, which never reads OAuth or the keychain). Both accepted the arguments and failed only on authentication. Claude's `init` event reported `"tools": []`, no MCP servers, skills or slash commands, and `--model sonnet` resolved to `claude-sonnet-5-5`; `--no-session-persistence` left the sessions directory empty. Without a login Claude prints an assistant text `Not logged in · Please run /login` with `error: "authentication_failed"` and a `result` with `is_error: true`; Codex emits `turn.failed` with a 401. These shapes are in the fake-CLI tests.
- **Not verified:** no authenticated real turn and no adversarial probe (M1-03 method) was run. Every control of both profiles is `unverified`; Codex's read-only sandbox still lets model commands read files. `credential_isolation` is `unsupported` for both.
- **Model reporting:** Claude Code reports the resolved model in its `init` event, stored as `effective_model_id`; `codex exec --json` does not, so it stays empty. An explicit model the provider refuses is `model_unavailable` with an instruction to choose Default or another model; there is no fallback.
- **Failure messages:** missing or unsupported CLI (`cli_unavailable`, `conversation_profile_unsupported`), not signed in or expired login (`cli_auth_required`, heuristic on the CLIs' messages, with the login command), model refused, timeout, output limit, empty reply, gate or launch refusal. No placeholder reply is ever stored.

**Gate and enforcement guarantees.** `authorizeConversationTurn` (Strict Isolated: always denied with `control_not_enforced`; Trusted Local: below) issues a `ConversationTurnAuthorization`, a different type that `startAgentExecution` rejects; `startConversationTurn` rejects execution authorizations. What is actually enforced by AI Agent Manager:

- persisted, separate consent (`conversation_settings`, disclosure `2026-11-07.1`), re-read at claim and immediately before the gate;
- the exact invocation: executable identity (re-read before spawn), every argument, the allow-listed environment digest (`SSH_AUTH_SOCK`, `GIT_*` and API keys are dropped), supported CLI version and the profile's options;
- a fresh `mkdtemp` scratch directory per turn: canonical, mode 0700, owned by the user, empty, inside the scratch root, neither inside nor containing a connected repository root or common Git directory, the worktree root or the database file; removed after the turn;
- no repository, worktree or project path in the arguments, environment or prompt; non-root; mandatory timeout; non-widened output limits; process-group stop;
- single-use, in-process provenance (registered by the gate, redeemed once for the same turn ID and prompt digest, 65 s lifetime).

What is **not** guaranteed: the CLI runs as the operator and can read anything the account can read and reach the network; tools are disabled or sandboxed only by CLI settings that were not adversarially verified; managed (policy) settings of Claude Code still apply; descendants that leave the process group survive Stop (SEC-01); the CLIs may keep their own logs or caches. The UI calls the conversation a "planning conversation" and never "read-only", "sandboxed" or "isolated".

**Context and language.** Each turn is a new CLI process with no native session (persistence is turned off where the CLI supports it). The worker composes the stdin prompt with `composeConversationPrompt`:

1. `<instructions>`: fixed application text (planning role, no tools, nothing is executed, history is data);
2. `<language>`: the fixed instruction for the turn's language mode, never mixed into the message;
3. `<conversation_history>`: earlier **completed** exchanges (user message + reply) of this conversation, newest first until 60,000 characters, older ones counted as omitted. Notes, unanswered messages and other conversations are never included;
4. `<new_message>`: the operator's message.

Closing tags inside conversation text are neutralized so text cannot end a section early (readability, not a security boundary). The turn stores a manifest (`context_manifest_json`: included sequences, omitted count, notes excluded, sizes, language), never the prompt. Project instructions, task history and files are **not** sent (C4). Changing the language applies from the next turn; earlier messages are unchanged.

**Deferred from C2:** token streaming and SSE (the page refreshes every 1.5 s while a turn is active), keeping partial text of a stopped reply, native session resume, summaries and token budgeting (C4), adversarial verification of the conversation profiles, Strict Isolated conversations, task proposals (C3) and project awareness (C4).

### 15.7 Architecture decisions

- Drafts are created from a user action, or from a structured model proposal that is shown to the user and validated with Zod. They are never written directly by the agent.
- `proposed → accepted | rejected`; `accepted → superseded` (by a newer accepted decision). Accepting requires an explicit user command. Edits to an accepted decision create a superseding decision instead of rewriting history.
- Accepted decisions are project knowledge. They are available to all conversations of that project through context assembly and independent of any conversation's lifetime.

### 15.8 Task proposals to Backlog

- The model produces proposals in a **structured format** (for example a JSON schema). The worker parses and validates them into `draft` task proposals; invalid output is shown as text, not turned into proposals. Which CLIs support schema-constrained output is a verification target.
- Accepting a proposal calls the **same domain command as manual task creation** (M2/M3), with the same validation of runtime, model and base branch. The task is created in `Backlog`. The proposal stores `created_task_id`, and the task stores its origin references.
- For a `global` conversation, acceptance requires an explicit `target_project_id` chosen and confirmed by the user. Choosing a project does not add its context to the conversation.
- No conversation code path can enqueue a task, start a run, create a worktree or call the publish service. This is enforced by module boundaries: the conversations module only has access to task creation, never to queue, scheduler or Git mutation commands.

#### C3 implementation notes (2026-11-07)

**What runs where.**

```text
Browser ──POST /proposal-generations──► web: requestTaskProposals (IMMEDIATE tx)
                 consent ✓, no active turn/generation ✓, ≥1 answered exchange ✓
                 queued generation (runtime/model/language/based_on_sequence snapshot) ──► 202
worker tick ──► conversation service (shared with C2 turns)
   claimTaskProposalGeneration (consent re-read; shared per-CLI conversation slot)
   ─► composeTaskProposalPrompt ─► runCli: detect ─► scratch dir ─► prepareConversationTurn
   ─► consent re-read ─► authorizeConversationTurn ─► startConversationTurn ─► supervised CLI
   ─► parseTaskProposalOutput (Zod) ─► finishTaskProposalGeneration: drafts in the same tx
Browser ──POST /proposals/:id/approve──► web: read-only branch check (explicit branch only)
   ─► approveTaskProposal (IMMEDIATE tx): createTask (Backlog) + proposal → approved
```

- `packages/core/src/task-proposal.ts`: statuses, inputs, the output contract and parser, the proposal language rules and `composeTaskProposalPrompt`.
- `packages/database/src/task-proposal-generations.ts`: request, retry, stop, claim, progress, finish and expiry of generations. It imports no task, worker-command, worktree or Git code.
- `packages/database/src/task-proposals.ts`: operator commands (edit, reject, reopen, approve). It is the only proposal code that creates tasks, and only through `createTask`.
- `apps/worker/src/conversations/conversation-turn-service.ts`: one supervised CLI pipeline (`runCli`) for chat turns and generations; their prompts, outcomes and storage differ. C2 turn behavior and messages are unchanged.
- `apps/web/lib/server/task-proposals.ts` and the routes in §15.10; UI in `components/conversations/task-proposals-panel.tsx`, `task-proposal-card.tsx` and `generate-proposals-form.tsx`.

**Structured-output contract.** The prompt (`<instructions>`, `<language>`, `<output_contract>`, `<conversation_history>`, `<developer_request>`) asks for exactly one JSON object `{ "proposals": [{ "title", "prompt", "priority"?, "rationale"?, "dependencies"? }], "note"? }`. The worker accepts the whole reply if it starts with `{`, otherwise the content of exactly one fenced block. Then:

- not one document (prose, several documents), invalid JSON (truncated) or a wrong shape: the generation **fails** with `malformed_output`; nothing is stored;
- each item is validated with the task title/prompt schemas and the task priority list; invalid items and items beyond 12 are skipped and counted (`skipped_count`);
- unknown keys are ignored. The AI cannot set the runtime, model, base branch or status;
- an empty list is a **completed** generation with no proposals and the AI's note.

The CLIs' native schema options (Claude Code `--json-schema`, Codex `--output-schema <file>`) exist in the supported versions but are **not used**: they would change the parse-checked C2 launch profiles and need their own verification. The prompt contract plus application-side validation keeps the profiles identical to chat turns. Using the native options is a possible later hardening.

**Context.** Completed exchanges with a sequence up to `based_on_sequence` (the last message when the request was made), newest first within the 60,000-character C2 budget; notes, unanswered messages and other conversations are never included. A later message therefore never changes what a queued generation sends. The manifest (`purpose: task_proposals`, included sequences, omitted count, sizes, notes excluded) is stored; the prompt is not. Language: `pl_technical_en` writes `title` and `prompt` in English and explanations in Polish; `pl` and `en` follow C2.

**Lifecycle, Stop and recovery.** Identical to C2 turns: `queued → running → completed | failed | cancelled | interrupted` and `running → stopping → cancelled`; queued requests older than 10 minutes expire; restart marks other instances' `running`/`stopping` generations `interrupted` without signalling; graceful shutdown records `interrupted`; nothing is retried automatically. An operator Stop recorded while the CLI was finishing wins over late output, so a stopped generation never stores proposals. **Retry** creates a new generation for the latest failed, stopped or interrupted one (same focus, current settings and history).

**Exclusivity and capacity.** A conversation has at most one active AI request: a chat turn and a generation never overlap (checked in both commands inside their `IMMEDIATE` transactions, plus a partial unique index per table). Notes stay allowed during a generation, because it is based on a fixed sequence. Turns and generations share **one conversation slot per CLI**, still separate from task execution slots.

**Idempotency and stale requests.**

- A request ID deduplicates requests and retries; reuse for other content is `conversation_request_conflict`.
- `finishTaskProposalGeneration` only acts on an active generation, so drafts are stored at most once per generation.
- A generation only inserts new drafts. It never updates or deletes existing proposals, so a late or retried generation cannot replace operator edits.
- Every edit, reject, reopen and approve names the proposal `revision`; a stale one is `task_proposal_changed`.

**Approval guarantees.**

- Only `POST …/proposals/:id/approve` approves, and only for a draft whose revision matches. Nothing in the worker or the CLI can reach it (static test `apps/worker/tests/conversation-boundaries.test.ts`).
- One `IMMEDIATE` transaction calls `createTask(tx, …)` (manual creation: input schema, model/runtime compatibility, project existence, `Backlog`, `queued_at = NULL`) and then changes the proposal to `approved` with `task_id`, guarded by the revision. Any error rolls back both. The `project_id` comes from the stored proposal, never from the request.
- A repeat of an approved proposal returns its task (`created: false`, HTTP 200); concurrent approvals serialize on the write lock and the second sees `approved`. `task_id` is unique.
- An explicit base branch is checked with the same read-only Git query as manual task creation before the transaction; the project default needs no Git access.
- Approval never writes `worker_commands`, `task_runs`, `workspaces` or publications, never transitions the task and never runs Git mutations (tests in `packages/database`, `apps/web` and the static checks).

#### C3.1 — source-scoped generation (2026-11-07)

A small refinement before C4: generation is started from one AI reply and sends only that reply.

- **Request.** `POST …/proposal-generations` requires `sourceMessageId` (plus `requestId`, optional `instructions`). The body cannot carry source text (strict schema). In the `IMMEDIATE` transaction, after consent and the one-active-request check, `requireSourceReply` loads the message by ID **within the route's conversation** (and thus project) and requires `role = assistant`, `kind = chat` and a `completed` turn whose `assistant_message_id` is that message. Otherwise: `task_proposal_source_not_found` (404; also for another conversation's or project's message) or `task_proposal_source_invalid` (409; user messages and notes). The generation stores `source_message_id`, `source_content` (snapshot) and `based_on_sequence` = the reply's sequence.
- **Prompt.** `composeSourceTaskProposalPrompt`: `<instructions>` (the reply is the only source; `prompt` holds only what the agent must do, explanations go to `rationale`, ordering to `dependencies`, remarks to `note`), `<language>`, `<output_contract>`, `<source_response>` (the snapshot) and `<developer_request>` (the focus). The claim loads **no** history for such a generation; the manifest records `scope: source_message`, the source ID and sizes. The output contract, parser and draft storage are unchanged.
- **Idempotency and regeneration.** The same request ID returns the same generation only for the same source and focus; otherwise `conversation_request_conflict`. One active AI request per conversation still prevents accidental duplicates while a generation runs. After it finishes, a new click (new request ID) is a deliberate new generation from the same reply.
- **Retry.** Only the latest failed, stopped or interrupted generation **of the same source reply** can be retried; the retry copies the source reference, the snapshot and the focus, and uses the conversation's current runtime, model and language. C3 generations without a source cannot be retried (`task_proposal_generation_not_retryable`).
- **Existing C3 rows.** Kept as they are. A C3 generation still queued at upgrade time runs with the C3 history prompt; no new one can be created.
- **UI.** `ReplyTaskActions` under every eligible reply (Generate tasks, Focus toggle, state, Stop/Retry, View proposals → `#proposals-<generationId>`); replies have the anchor `#message-<messageId>`. The panel groups proposals by generation, and batches and cards link back to the source reply. Unchanged: worker pipeline, gate, launch profiles, Stop, timeout, recovery, editing, approval and task semantics.

### 15.9 Security boundaries and trust

| Boundary | Trust |
|---|---|
| User actions in the UI (approve decision, accept proposal, select files, choose target project) | Trusted intent. Validated server-side; mutations guarded against untrusted origins. |
| Worker: context builder, gate, proposal parser | Trusted code; the only component that reads repositories for conversations. |
| CLI process in Conversation Mode | **Untrusted.** Restricted only by what the conversation gate reports as enforced. |
| Model output, repository files, documents | Untrusted data; never executed and never acted upon without user approval. |
| Provider behind the CLI | Receives the assembled context under the user's account; this data leaves the machine. |

Residual risks while Conversation Mode isolation is unverified:

- A CLI with tools enabled could read files outside the scratch directory.
- Context sent to the provider may include sensitive source code chosen by the user.
- Prompt injection could produce misleading proposals.

These must be visible in the UI and are mitigated by fail-closed gating, no-tool profiles where verifiable, explicit file selection and mandatory user approval.

### 15.10 API and events (illustrative)

| Method | Route | Purpose |
|---|---|---|
| `GET/POST` | `/api/conversations?scope=global` | List / create global conversations |
| `GET/POST` | `/api/projects/:id/conversations` | List / create project conversations |
| `GET/PATCH/DELETE` | `/api/conversations/:id` | Details, rename, archive, change runtime/model, delete (confirmed) |
| `POST` | `/api/conversations/:id/messages` | Send a message (creates a turn command) |
| `POST` | `/api/conversations/:id/turns/:turnId/cancel` | Cancel an active turn |
| `PUT` | `/api/conversations/:id/context` | Selected files and knowledge items for project scope |
| `GET/POST/PATCH` | `/api/projects/:id/decisions` | Project decisions; accept, reject, supersede |
| `GET/PATCH` | `/api/conversations/:id/proposals` | Review and edit task proposals |
| `POST` | `/api/proposals/:id/accept` | Create a `Backlog` task (requires a target project for global scope) |

Conversation events use the same durable event log and SSE replay as run events (§10).

**C1 routes (implemented 2026-11-06).** Conversations are nested under their project, like tasks (§10):

| Method | Route | Purpose | Guard |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/conversations` | List with message counts, most recently changed first | Loopback Host |
| `POST` | `/api/projects/:projectId/conversations` | Create (`title`, optional `agentRuntime`, `modelId`, `languageMode`) | Host + same Origin + JSON, 64 KiB |
| `GET` | `/api/projects/:projectId/conversations/:conversationId` | Conversation and full history | Host, and refuses cross-origin browser requests (as review diffs) |
| `PATCH` | `/api/projects/:projectId/conversations/:conversationId` | Change settings (`revision` + changed fields) | Host + same Origin + JSON |
| `POST` | `/api/projects/:projectId/conversations/:conversationId/messages` | Save a note (`requestId`, `content`); `201` new, `200` repeat | Host + same Origin + JSON |

Errors:

- `invalid_request` (400): schema failure, including any `role` or `kind` field.
- `payload_too_large` (413) and `unsupported_media_type` (415).
- `project_not_found` and `conversation_not_found` (404).
- `conversation_changed` and `conversation_request_conflict` (409).

No route starts a worker command, agent, task or Git operation. There is no SSE in C1.

**C2 routes (implemented 2026-11-07).** All mutations use the Host + same-Origin + JSON guards; reads use the loopback Host check.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/projects/:projectId/conversations/:conversationId/turns` | Send a chat message (`requestId`, `content`): stores it and a queued turn; `202` new, `200` repeat |
| `POST` | `…/turns/:turnId/stop` | Stop a queued (cancelled at once) or running (worker stops the process group) turn |
| `POST` | `…/turns/:turnId/retry` | New turn for the latest failed, stopped or interrupted turn (`requestId`); `202`/`200` |
| `GET/PUT` | `/api/settings/conversations` | AI Conversations disclosure and acceptance (`{ enabled: true, disclosureVersion }` or `{ enabled: false }`) |

`GET …/conversations/:conversationId` also returns `turns` (status, runtime, requested and reported model, language, error, context counts; never the prompt) and `ai` (consent status). New errors: `conversation_ai_disabled`, `conversation_ai_stale`, `conversation_turn_active`, `conversation_turn_not_active`, `conversation_turn_not_retryable` (409) and `conversation_turn_not_found` (404). The web process still starts no process: the worker owns every turn.

**C3 routes (implemented 2026-11-07).** Under `/api/projects/:projectId/conversations/:conversationId`. Mutations use the Host + same-Origin + JSON guards; reads use the content-read guard (loopback Host, no cross-origin browser request).

| Method | Route | Purpose |
|---|---|---|
| `POST` | `…/proposal-generations` | Explicit request (`requestId`, `sourceMessageId` since C3.1, optional `instructions`); `202` new, `200` repeat |
| `GET` | `…/proposal-generations/:generationId` | Status of one request (never the prompt) |
| `POST` | `…/proposal-generations/:generationId/stop` | Stop a queued (cancelled at once) or running request |
| `POST` | `…/proposal-generations/:generationId/retry` | New request for the latest failed, stopped or interrupted one (`requestId`) |
| `GET` | `…/proposals` | Proposals in stable order (generation, then position) with their requests |
| `GET/PATCH` | `…/proposals/:proposalId` | Read; edit a draft (`revision` + changed fields) |
| `POST` | `…/proposals/:proposalId/reject` · `/reopen` | `revision`; idempotent |
| `POST` | `…/proposals/:proposalId/approve` | `revision`; `201` with the new Backlog task, `200` for a repeat |

`GET …/conversations/:conversationId` also returns `generations` and `proposals`. New errors: `task_proposal_no_history`, `task_proposal_generation_not_active`, `task_proposal_generation_not_retryable`, `task_proposal_changed`, `task_proposal_not_editable` (409); `task_proposal_generation_not_found`, `task_proposal_not_found` (404). C3.1: `task_proposal_source_not_found` (404), `task_proposal_source_invalid` (409); generation views include `sourceMessageId`. Approval can also return the task errors of manual creation (`invalid_task_input` 400) and `base_branch_not_found` (422). The illustrative `/api/proposals/:id/accept` above is not used: proposals are nested under their project and conversation.

**C4 routes (implemented 2026-11-07).**

| Method | Route | Purpose |
|---|---|---|
| `PUT` | `/api/projects/:projectId/conversation-source-access` | Allow (`{ access: 'allowed', gitCommonDir, disclosureVersion }`, re-checked read-only against the registered repository) or withdraw (`{ access: 'none' }`) source sharing for Project-Aware conversations. Host + same-Origin + JSON guards. |

`POST`/`PATCH …/conversations` accept `contextMode`. `GET …/conversations/:conversationId` also returns `sourceAccess` (current, reason, repository identity, disclosure); turn views include `contextMode`, `contextStage` (while active) and `repository` (the retrieval record, never content). New error: `conversation_source_access_required` (409). Turn error codes: `source_access_denied`, `repository_unavailable`, `repository_context_failed`.

UI pages:

- `/conversations`: projects with conversation counts.
- `/projects/:projectId/conversations`: the list, plus **New conversation** at `…/new`.
- `/projects/:projectId/conversations/:conversationId`: history, note composer, settings panel and (C3) the Task proposals panel.

### 15.11 Verification gates and open questions

1. Per CLI: streaming format, native session resume, per-turn model switching, context limits, effective-model metadata and structured output.
2. Per CLI: a Conversation Mode launch profile with no tools or read-only tools, and adversarial verification that it cannot write files, run commands, use Git or read outside the scratch directory, using the M1-03 verification method.
3. Per CLI: whether repository instruction files, settings or memory are read from the working directory or user configuration, and how to prevent cross-project leakage through CLI-side memory.
4. Whether web search or browsing can be offered for Global AI under a verifiable policy.
5. Capacity: shared with the §6 execution slots or a separate conversation limit, and the effect of provider rate limits.
6. Context budgeting: token estimation per CLI, summary generation (which runtime and model), file size limits.
7. Project disconnect: archive, keep or delete conversations and decisions (explicit user decision per `SPEC.md` §4.1).

*C4 status (2026-11-07):* 6 — context budgeting decided as fixed character/line/file limits (§15.4 "C4"); token estimation and summaries remain open. 2 and 3 unchanged: Project-Aware turns use the unchanged C2 profiles, so file access by the CLI itself is still only restricted by unverified CLI settings.

*C3 status (2026-11-07):* 1 — structured output: a prompt-level JSON contract validated in the worker; the CLIs' native schema options are known but unused.

*C2 status (2026-11-07):* 1 — streaming format and effective-model metadata are known per CLI (above); session resume is not used. 2 — profiles defined and parse-checked, **not** adversarially verified. 3 — Claude: `--safe-mode`, `--restricted` and `--strict-mcp-config` skip CLAUDE.md, user/project settings, hooks, plugins and MCP (managed settings still apply); Codex: `--ignore-user-config` and `--ignore-rules`; both run in an empty scratch directory. 5 — decided: one conversation slot per CLI, separate from execution slots. 4, 6 and 7 remain open.

## 16. Platform strategy

**macOS-first, cross-platform-ready.**

- macOS is the only currently targeted and tested platform. Existing macOS behavior is preserved: data root defaults (`~/Library/Application Support/ai-agent-manager`), POSIX process groups and signals, and the Seatbelt-based sandbox assumptions in the security profiles.
- Windows (native or WSL2) and Linux are possible future platforms, **not** MVP commitments. They are not implemented, tested or supported now.
- Avoid unnecessary cross-platform abstraction layers. Do not build interfaces for platforms that do not exist yet.
- Keep platform-specific behavior behind the existing module boundaries where practical:
  - filesystem paths and runtime roots in the runtime-path resolver (`packages/database`);
  - process supervision and termination in the supervisor (`packages/agents`);
  - sandboxing assumptions in the code-defined security profiles and the execution gate.
- Shared domain types and business logic (`packages/core`, scheduler and state machines, review and publish rules) must not assume macOS. Platform facts are inputs (for example resolved paths), not hard-coded paths or signal names in domain code.
- Security facts are platform-specific. A profile capability verified on macOS says nothing about another OS. Any new platform needs its own compatibility and adversarial security verification (the M1-03/M1-04A method) before it is supported, and SEC-01 (§7.4) must be re-assessed for it.

---

**Next:** Write `IMPLEMENTATION_PLAN.md`, then implement the first vertical slice: Git repository registration, durable task state, and one agent run on a disposable repository.


## 17. UI-04A — Project workspace navigation

Navigation structure agreed before implementation (2026-11-07): a shared App Router
`/projects/[projectId]/layout.tsx` owns the project name, All projects link and four section
links. Overview is `/projects/:projectId`; Kanban remains `/projects/:projectId/board`;
Conversations remains `/projects/:projectId/conversations[/:conversationId]`; Project Settings
is `/projects/:projectId/settings`. The old `/edit` entry redirects to Settings. Existing task,
review, proposal and message anchors remain unchanged. Task descendants activate Kanban;
conversation descendants activate Conversations. Global navigation keeps Projects active for
all project descendants; `/conversations` remains the cross-project conversation index.

Project settings reuse the existing edit, trust and source-sharing controls. App Settings
(`/settings`) retains global execution consent, separate conversation consent and appearance.
No permission scope or worker lifecycle changes. Navigation never starts or stops work.

Browser-session memory is per project: the last board URL (including query) and last visited
conversation detail URL. Store only validated same-project routes in sessionStorage; blocked
storage falls back to canonical links. Direct list URLs always open the list. No visit writes
to SQLite. Recent Projects uses a read-only database query over persisted project, task,
conversation and completed-run timestamps, limited to two projects with deterministic ties.


Production HTTP QA exposed a Webpack native-addon resolution problem: a transitive
`better-sqlite3` loader was bundled and looked for its binary under `.next`. The web package
now declares the same pinned `better-sqlite3` version as the database package and explicitly
lists it in `serverExternalPackages`. This is a runtime packaging correction, not a new
persistence layer. Both processes still use the existing database package and SQLite schema.


## 18. UI-04B — Conversations workspace presentation

`/projects/[projectId]/conversations/layout.tsx` reads the existing project-scoped summary query
and renders one responsive `ConversationNavigation` alongside list/new/detail content. The
query's existing `updatedAt` ordering includes saved settings and message activity; navigation
writes nothing. The navigation marks the exact detail path, truncates long titles (full title
available), and uses one collapsible list on narrow screens. UI-04A's parent project layout and
validated sessionStorage detail-path memory are unchanged.

The detail server page supplies Chat, Tasks and Notes as slots to `ConversationViews`. Radix
Tabs (already installed) supplies tab/panel wiring and arrow/Home/End keys with manual
activation (Enter/Space). Inactive panels stay mounted and hidden, retaining composer/proposal
drafts across view changes; the worker-owned auto-refresh remains outside the panels. Native
History API updates `?tab=` through Next.js's supported integration, preserving unrelated query
parameters and creating back/forward entries without server navigation or commands. Hash/popstate
subscriptions reveal legacy message/batch targets and scroll after the panel becomes visible.

`ConversationHistory` computes turn eligibility from the full history before omitting note
entries. This deliberately preserves C2 retry rules when a note follows an unanswered message.
`ConversationNotes` renders only notes, preserving sequence, plain text and timestamps. Two
instances of the existing composer have fixed Chat/Note modes, separate drafts and request IDs;
only the Notes instance calls `/messages`. A synchronous ref guards duplicate submissions before
React renders busy state; the field is disabled during requests, and failed responses preserve
text and request identity. Ctrl/Command+Enter ignores IME composition and key-repeat events.

`TaskProposalsPanel` now includes every generation, not only those with cards. Existing state
formatting and Stop/Retry actions are reused. Retry is limited to the latest generation per
source reply while no conversation AI work is active; source-less legacy C3 requests cannot
retry. Cards, revision checks, model/branch selection, approval transactions and task links are
unchanged. Existing hash links continue to work across panels without rewritten provenance.

Conversation settings use native `details/summary` in the header, reusing the existing settings
form and source-permission link. No new dependencies, APIs, schema, context assembly, retrieval,
worker, consent or task/Git authority are introduced. Nebula Graphite tokens drive navigation,
tabs and primary Send; Save as Note remains neutral. UI-04C/D remain separate deferred work.


**UI-04B scroll follow-up.** `ConversationChat` owns a local transcript viewport and separate
composer footer. It is keyed by conversation ID. `createChatScrollController` tracks initial
positioning, user reading position, 96px near-bottom following and intentional fragment anchors.
Successful chat submission notifies this presentation component after the existing API succeeds;
note saves do not notify it. Layout effects position before showing the initial transcript;
ResizeObserver handles delayed content/viewport changes. Idle polling does not rewrite scrollTop
when it already matches. Hidden panels' zero geometry cannot overwrite the saved position.

Message-anchor offsets are computed relative to the transcript and applied to its scrollTop;
they never use scrollIntoView. Same-conversation source links are intercepted before native
fragment scrolling can move ancestors, while keeping URL/history semantics and modifier clicks.
An anchor remains aligned through delayed layout until the user scrolls or deliberately sends.
The existing proposal-batch navigation remains. Chat gains no autofocus. Pane height uses document
coordinates to avoid resizing as the outer page scrolls, fits the desktop viewport, and keeps a
384px floor for small windows. Existing tall mobile navigation retains normal outer page access;
Chat history remains local once reached. No dependencies or backend changes are needed.


## 19. UI-04C — Message and task presentation (2026-11-07)

ConversationHistory nests ReplySources and ReplyTaskActions in the assistant article, retaining
stable list-item anchors and completed-turn eligibility. The footer keeps sourceMessageId,
request-ID retries and generation lookup by source; a synchronous submit ref also prevents
same-tick duplicates. Focus is local and disabled during submission. Existing batch hashes switch
to Tasks through ConversationViews. Message and batch links both update native History through
Next's integration so subsequent proposal mutations/refreshes retain the current fragment; retrieval, context assembly and authorization are unchanged.
Sources retains buildSourcesView provenance and adds explicit line ranges and verification wording.
TaskProposalCard uses a 240-character collapsed prompt with a deliberate accessible expand control;
its original editor and approval commands remain unchanged.

TaskEditLink reuses server-derived editability above and after the prompt, including archive
restrictions. TaskOrigin receives findTaskProposalOrigin's read-only projection through the task
page: task/proposal project checks, project-scoped conversation and generation joins, assistant/chat
message identity, SQL substr capped at 601 characters (600 plus a truncation sentinel). It reads
one historical reply, never a whole transcript or generation prompt, and writes no new persisted
data. Missing joins produce nullable preview fields; legacy origins retain conversation navigation.

lib/tasks/status-style centralizes semantic CSS variables for every TaskStatus and derives action
destinations from core.taskTransitions. LifecycleButton and Kanban column dots consume the same
taskStatusStyle; the shared button lifecycle variant supplies tinted fill, border, hover and focus.
Queue/Backlog, recovery triggers/confirmation, Request Changes and asynchronous Start reuse it.
Stop/Discard keep destructive semantics. No new status transition, API, dependency, migration,
worker, source access, execution or publishing behavior is introduced. UI-04D remains next.


**UI-04C workspace-density acceptance follow-up.** AppShell delegates only its main container
to a small client WorkspaceContent boundary. usePathname selects wide project board/conversation
routes via the tested isWideWorkspace predicate, so client navigation changes width without
stretching settings, task detail/review or standalone creation forms. Server content remains
server-rendered children. No global CSS or theme tokens change. Wide routes remove max-w-6xl
and reduce gutters; Kanban's negative margins/scroll padding match those responsive gutters.
Conversation layout uses a 15rem sidebar with a 1rem gap; native settings stay on demand and the
compact header keeps Project-Aware visible. Reply widths use 90ch at text-sm for reading comfort.

ConversationChat retains document-relative top measurement, ResizeObserver, the 384px minimum
and existing scroll controller; its bottom allowance becomes 16px. The separate compact composer
uses two initial rows and a 45% maximum pane share, with internal overflow for resized inputs or
feedback. Its accessible form name retains the recipient; visible hints avoid repeating header
metadata. Notes keep four rows. Existing context/consent details and all API behavior remain.


**UI-04C unified-geometry/panel correction (supersedes the initial density implementation).**
WorkspaceContent is now a server-rendered shared main boundary without route-specific outer
widths. lib/layout owns gutters, spacing and content-width classes; AppShell uses the same gutter
for its top bar. PageContent limits only internal columns. ProjectContent selects reading/form
widths for tasks/settings below the unchanged shared project header; global App Settings uses
the form primitive. No feature container can center or move shared navigation. Root scrollbar-gutter
is stable. Projects uses an explicit minmax(0, 1fr) grid track so long repository paths fit phones.

ConversationViews owns one measured workspace height for every view (document-relative top,
16px bottom allowance, 520px minimum). Its persistent header/title and fixed-width settings button
sit above the shared Radix tab list. A local settings mode hides the view panels and shows the
existing settings form in the content area; all stay mounted, preserving in-flight operations,
form drafts and local positions. Source/batch navigation exits settings. Settings state is local,
while the existing tab query/history and stable fragments remain authoritative navigation.
ConversationPanel provides flex/min-height:0 boundaries, one focusable history scroller and an
optional separate bounded composer. Chat reuses its existing controller and ResizeObserver for
latest/following/anchors, delegating sizing to the shared frame. Tasks anchors use relative offsets
inside the proposal scroller; the page is never scrolled by a proposal link. User scroll position
is restored on return instead of repeatedly applying an already handled batch fragment.

ConversationAiNotice now presents only actionable blockers outside the history. The existing
App Settings consent card, anchored #ai-conversations, owns the explanation and versioned global
acceptance/revocation controls. Project Settings retains #source-sharing and its repository-bound
permission. No backend, schema, consent version, retrieval, lifecycle or execution change.

**UI-04C persistent project shell and task-header acceptance fix (2026-11-08).**
AppShell is viewport-height from the md breakpoint: its fixed-size top bar and sidebar surround
min-height:0 flex/grid content. WorkspaceContent keeps shared geometry and delegates existing
project descendants to their workspace; ordinary global pages scroll in main. The shared project
layout renders one fixed header followed by ProjectContent as flex:1/min-height:0. Standard routes
use its focusable overflow-y:auto viewport, retaining PageContent's internal reading/form widths.
Conversations uses overflow:hidden at that boundary and delegates scrolling to its existing panes.
ConversationRouteContent provides one scroller for list/new routes and none around detail panes;
ConversationsLayout has explicit minmax(0,1fr) rows/columns. ConversationViews now fills this shared
height rather than independently measuring document offsets. Small-screen conversation lists have
a bounded independent scroller. Dialogs retain their existing portals.

createProjectContentScroll restores per-path in-memory offsets and relative fragment anchors.
Mutation/resize observers allow targets to arrive after streamed placeholders. Non-fragment
restoration ends when its target is reached; anchors follow delayed layout until manual scrolling.
Expected programmatic offsets distinguish restoration from operator movement. No persistence or
commands are added. Phones keep normal outer access to the tall application shell, with an 800px
project frame; this is the deliberate narrow-screen exception rather than a global overflow lock.

TaskHeader uses an explicit lg grid: minmax(0,1fr) identity column plus a 24rem action column with
a 160px minimum height. Below lg it stacks in a single column. Action content may expand for
feedback without moving its desktop origin or overlapping the title. TaskExecutionActions extracts
the existing Start/Stop request UI unchanged; Task Details renders it once in the header and sets
TaskExecutionPanel.showActions=false. Other panel callers keep the default inline controls.
Polling and execution/status explanations remain in the panel; request errors stay with the
controls. Queue/Return, recovery, archive, Edit and review links keep their existing components,
gates and styles. No backend, lifecycle, worktree, Git or execution behavior change.
