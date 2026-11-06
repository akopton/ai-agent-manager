# AI Agent Manager — Technical Architecture

**Status:** Draft v0.4 — execution security modes SEC-02 (§7.5) added; v0.3 added platform strategy (§16) and SEC-01 (§7.4); v0.2 added AI Conversations (§15)  
**Date:** 2026-11-04 (v0.1: 2026-11-03)  
**Product specification:** [`SPEC.md`](./SPEC.md) v0.4  
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
| `tasks` | `id`, `project_id`, `title`, `prompt`, `agent_runtime`, `model_id` nullable, `base_branch`, `priority`, `urgent`, `status`, `queued_at`, timestamps | Runtime identifiers are data, not provider-specific database tables. `model_id = NULL` means `Default`. |
| `task_runs` | `id`, `task_id`, `attempt`, `agent_runtime`, `requested_model_id`, `effective_model_id` nullable, `status`, `session_id` nullable, `started_at`, `ended_at`, `exit_code`, `signal`, `error_code`, `summary` | Snapshot runtime/model for each attempt. `(task_id, attempt)` unique. |
| `workspaces` | `id`, `task_id`, `attempt_or_generation`, `path`, `branch`, `base_ref`, `base_sha`, `status`, timestamps | Support retained workspaces across safe retries; never assume task names are unique. |
| `run_events` | `id`, `run_id`, `sequence`, `kind`, `payload_json`, `created_at` | Store normalized events. Sequence unique per run; redact secrets and cap output size. |
| `reviews` | `id`, `task_id`, `run_id`, `workspace_id`, `snapshot_hash`, `snapshot_manifest_json`, `status`, `feedback` nullable, timestamps | Review is tied to a specific filesystem snapshot, not only a task. *(M6-02, migration `0004_reviews`: implemented without the snapshot columns, which arrive with the Approve & Push snapshot; adds `inventory_revision` (the change-inventory revision the reviewer saw) and `follow_up_run_id` (the attempt that continued from a change request). `status` is `changes_requested` only so far.)* |
| `git_operations` | `id`, `task_id`, `review_id`, `kind`, `status`, `commit_sha` nullable, `remote`, `branch`, `error_json` nullable, timestamps | Durable, retryable commit and push operations. *(M6-03, migration `0005_publications`: references `publications` (`publication_id`) instead of `review_id`; one row per commit and per push attempt, with `attempt`, `outcome`, `error_code`/`error_message`.)* |
| `publications` *(M6-03)* | `id`, `request_id` unique, `task_id`, `run_id`, `workspace_id`, `status`, `failure_stage`, `inventory_revision`, `snapshot_hash`, `snapshot_json`, `base_commit`, `branch`, `remote_name`, `remote_url` (redacted), `remote_url_digest`, `commit_message`, `commit_sha`, `tree_sha`, timestamps | The Approve & Push decision, its review snapshot and publish state. Holds the documented `reviews.snapshot_*` fields, because `reviews.status` has a CHECK that only an additive table can extend. At most one active publication per task (partial unique index). |
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

## 8. Git repository and worktree management

- Register existing repositories by canonical absolute path; inspect `git rev-parse`, `git remote -v`, and base refs.
- At first run, `fetch` the selected remote and resolve the configured base branch to an exact commit SHA. If no remote ref exists, support an explicit local ref selection instead of guessing.
- Build a unique branch such as `agent/<task-short-id>-<slug>` and create worktree under a managed root **outside all connected repo checkouts and the app source**.
- For example: `~/Library/Application Support/ai-agent-manager/worktrees/<project-id>/<task-id>/<generation>/` (configurable). Existing PoC worktrees under `/Users/akopton/repos/.agent-worktrees/` may remain unchanged.
- Store canonical worktree path, task branch, remote, source ref and base SHA. Confirm expected Git common directory and branch at each mutation.
- Do not modify the user's primary checkout, merge to base branches, or create PRs in MVP.
- Handle same-name projects and same-name tasks through IDs, not folder name assumptions.
- Keep finished/discarded worktrees until explicit cleanup, including confirmation of their state and whether they contain uncommitted files.

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

*Implementation note (2026-11-05, M3-02/M3-03):* task routes are nested under their project, `/api/projects/:projectId/tasks/:taskId[/<action>]`, so a task is always resolved within the project in the URL (a task of another project is `task_not_found`). Implemented so far: list/create, details/edit, `queue` and `return-to-backlog` (the named `return_to_backlog` transition, which the table above omits). The remaining task routes in the table are expected to follow the same nesting. *(2026-11-05, M6-03: `POST …/tasks/:taskId/review/approve` and `POST …/tasks/:taskId/review/retry-push` replace `/api/tasks/:id/approve`; same Host/Origin/JSON guards.) (2026-11-05, M6-01 first slice: `GET …/tasks/:taskId/review` and `GET …/tasks/:taskId/review/diff?path=` replace `/api/tasks/:id/changes`. Both are read-only, use the loopback Host check, and reject requests the browser marks as cross-origin (`Origin` other than the app, or `Sec-Fetch-Site` other than `same-origin`/`none`).)*

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
- Preserve outputs and logs after Stop, failure and interruption. Implement configurable retention and explicit cleanup rather than deleting worktrees as a side effect of status changes.
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

