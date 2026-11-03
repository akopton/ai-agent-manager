# AI Agent Manager — Technical Architecture

**Status:** Draft v0.1  
**Date:** 2026-11-03  
**Product specification:** [`SPEC.md`](./SPEC.md) v0.3  
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

## 4. Domain model and SQLite tables

Use Drizzle ORM with SQLite. Generate IDs in the application (e.g., UUID or ULID); do not use user-facing task numbers as primary keys. Store timestamps consistently (Unix milliseconds or ISO-8601 UTC; choose one and apply everywhere). Add foreign keys, indexed status columns, and unique constraints.

| Table | Essential fields | Notes |
|---|---|---|
| `projects` | `id`, `name`, `local_path`, `remote_name`, `default_base_branch`, `priority`, `instructions`, timestamps | `local_path` is a canonicalized absolute path; prevent duplicate connections to same repository. |
| `tasks` | `id`, `project_id`, `title`, `prompt`, `agent_runtime`, `model_id` nullable, `base_branch`, `priority`, `urgent`, `status`, `queued_at`, timestamps | Runtime identifiers are data, not provider-specific database tables. `model_id = NULL` means `Default`. |
| `task_runs` | `id`, `task_id`, `attempt`, `agent_runtime`, `requested_model_id`, `effective_model_id` nullable, `status`, `session_id` nullable, `started_at`, `ended_at`, `exit_code`, `signal`, `error_code`, `summary` | Snapshot runtime/model for each attempt. `(task_id, attempt)` unique. |
| `workspaces` | `id`, `task_id`, `attempt_or_generation`, `path`, `branch`, `base_ref`, `base_sha`, `status`, timestamps | Support retained workspaces across safe retries; never assume task names are unique. |
| `run_events` | `id`, `run_id`, `sequence`, `kind`, `payload_json`, `created_at` | Store normalized events. Sequence unique per run; redact secrets and cap output size. |
| `reviews` | `id`, `task_id`, `run_id`, `workspace_id`, `snapshot_hash`, `snapshot_manifest_json`, `status`, `feedback` nullable, timestamps | Review is tied to a specific filesystem snapshot, not only a task. |
| `git_operations` | `id`, `task_id`, `review_id`, `kind`, `status`, `commit_sha` nullable, `remote`, `branch`, `error_json` nullable, timestamps | Durable, retryable commit and push operations. |
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

On macOS/POSIX, the PoC used a dedicated process group and `SIGTERM`, followed by `SIGKILL` after a grace period. Production logic must confirm process-tree termination, handle races and retries, persist stop intent first, and release runtime capacity only after final reconciliation.

**Security gate:** Worktrees are *not* sandboxes. CLI flags and prompt-level instructions do not conclusively prevent an agent from running Git commits/pushes or accessing files outside its worktree. Before using company repositories, determine and test actual permission enforcement for each CLI (including tool policies, sandboxing, network and Git credential access). If hard guarantees cannot be established locally, document the limitation clearly and require explicit user acknowledgement rather than claiming full enforcement. Keep publication logic in a separate trusted service; reduce credentials/external side effects where practical.

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

## 10. REST API and events

Illustrative route surface (final endpoints and exact payloads will be refined during implementation):

| Method | Route | Purpose |
|---|---|---|
| `GET/POST` | `/api/projects` | List / connect local repositories |
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

Validate all bodies, route params, and query params with Zod. Use structured errors (`code`, `message`, `details`) and request/command IDs for deduplication. Never trust a browser-supplied filesystem path after project registration; resolve server-side from the database.

SSE is **one-way** for live task events. Mutations (Stop, Retry, Approve) use REST. Event IDs allow replay after browser reconnection. The DB event log is authoritative; live SSE is a projection, not state storage.

## 11. UI modules

- **Projects:** repository library; add/edit/disconnect; validate paths and remote/base branch.
- **Project Board:** reusable Kanban filtered by project ID, drag between allowed columns only.
- **Task Detail:** prompt, agent/model, base branch, run history, streaming events, actions by state.
- **Review:** change list, text/binary indication, diff, test outcomes, feedback, discard, approve and push.
- **Overview:** active runs across projects, remaining slots, queue order, tasks requiring attention, Pause Queue.
- **Settings:** global instructions, capacity limits, scheduler mode, worktree/data locations.

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
- Gate 2: verify stop and process-tree cleanup for both CLIs; retain partial files.
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

These are **explicit validation tasks**, not implied guarantees. The architecture should evolve based on their results without widening the MVP feature list.

---

**Next:** Write `IMPLEMENTATION_PLAN.md`, then implement the first vertical slice: Git repository registration, durable task state, and one agent run on a disposable repository.