> Conceptual architecture for `SPEC.md` §18. It is not implemented and does not change §1–§14. Table names, routes and module placement are illustrative and are finalized when the workstream starts (`IMPLEMENTATION_PLAN.md` §8). Statements about CLI behavior are **verification targets**, not confirmed capabilities.

### 15.1 Module placement

One **conversations** module serves both scopes (`global` and `project`). It is not split into a Global AI and a Project AI implementation.

| Concern | Location | Notes |
|---|---|---|
| Conversation, message, decision and proposal types; Zod schemas; conversation runtime policy types | `packages/core` | Framework-free, like the existing domain and security types. |
| Tables, migrations and queries | `packages/database` | Same SQLite database, WAL, foreign keys. |
| CLI invocation in Conversation Mode; per-CLI conversation capabilities | `packages/agents` | Reuses the adapter abstraction from §7 with a separate conversation entry point and separate launch profiles. |
| Turn lifecycle, context assembly, conversation pre-launch gate, proposal and decision commands | conversations module, in the worker | Preferred initial approach: start inside `packages/orchestrator`. A dedicated conversations package may be introduced later, through a documented decision, when clear modularity or dependency boundaries justify it (for example, to keep conversation code from depending on scheduler or publish modules). |
| Selected source file reads | `packages/git` | Read-only; see §15.4. |
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
- Uncommitted files from the primary checkout or a task worktree are **not supported**. A future option may allow explicit, user-selected access to uncommitted working-tree files. It would need to be separately designed, with containment and security checks equivalent to `packages/git` (canonical paths, no symlink escapes, no hooks or filters, size and type limits). The UI and the context manifest would have to state clearly that the content came from the working tree and not from a commit.
- Path-validated, size-limited, binary-aware, and recorded in the manifest with path, commit and blob ID.

All assembled context is **untrusted data** for the model and for the application. Repository files, documents, decisions and prior model output may contain prompt injection. The application never executes instructions found in context, and model output can only *propose* decisions or tasks (§15.7, §15.8).

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

### 15.7 Architecture decisions

- Drafts are created from a user action, or from a structured model proposal that is shown to the user and validated with Zod. They are never written directly by the agent.
- `proposed → accepted | rejected`; `accepted → superseded` (by a newer accepted decision). Accepting requires an explicit user command. Edits to an accepted decision create a superseding decision instead of rewriting history.
- Accepted decisions are project knowledge. They are available to all conversations of that project through context assembly and independent of any conversation's lifetime.

### 15.8 Task proposals to Backlog

- The model produces proposals in a **structured format** (for example a JSON schema). The worker parses and validates them into `draft` task proposals; invalid output is shown as text, not turned into proposals. Which CLIs support schema-constrained output is a verification target.
- Accepting a proposal calls the **same domain command as manual task creation** (M2/M3), with the same validation of runtime, model and base branch. The task is created in `Backlog`. The proposal stores `created_task_id`, and the task stores its origin references.
- For a `global` conversation, acceptance requires an explicit `target_project_id` chosen and confirmed by the user. Choosing a project does not add its context to the conversation.
- No conversation code path can enqueue a task, start a run, create a worktree or call the publish service. This is enforced by module boundaries: the conversations module only has access to task creation, never to queue, scheduler or Git mutation commands.

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

### 15.11 Verification gates and open questions

1. Per CLI: streaming format, native session resume, per-turn model switching, context limits, effective-model metadata and structured output.
2. Per CLI: a Conversation Mode launch profile with no tools or read-only tools, and adversarial verification that it cannot write files, run commands, use Git or read outside the scratch directory, using the M1-03 verification method.
3. Per CLI: whether repository instruction files, settings or memory are read from the working directory or user configuration, and how to prevent cross-project leakage through CLI-side memory.
4. Whether web search or browsing can be offered for Global AI under a verifiable policy.
5. Capacity: shared with the §6 execution slots or a separate conversation limit, and the effect of provider rate limits.
6. Context budgeting: token estimation per CLI, summary generation (which runtime and model), file size limits.
7. Project disconnect: archive, keep or delete conversations and decisions (explicit user decision per `SPEC.md` §4.1).

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
