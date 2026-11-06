# AI Agent Manager — Product Specification (MVP)

**Status:** Draft v0.6 — task archiving (§7.1) and managed worktree cleanup (§9.1) accepted for Manual Task Management v1 (TM-02); v0.5 added execution security modes (Trusted Local / Strict Isolated, §12.1); v0.4 specified AI Conversations (§18)  
**Date:** 2026-11-06 (v0.5: 2026-11-04, v0.3: 2026-11-03)  
**Product type:** Local-first web application for orchestrating coding agents  
**Audience:** Single user (the application owner)

> **Purpose:** Define **what** the application must do, its product constraints, and acceptance criteria. API design, database schemas, code organization, adapter internals, and process management belong in `ARCHITECTURE.md`.

## 1. Product vision and principles

AI Agent Manager is a local control center for software development tasks executed by **Claude Code** and **OpenAI Codex**. It connects existing local Git repositories (including repositories hosted on GitHub or Gitea), provides a separate Kanban board for each project, schedules tasks across agents, and enables human review before any generated changes are committed or pushed.

**Primary workflow:** select project → create task with prompt and agent → enqueue → create dedicated branch and Git worktree → execute → review → approve → commit and push to the task branch.

A planned **AI Conversations** capability adds project-scoped (**Project AI**) and project-independent (**Global AI**) discussion, planning, architecture decisions and task proposals. It is specified in §18 and is not part of the MVP acceptance criteria in §14.

Core principles:

1. The application runs locally. Its metadata database and managed worktrees are stored on the user's computer.
2. Agents work in **dedicated per-task worktrees**, never directly in the user's primary repository checkout.
3. MVP supports two agent runtimes: Claude Code and Codex, with **at most one running task per runtime** by default, regardless of model selected.
4. Agents must not independently publish changes. **Only explicit user approval triggers commit and push.**
5. The application never automatically merges into `main`, `master`, `develop`, or any other base branch.
6. Stopping an agent, closing the application, or discarding a result must not silently delete generated files.
7. Tasks are independent in MVP. The user manually controls task ordering and branch selection; automatic task dependencies are out of scope.
8. User-facing discussions may be in Polish, while product documentation, agent instructions, technical prompts, code, and the application's UI are written in **English**.
9. AI conversations (§18) are advisory: they never start agents, modify repositories, or publish changes. Their proposals take effect only after explicit user approval.

## 2. MVP scope

### In scope

- Library of multiple local Git repositories stored in unrelated filesystem locations.
- Standard Git repositories regardless of hosting provider (GitHub, Gitea, or any Git-compatible remote).
- Separate Kanban board and task collection for every project.
- Global dashboard showing running tasks, queued work, tasks requiring attention, and agent utilization.
- Global and per-project agent instructions, augmented by task prompts and existing repository instruction files.
- Assignment of either Claude Code or Codex to each task, with an optional **task-level model selection** (`Default` or a supported model identifier).
- Project default base branch with a task-level override.
- Dedicated task branch and Git worktree created when execution begins.
- Persistent global queue, project and task priorities, and one active task per agent; ability to pause scheduling.
- Run, Stop, Retry, and conditional Resume support; partial changes are preserved.
- Execution history, statuses, logs, and observable results.
- Review of tracked and untracked file changes; follow-up prompt during review; discard or approve changes.
- Commit and push approved changes **only to the task branch**, without merging.
- Detection of unexpectedly interrupted tasks on application startup.

### Out of scope

- Multi-user accounts, permissions, collaboration, and shared boards.
- Hosted execution, remote runners, or internet-accessible control of the application.
- Automatically detecting, enforcing, or scheduling task dependencies.
- Live conversational input or answering agent questions **while a task runs**. Follow-up prompts are provided after execution, during review. (AI Conversations, §18, are separate from task execution and do not change this.)
- Automated code review by another agent or side-by-side solution comparison.
- Automatic merges, pull request creation, and GitHub/Gitea API integrations.
- User-installable adapters for new agent CLIs, arbitrary custom providers, and multiple named configuration profiles for the same CLI. The implementation should remain adapter-extensible without a plugin-management UI.
- Cost/token analytics and detailed historical reporting.
- Automatic resolution of merge conflicts and dependency-aware scheduling.

## 3. Domain concepts

| Concept | Definition |
|---|---|
| **Project** | An entry representing an existing local Git repository and its base branch, remote, priority, and instructions. |
| **Task** | A Kanban item containing a title, prompt, priority, selected agent runtime, optional model selection, and base branch. |
| **Task Run** | A single execution attempt; a task may have multiple runs. |
| **Agent runtime** | A supported local coding CLI/adapter: Claude Code or OpenAI Codex. Each runtime has a shared execution-capacity limit across its models. |
| **Model selection** | A task-level option: `Default` (defer to the CLI configuration at run time) or an explicit model identifier supported by the chosen runtime and user account. |
| **Agent adapter** | The runtime-specific integration behind a common execution contract, allowing future agent runtimes to be implemented without changing task or scheduling concepts. |
| **Workspace / Worktree** | A dedicated Git working directory for a task. |
| **Base branch / base SHA** | The selected starting branch and the precise commit used to create a task branch. |
| **Review** | The stage where the user inspects generated changes and decides what happens next. |
| **Scheduler** | The global component that selects eligible queued tasks for available agents. |
| **Conversation** *(planned, §18)* | A persisted AI discussion with scope `global` (no project) or `project` (exactly one project). |
| **Execution Mode / Conversation Mode** *(planned, §18)* | Execution Mode performs a Kanban task in a worktree; Conversation Mode discusses and plans, with no repository write access by default. |
| **Architecture decision** *(planned, §18)* | A user-approved, durable project knowledge record that is independent of the conversation it came from. |
| **Task proposal** *(planned, §18)* | An AI-drafted task that becomes a `Backlog` task only after user review and approval. |

## 4. Screens and navigation

### 4.1 Projects library (`Projects`)

- Display all connected projects, including name, local path, remote, default base branch, and basic task counts.
- Add a project by selecting or entering an **existing local directory**.
- Validate that the directory exists and is a Git repository; detect remotes and available branches; allow selection of a default base branch.
- A repository **does not** have to be located inside the AI Agent Manager source directory.
- Edit project name, priority, instructions, and repository settings.
- Removing a project from the library must **not** delete its Git repository. Warn when tasks or retained worktrees are associated with it, and require an explicit decision about those resources.

### 4.2 Project Kanban (`Project Board`)

- Show only tasks belonging to the selected project.
- Primary columns: **Backlog**, **Queued**, **In Progress**, **Review**, **Done**.
- Additional supported states: **Stopped**, **Interrupted**, **Failed**, **Discarded**. These may be surfaced via supplementary columns, filters, or conspicuous status indicators; final UX remains an implementation design decision.
- Moving a task into `Queued` explicitly makes it eligible for automated execution; this **does not guarantee immediate execution**.
- Task cards show at least title, agent runtime, selected model (or `Default`), priority, status, and branch information.
- Archived tasks (§7.1) are hidden from the default board and listed in a separate **Archived tasks** view of the same project, where they can be opened and restored.
- Task details expose the prompt, run history, logs, results, changed files, and actions appropriate to its state.

### 4.3 Global dashboard (`Overview`)

- Show currently running tasks across all projects.
- Show counts for queued tasks, reviews pending, and attention-required issues (`Failed`, `Interrupted`, failed pushes).
- Display Claude and Codex runtime capacity, such as `0/1` or `1/1`, regardless of which model a task selects.
- Preview upcoming queue order, including project, priority, and assigned agent.
- Provide global `Pause Queue` / `Resume Queue` controls and direct navigation to individual tasks.

### 4.4 Settings

- Global agent instructions.
- Agent runtime availability and execution limits; MVP defaults to **one concurrent task per runtime**.
- No separate named agent profiles in MVP; model choice is configured on each task.
- Scheduler mode: automatic queue processing or manual execution; automatic is the default.
- Managed data and worktree locations, without requiring manual folder maintenance during regular use.

## 5. Task creation and configuration

### Required fields

- Project.
- Title.
- Task description / prompt.
- Agent runtime: `Claude Code` or `Codex`.
- Model: `Default` (the initial selection) or an explicit model from the selected runtime's supported choices.
- Base branch (inherited from the project by default, overridable per task).

### Optional MVP fields

- Priority: `Critical`, `High`, `Normal`, `Low` (default: `Normal`).
- `Urgent` flag to override normal queue ordering.
- Creation timestamp and queue-entry timestamp.

Model selection requirements:

- Switching the agent runtime resets any incompatible model selection to `Default` rather than silently passing a model intended for another runtime.
- `Default` means **do not pass an explicit model override** to the CLI; use whatever model its local configuration resolves when the run begins.
- For explicit selections, store the **actual CLI model identifier** rather than only a friendly display label.
- The UI must not promise that a model is available merely because it appears in a list. Actual support depends on installed CLI version, account entitlements, and current provider availability.
- MVP may provide a small maintained list of candidate model identifiers for each runtime; automatic discovery of an authoritative available-model catalog is not required. Invalid or unauthorized model choices must fail transparently with a recoverable task state and actionable feedback.

New tasks start in `Backlog`. Saving a task **must not** launch an agent or create a worktree.

## 6. Global scheduler

- A single scheduler coordinates tasks across all projects.
- Only explicitly queued, eligible tasks may be started.
- Default ordering: `Urgent` → project priority → task priority → time enqueued.
- If the top task requires a busy agent, the scheduler may start a lower-ranked eligible task assigned to a free agent; one busy provider must not block the other.
- MVP limit: **one active Claude Code task and one active Codex task**, for a maximum of two simultaneous runs. Selecting different models for the same runtime does **not** create additional slots.
- `Pause Queue` prevents **new** runs from starting but does not stop active runs.
- Priority changes affect **future** scheduling and do not preempt running tasks.
- Claiming a task and reserving an agent slot must be atomic to prevent duplicate or over-capacity execution.
- Interrupted tasks must not be restarted automatically after application recovery.

## 7. Task lifecycle

### Product-level states

| State | Meaning | Available actions |
|---|---|---|
| `Backlog` | Saved but not authorized to execute. | Edit, move to `Queued`. |
| `Queued` | Waiting for scheduler and agent availability. | Reprioritize, return to `Backlog`. |
| `In Progress` | An agent process is working. | Inspect logs, **Stop**. |
| `Review` | Execution ended and changes await a decision. | **Approve & Push**, **Request Changes**, **Discard**. |
| `Stopped` | The user intentionally stopped execution. | Inspect, Resume, Discard. *(Retry from this state: future, §11.)* |
| `Interrupted` | Execution was unexpectedly interrupted or could not be reconciled on restart. | Inspect, Resume, Discard. *(Retry from this state: future, §11.)* |
| `Failed` | Execution failed. | Inspect, Retry, Discard. |
| `Discarded` | The user rejected the result. | Inspect history; Remove local worktree when eligible (§9.1). |
| `Done` | Approved changes were committed and successfully pushed to the task branch. | Inspect commit, branch, and history; Remove local worktree when eligible (§9.1). |

Archive and Restore (§7.1) are not lifecycle actions and do not appear in this table: they change only whether a task is shown on the default board.

### Lifecycle rules

- Task status and individual `Task Run` status are distinct; a new attempt does not overwrite previous run history.
- `Request Changes` creates a **new run** incorporating review feedback while preserving the existing task branch/worktree; resume the agent session when feasible.
- On execution error, preserve files and present diagnostics. Exit code `0` alone does not prove that the implementation is correct.
- `Done` requires both a successful commit **and** a successful push. If push fails after commit, retain the commit and allow a safe push retry without duplicating it.
- Completed and discarded tasks remain in history until explicitly deleted by the user. *(Permanent task deletion is deferred; Manual Task Management v1 offers only reversible archiving, §7.1.)*
- *(TM-03, 2026-11-06.)* Returning a `Queued` task to `Backlog` also withdraws its pending start request: queueing it again never inherits an earlier Start. Once a task has a worktree (it has run at least once and was returned to `Backlog` after Request Changes, Retry or Resume), its base branch can no longer change, because later attempts continue in that worktree; other fields stay editable in `Backlog`.

### 7.1 Task archiving

**Accepted v1 behavior (Manual Task Management v1, TM-02, decided 2026-11-06):**

- **Archive** is a reversible, organizational **visibility flag**. It is not a lifecycle state, not an execution outcome, and not deletion. It is separate from `Discarded` (a decision about the result) and from Remove local worktree (§9.1).
- An archived task keeps its **original status** and its complete history: runs, events, review decisions, Retry/Resume decisions, publications, Git operations, workspace records and timestamps. Archiving or restoring does not change the task's update time.
- Archiving never starts an agent, performs a Git operation, or removes a worktree or branch.
- **Eligible to archive:** `Backlog`, `Done`, `Discarded`, `Failed`, `Stopped`, `Interrupted`, and only while no run is active, no start request is pending, no Approve & Push publication is active or waiting for a push retry, and no worktree removal is requested or running.
- **Not eligible:** `Queued`, `In Progress` and `Review`; they still wait for the worker, an agent or an operator decision.
- **Visibility:** archived tasks are hidden from the default board and from the project's active task counts; they are listed in the project's Archived tasks view (with a separate count) and remain fully inspectable on their task page, including Review Changes and the worktree panel.
- **While archived** the task accepts no lifecycle action or edit (Queue, Retry, Resume, Discard, Request Changes, Approve & Push, field edits); the user restores it first. Remove local worktree (§9.1) stays available, because it does not change the task.
- **Restore** returns the task to the board with the status it had. Archive and Restore are idempotent.

## 8. Agent execution and instructions

- The system exposes two execution adapters for authenticated local Claude Code and Codex tooling. Both implement a common execution contract so a future third runtime can be added in code without redesigning tasks, the scheduler, or reviews.
- The UI offers one agent runtime selector and one **model selector per task**, not multiple named profiles of the same CLI.
- Before execution, each adapter translates the optional model identifier to its supported CLI option; when the selection is `Default`, it supplies no explicit model argument.
- An unsupported, retired, or unauthorized model must produce a clear error; the runner must not silently substitute an unrelated model.
- Every run must record the **requested model selection** as a snapshot. Record the **effective model actually used** when the CLI provides trustworthy metadata; otherwise mark it as unknown rather than assuming the requested or default model was used.
- Each run receives the task prompt, global instructions, project instructions, worktree context, and relevant repository instructions such as `CLAUDE.md` or `AGENTS.md`.
- Global and per-project instructions are separate. Existing repository instruction files must not be overwritten automatically.
- **MVP does not support interactive follow-up prompts while the agent is running.** If execution requires interaction, surface a recoverable error or attention-required condition; the user may provide feedback at the review stage.
- Capture at minimum: start/end time, run status, logs/events, agent summary where available, session identifiers when available, and worktree changes.
- Distinguish **process completion** from **human acceptance of generated code**.

## 9. Git and worktree strategy

1. Each task receives a dedicated branch, for example `agent/TASK-123-short-description`, and a dedicated Git worktree.
2. Create the branch and worktree **only when the task first starts**, not at task creation.
3. Every project has a default base branch. Tasks may select another existing branch, including a previously published branch from another task.
4. Before creating a worktree, refresh remote refs (`git fetch`). Resolve the selected base ref (usually its remote-tracking branch) at **execution time**, and persist the exact base commit SHA.
5. The user manually decides when dependent work can start and which base branch it should use. No dependency engine is included in MVP.
6. Worktree operations must not alter the user's primary checkout or currently checked-out branch.
7. Managed worktrees are stored **outside both the AI Agent Manager source repository and the connected project's primary checkout**. The PoC used `/Users/akopton/repos/.agent-worktrees/`; the production location is managed and configurable.
8. Worktree paths must remain unique even when different projects share a display name (e.g., use internal project and task IDs).
9. Use the repository's existing Git remote and local authentication (GitHub, Gitea, etc.); hosting-provider APIs are not required for MVP.

### 9.1 Managed worktree cleanup

**Accepted v1 behavior (Manual Task Management v1, TM-02, decided 2026-11-06):**

- Each task page shows its managed worktree: local path, task branch and commit, base branch and commit, lock state, working-tree state, Git-ignored files, identity verification, and whether removal is available, with every reason when it is not. The listing is read-only.
- **Remove local worktree** is an explicit action with its own confirmation. It is never a side effect of a status change, of Archive, of Discard, or of a schedule; there is no automatic cleanup, retention policy or garbage collection in v1.
- Only an eligible **managed task worktree** may be removed: the worktree recorded for the task's latest attempt, registered with Git as a linked worktree of the registered repository, locked by AI Agent Manager, at its managed location under the configured worktree root, and on the task branch. The main project checkout, other worktrees, and paths supplied by the browser are never targets.
- **Done tasks** are eligible only with a recorded successful push of the latest attempt from that worktree, and only when HEAD and the local task branch are exactly at the pushed commit.
- **Discarded tasks** are eligible only when HEAD and the task branch are still at the recorded base commit (the attempt left no commits).
- In both cases the worktree must contain **no** staged, unstaged, conflicted, untracked or **Git-ignored** files.
- **Refused** (fail closed, with a reason): any other task status (`Review`, `Failed`, `Stopped` and `Interrupted` can still continue in the worktree, `Queued` and `In Progress` may be executing); a pending follow-up attempt or publication; unpublished work, unexpected commits, a switched or moved branch, a missing lock, a relocated worktree, ignored files, or state that cannot be verified.
- Removal deletes only the worktree directory and its Git registration with a non-forced `git worktree remove`. **Local and remote branches are kept**, and nothing is committed, pushed, reset or cleaned.
- The checks run again immediately before removal; if anything changed, nothing is removed. Repeated requests are deduplicated, a request not picked up promptly expires, and an interrupted removal is reconciled from Git state and never resumed automatically.
- Task, run, review, publication and workspace records are kept; the removal and its outcome are recorded, and the task page and Review Changes explain that the worktree was removed.
- **Deferred:** permanent task deletion, forced removal or discarding of uncommitted/untracked/ignored files, local or remote branch deletion, and automatic retention.

## 10. Code review and publishing

### Review experience

- After an agent finishes, enumerate all worktree changes: modified files, new **untracked** files, deleted files, and renames where detectable.
- Show text diffs and identify binary files; allow opening the worktree in an editor.
- Display the agent's summary and any **actually available** test results. Never imply tests were run if they were not.
- Support three decisions:
  - **Request Changes:** supply another prompt; enqueue a subsequent run on the same task/worktree; resume the agent session where supported.
  - **Discard:** reject the result without committing or pushing; preserve history and require an explicit decision before deleting worktree data.
  - **Approve & Push:** approve the reviewed set of changes, then commit and push to the task branch.

### Approve & Push requirements

- Before committing, verify that the current files **still match the exact reviewed snapshot**. If anything changed since review, require a new review.
- Revalidate the worktree, current branch, and relevant Git conditions before mutating repository history.
- Create a meaningful commit message linked to the task ID/title, and record the resulting SHA.
- Push **only to the task branch** on the configured remote.
- **Never merge automatically** into the base branch or open a pull request in MVP.
- On commit/push failure, preserve state, present a clear error, and allow retrying the failed step without accidentally repeating completed operations.
- Approval/publishing is distinct from any later integration of the task branch by the user.

## 11. Stop, retry, resume, and crash recovery

### Stop

- The user can stop a task only while it has an active run.
- Request graceful agent termination, then force termination after a defined timeout when necessary.
- Release an agent slot only after confirming that the run is no longer active; consider child processes as well as the parent process.
- Stop terminates the agent CLI's **process group**. Descendants that started their own process group or session may survive (SEC-01). The UI describes Stop accordingly and never claims that every descendant process was terminated.
- **Never delete the worktree or partial output automatically.**
- Move the task to `Stopped` and allow inspection of remaining changes.

### Retry and Resume

**Accepted v1 behavior (Manual Task Management v1, TM-01, decided 2026-11-05):**

- **Retry** (from `Failed`) and **Resume** (from `Stopped` or `Interrupted`) only return the task to `Queued`. No agent starts until the user explicitly clicks Start execution, which applies the normal consent, trust and capacity checks.
- **Retry** continues in the task's existing worktree and keeps its partial changes (tracked and untracked). If the worktree cannot be continued safely (moved, unlocked, branch switched, commits made), Retry is refused and nothing is reset, cleaned or recreated. If the failed attempt ended before a worktree existed, the next Start creates one.
- **Resume** starts a **new** agent CLI session in the retained worktree, with the original prompt and a note that earlier changes are present. The previous Claude Code/Codex conversation is not restored.
- When a previous agent process may still be running, the app **fails closed**: it refuses while the recorded process group still exists, and when that cannot be determined it requires the user to confirm that the old agent is no longer running. The app cannot detect processes that left the agent's process group (§11 Stop, SEC-01).
- Pending review feedback of a failed follow-up attempt is sent again with the retried attempt.

**Future capabilities (not in v1):**

- **Retry from scratch:** a fresh, safe workspace from the base branch, or an explicit choice of how to handle existing partial changes; never overwriting them silently.
- **Native session resume:** continue the previous agent conversation, only when the particular adapter supports session continuation and the workspace remains compatible. Not guaranteed.
- Retry from `Stopped`/`Interrupted` as an action distinct from Resume.
- Retain the history and inspectable results of previous attempts.

### Application shutdown and restart

- On orderly shutdown, the worker attempts to stop its active runs cleanly while preserving files and metadata.
- Sudden shutdown or system failure may interrupt agents without warning. At startup, reconcile persisted run state against actual processes and worktrees.
- Unresolved runs become `Interrupted` and appear prominently on the dashboard.
- **Never automatically restart interrupted tasks.** The user decides whether to inspect, retry, or resume.
- Preserve stable identifiers and logs for troubleshooting.

## 12. Safety and data integrity

- The product is **single-user and local-first**, but coding agents can execute commands on a real machine. A Git worktree **is not a security sandbox**.
- Agents must not commit, push, switch branches, write outside authorized workspaces or access sensitive files. **Prompt instructions alone are insufficient.** How this is handled depends on the execution security mode (§12.1):
  - In **Strict Isolated Mode**, the required restrictions must be enforced and independently verified.
  - In **Trusted Local Mode**, they are **not** enforced. The limitation is communicated explicitly, and unexpected Git mutations are detected after each run.
- Verify actual tool permissions/sandbox guarantees for both adapters during implementation. Do not claim protections that cannot be enforced.
- Do not store provider passwords or authentication tokens in SQLite. Reuse official local CLI login flows and existing Git authentication.
- Validate paths, Git refs, branch names, and execution arguments. Avoid interpolating untrusted values into shell command strings.
- Destructive operations (including discarding files or removing worktrees) require explicit confirmation and must never target a primary repository checkout implicitly.
- Keep the local API bound to localhost by default, with appropriate protections against untrusted origins and cross-site requests.

### 12.1 Execution security modes (SEC-02, decided 2026-11-04)

**Personal-use MVP threat model.**

- **Who and what.** One trusted human operator on their own macOS account. Repositories are owned by the operator or come from trusted collaborators. Claude Code and Codex are the CLIs the operator already uses manually. There is no multi-user or hosted execution.
- **What is still not trusted:**
  - The agent's behavior: model mistakes, overreach, and prompt injection from repository content, dependencies, tool output or fetched web content.
  - Third-party code the agent runs, such as package installs and build scripts.

  The agent therefore runs with the operator's account permissions but is **not** treated as trusted.

**Trusted Local Mode** (MVP execution mode):

- **Explicit opt-in.**
  - The operator enables it in Settings after reading a versioned disclosure. It is off by default.
  - Each repository must be marked trusted for local execution.
  - A changed disclosure requires renewed acceptance.
- **Safeguards that still apply:**
  - the verified repository and task worktree;
  - the verified CLI binary and version, the exact arguments, working directory and environment bound to the authorization;
  - no elevated privileges;
  - mandatory timeouts, output limits and cancellation;
  - the existing worktree lifecycle safeguards;
  - publishing (commit and push of the task branch) only through the trusted Approve & Push flow.
- **The UI states plainly, before enabling and on every run:**
  - The worktree is the agent's working directory, **not** an OS-enforced boundary.
  - The agent may read and write other files, use local credentials (SSH keys, Git credential helpers, CLI logins) and reach the network, as far as the operator's account allows.
  - The agent **could independently run `git commit` or `git push`** if its CLI tools and the OS allow it. The application detects unexpected Git mutations after the run where it can, but does not prevent them.
  - Stop terminates the process group, not every possible descendant.
  - The agent CLI may keep its own local records outside the application's control. Claude Code can persist session transcripts under `~/.claude/projects/`, which may include prompts, replies, tool inputs and repository content.
  - A run that ends successfully does not show that the task was done. Only the change review shows what changed.

**Strict Isolated Mode** (deferred):

- Every required control must be enforced by a mechanism that has been independently verified for the exact CLI version and launch configuration. The gate is fail-closed.
- It is not available until verified enforcement exists. That needs the deferred VM-based verification (M1-04B.2) and OS-level isolation work.
- It is never silently downgraded to Trusted Local Mode.

**Rules for both modes:**

- Each run records the mode it ran under.
- No mode borrows the other's security claims.
- Risk acknowledgements never authorize Strict execution.
- Conversation Mode (§18) needs its own, separate opt-in and never gains repository write or task-start permissions from Execution Mode settings.

## 13. Persisted data

One local SQLite database stores **metadata**, while source code remains in Git repositories and worktrees.

Required data domains:

- **Projects:** name, local path, remote, default base branch, priority, instructions.
- **Tasks:** project, title, prompt, agent runtime identifier, selected model identifier or `Default`, priority, base branch, status, archived time (§7.1).
- **Task runs:** attempts, run status, timestamps, exit information, agent runtime identifier, requested model snapshot, effective model if verifiable, agent session ID, logs/events.
- **Workspaces:** worktree path, task branch, base SHA, lifecycle/resource state, and the history of worktree removal requests and their outcomes (§9.1).
- **Reviews:** feedback, reviewed change snapshot, decisions, decision history.
- **Git operations:** commit SHA, remote/branch push target, operation state and errors.
- **Scheduler settings:** paused state, scheduling mode, availability and concurrency limits **per agent runtime**, not per model.

Recorded history must allow the user to reconstruct the sequence of runs, reviews, and publishing decisions for each task.

## 14. MVP end-to-end acceptance criteria

The MVP is complete when the following scenarios work on a safe test repository:

1. **Connect a project:** register an existing local Git repository, detect its remote, and set a default base branch without modifying unrelated directories.
2. **Multiple projects:** connect a second repository and switch between isolated project Kanban boards.
3. **Task, model, and base branch:** create a task with agent runtime, `Default` or explicit model, prompt, and an overridden base branch; the task does not run until explicitly queued.
4. **Execution:** moving a task to `Queued` eventually starts the assigned agent in a newly created task branch/worktree and records the base SHA.
5. **Capacity:** two Claude tasks never run concurrently even if they select different Claude models; an available Codex can run alongside one Claude task.
6. **Dashboard:** show running, queued, review-ready, and attention-required tasks across all projects.
7. **Stop:** stopping a running task terminates its execution (the agent CLI's process group; surviving descendants outside the group are a documented limitation, SEC-01), preserves generated files, frees agent capacity, and allows inspection.
8. **Crash recovery:** after unexpected shutdown and restart, the app marks unreconciled runs `Interrupted`, preserves worktrees, and does not restart them without user action.
9. **Review:** show tracked and untracked changes; a follow-up prompt during review triggers a further run for the same task.
10. **Discard:** discarding does not publish code or silently delete the workspace.
11. **Approval:** `Approve & Push` verifies the reviewed snapshot, commits changes, and pushes **only to the task branch**, without merging it.
12. **Review consistency:** changes appearing after review block approval until reviewed again.
13. **Push failure:** an authentication or network error is visible and the push can be retried without duplicating the commit.
14. **Instructions:** global and project-specific instructions are supplied to the relevant agent execution.
15. **Queue pause:** pausing the scheduler prevents new runs from starting while leaving current runs untouched.
16. **Model selection:** task creation defaults to `Default`; an explicit model is passed to the selected runtime when supported; switching runtimes clears incompatible model choices.
17. **Model errors and history:** a model rejected by the CLI is surfaced as a recoverable error without a silent fallback, and each run preserves its requested model plus the effective model when verifiable.
18. **Security mode (added 2026-11-04, SEC-02):**
    - No task executes until the operator has explicitly enabled Trusted Local Mode and marked the repository as trusted.
    - The UI shows the mode and its disclosure for every run.
    - An agent commit, push to a local-path remote, or change to shared Git metadata or the main checkout during a run is reported after the run and blocks `Approve & Push` until the operator reviews it.

## 15. Verified proof-of-concept findings

The following behaviors were **manually verified** on macOS with a local test Git repository and separate worktrees:

- Claude Code and Codex CLIs were installed and authenticated.
- Both agents were launched from a TypeScript/Node.js script and created files inside the specified Git worktree.
- For Claude, runner `TASK-003` exited with code `0`, leaving `math-utils.ts` untracked.
- Stopping Claude in `TASK-005` terminated its process (observed exit code `143`) while partial changes remained on disk.
- Stopping Codex in `TASK-006` terminated its process via `SIGTERM`, with partial changes still present.
- Independent worktrees were successfully created from the same `main` commit.

**Not yet verified:** reliable session resumption, child-process cleanup after cancellation, restart reconciliation, enforced Git commit/push restrictions, complete automated change review, and the `Approve & Push` flow.

## 16. Open design decisions for `ARCHITECTURE.md`

These decisions do not change MVP scope but must be resolved before implementation:

- How to enforce agent command restrictions and prevent commits/pushes outside the human approval flow. *(Decided for the MVP: Trusted Local Mode does not enforce them; it discloses and detects. Enforcement is the deferred Strict Isolated Mode, §12.1.)*
- Internal separation and transitions for task, run, and Git-operation states.
- Reliable worker communication and UI log streaming.
- Log storage format, retention, and disk usage policy.
- Worktree cleanup policy after `Done` or `Discarded`. *(Decided for Manual Task Management v1: explicit, confirmed, fail-closed removal of eligible worktrees only, §9.1. Retention policy and forced cleanup remain open.)*
- Safe retry semantics when a previous attempt left partial files.
- UX for auxiliary states (`Failed`, `Stopped`, `Interrupted`, `Discarded`).
- How to maintain candidate model lists, validate model identifiers, and capture verifiable effective-model metadata for each CLI.
- Review snapshot integrity checks and staging rules for untracked files.
- AI Conversations technical questions are tracked separately in §18.12.

## 17. Agreed technology direction

| Area | Technology |
|---|---|
| Language | TypeScript |
| Web application | Next.js + React |
| UI | Tailwind CSS + shadcn/ui |
| Drag and drop | dnd-kit |
| Backend / worker | Node.js + TypeScript; independent local agent worker |
| Persistence | Local SQLite + Drizzle ORM |
| Validation | Zod |
| Coding agents | Claude Code + OpenAI Codex (official CLI/SDK), adapter-extensible |
| Model choice | Selected per task; `Default` or explicit runtime-supported model ID |
| Git | Git CLI + Git worktrees |
| Live updates | Server-Sent Events (SSE) |
| Queue | Durable SQLite-backed queue |
| Repository organization | pnpm workspaces |

## 18. AI Conversations (planned extension)

### 18.1 Status and scope

AI Conversations is an agreed product capability, specified here so that the MVP's data model and adapter boundaries do not block it. It is **not part of the MVP acceptance criteria in §14**. It is delivered as a separate workstream (`IMPLEMENTATION_PLAN.md` §8) and has its own acceptance criteria (§18.11).

AI Agent Manager then has three complementary capabilities:

| Capability | Purpose |
|---|---|
| **Projects & Kanban** | Manage local Git projects, delegate tasks to Claude Code or Codex, execute them in isolated worktrees, review, approve and publish (§1–§17). |
| **Project AI** | Discuss, plan, evaluate architecture, record decisions and propose tasks **within one project's context**. |
| **Global AI** | General conversations, analysis, brainstorming, research and summaries **without any project association**. |

Project AI and Global AI are two **scopes** (`project` and `global`) of one shared **AI Conversations** module, not separate implementations.

Nothing in this section changes the existing requirements for Kanban, scheduling, agent execution, Git safety, worktrees, review, approval or publishing. In particular, conversations never start agent execution, never modify repositories and never publish changes.

The "no live conversational input while a task runs" exclusion (§2) still applies. AI Conversations are not a channel into a running task.

### 18.2 Execution Mode and Conversation Mode

| | **Execution Mode** (existing) | **Conversation Mode** (new) |
|---|---|---|
| Purpose | Perform a Kanban task | Discuss, plan, analyze, propose |
| Trigger | Scheduler claims a queued task | User sends a message |
| Workspace | Dedicated task worktree | No repository workspace; the application supplies context |
| Repository write access | Within the task worktree only | **None by default** |
| Results | Worktree changes → review → approve → publish | Messages, proposed decisions, proposed tasks; all require user approval |
| Lifecycle | Task runs (§7) | Conversation turns (§18.9) |
| Capacity | One active task per CLI (§6) | Not yet decided (§18.12) |

Both modes may share adapter infrastructure (CLI discovery, process execution, model selection, event normalization). Each mode has its own runtime policy and lifecycle.

**Conversation Mode is not described as read-only, sandboxed or isolated unless that is actually enforced** by verified runtime isolation for the selected CLI, as required for Execution Mode by M1-03. Instructions to the model are defense in depth, not enforcement.

**Security modes (§12.1).** Conversation Mode can also run in a Trusted Local variant. It needs its **own** opt-in and disclosure, separate from Execution Mode's. Execution Mode acceptance or repository trust never enables conversations, and conversation acceptance never grants a worktree, repository write access, task queueing or publishing. In Trusted Local conversations, the CLI still runs in a scratch directory with a conversation launch profile (preferring no tools). The UI states that the CLI may read files the operator's account can read, and never calls the conversation read-only unless that is enforced.

### 18.3 User stories

1. As the user, I start a global conversation to brainstorm or analyze something unrelated to my projects, choosing Claude Code or Codex and optionally a model.
2. As the user, I keep several global conversations and return to any of them later.
3. As the user, I open a project's AI section and start a conversation that already knows the project's approved documentation and accepted decisions.
4. As the user, I add specific source files to a project conversation so the agent can analyze them, without letting it change the repository.
5. As the user, I run several conversations for one project (for example "auth redesign" and "test strategy"), each with its own history and shared project knowledge.
6. As the user, I turn a conclusion from a conversation into an architecture decision, review it and accept it so it becomes project knowledge.
7. As the user, I ask the AI to break a feature into tasks, edit the proposals, and create the ones I approve in the project's Backlog.
8. As the user, I ask a global conversation to propose tasks and explicitly choose which project they belong to before anything is created.
9. As the user, I switch a conversation to another agent or model for future messages without losing its history.
10. As the user, I stop a response that is taking too long, and see a clear error when a CLI fails.

### 18.4 Agent and model selection

- Conversations use the **locally installed CLIs supported by AI Agent Manager**: Claude Code and Codex initially, through the same adapter abstraction as Execution Mode.
- Direct provider APIs, separate API keys or separate API billing are **not required**. Authentication reuses the CLIs' official local login, as in §12.
- Each conversation has a current agent runtime and model selection (`Default` or an explicit model identifier), with the same rules as tasks (§5, §8). `Default` passes no model override; unsupported models fail visibly, with no silent fallback.
- The user may change the runtime or model for **future** messages. Past messages keep the runtime and model that produced them.
- Each assistant message records the requested runtime and model, and the effective model only when the CLI reports it trustworthily.
- Claude Code and Codex are **not assumed** to offer identical streaming, session persistence, model switching, context limits or security controls. These are capabilities to verify per CLI (§18.12).

### 18.5 Global AI

- The user can create, list, rename, archive and delete multiple global conversations.
- A global conversation is **not associated with any project**.
- It is suitable for general discussion, technical analysis, brainstorming, summaries and research.
- Its history is stored locally in SQLite.
- It **never automatically receives** project repositories, project documents, decisions, task history or other private project context. Including project material in a global conversation requires an explicit user action for that specific content.
- The user chooses the agent runtime and model.

### 18.6 Project AI

- Each project conversation belongs to **exactly one project**; a project can have many conversations.
- Project conversations share relevant **project knowledge** but keep separate message histories.
- Project context may include, as selected or configured by the user:
  - project instructions and approved project documentation;
  - accepted architecture decisions (§18.7);
  - task history (titles, prompts, outcomes, review notes);
  - **explicitly selected** source files from the project's repository.
- File access is **read-only by default**. Files are read by AI Agent Manager and passed as context. The agent is not given a repository or worktree path to work in. This describes what the application grants; it is not a claim of enforced isolation (§18.2).
- The user can see what context is sent with each message.
- Project conversations **never modify repository code**. Implementation happens only through tasks (§18.8) in Execution Mode.
- Context from one project is never included in another project's conversations or in a global conversation without explicit user authorization.
- The user chooses the agent runtime and model.

### 18.7 Architecture decisions

- From a project conversation, the user (or the AI, on request) can draft an **architecture decision**: title, context, decision, consequences and alternatives considered.
- A draft becomes project knowledge **only after explicit user approval** (`Proposed` → `Accepted`). The user can edit it before accepting, or reject it.
- Accepted decisions are stored as project knowledge **independently of the conversation**. They remain available, and may be included in future project context, even if the originating conversation is deleted.
- Deleting a conversation never deletes accepted decisions. A decision keeps a reference to its origin while that conversation exists.
- A later decision can supersede an accepted one. History is retained; the superseded decision is marked, not deleted.
- Decisions are stored in the application database. Exporting them to repository files (for example ADR Markdown) is not automatic. Any export would go through the normal reviewed and approved change flow.

### 18.8 Planning-to-Kanban workflow

```text
Conversation → Proposed Plan → Task Proposals → User Approval → Project Backlog
            → Manual Queueing → Agent Execution → Review → Approve & Push
```

- The AI can propose a plan and **one or more task proposals**.
- Each proposal has the fields required to create a task (§5): title, prompt, agent runtime, model (`Default` or explicit), priority and optional base branch.
- The user can review, edit, reject or accept each proposal individually before any task is created.
- An accepted proposal creates a task through the **same validation and creation rules as manual task creation**. It belongs to the selected project and **enters `Backlog`, never `Queued`**.
- Conversations **never queue tasks, start agents, create worktrees, commit, push or publish**. Queueing remains an explicit user action (§4.2, §6).
- Tasks created from proposals keep a reference to their originating conversation and proposal while those exist. Deleting the conversation does not delete the tasks; it only removes the reference.
- A project conversation proposes tasks for its own project.
- A **global conversation** may propose tasks only after the user **explicitly chooses and confirms the target project**. Choosing a target project does not automatically add that project's context to the global conversation.

### 18.9 Conversation persistence and context

- Conversations, messages, summaries, decisions and proposals are stored locally in SQLite, as metadata alongside the rest of the application data (§13).
- **Permanent conversation history is separate from the context sent to a CLI.** The context for a turn is assembled per message, from a selection of history, summaries and project knowledge, and may be much smaller than the full history.
- Conversations support summaries, so long histories can be condensed for future context while the full history stays available to the user.
- Changing the agent runtime does **not** transfer native CLI sessions between Claude Code and Codex. The new runtime receives context assembled by AI Agent Manager from the stored history.
- Responses stream to the UI. The user can cancel a response; a cancelled or failed response is stored with that status and never silently lost or presented as complete.
- Credentials, tokens and secrets are not stored. Content the user deliberately sends to a conversation is stored as conversation history.
- Project data stays scoped to its project unless the user explicitly authorizes otherwise.

### 18.10 Safety and privacy

- Conversations are advisory. Every effect outside the conversation (accepting a decision, creating tasks) requires an explicit user action.
- Conversation Mode runs only after its runtime policy for the selected CLI has been checked before launch:
  - In Strict Isolated Mode, required restrictions are fail-closed: if they are not enforced, the turn is refused with an actionable explanation rather than run with weaker protection.
  - In Trusted Local Mode (separate opt-in, §18.2), the turn runs under the accepted disclosure, but still never with repository write access or task-start permissions.
- Repository content and documents passed as context are **untrusted input**: they may contain instructions aimed at the model. They must never be able to trigger application actions without user approval.
- Sending a message sends its assembled context to the provider behind the selected CLI, under the user's account. The UI must make this visible, especially for project source files.
- Deleting a conversation requires confirmation. It removes the conversation's messages and pending proposals, but not accepted decisions or created tasks.

### 18.11 Acceptance criteria (AI Conversations)

1. **Global conversations:** create two global conversations, exchange messages with Claude Code in one and Codex in the other, and see both histories after an application restart.
2. **No project leakage:** a global conversation's context never contains project data unless explicitly added.
3. **Project conversations:** two conversations in one project share accepted decisions but have separate histories. A conversation in another project sees none of the first project's context.
4. **Read-only files:** a selected source file is included as context. The conversation cannot change the repository or any worktree, and no claim of isolation is shown unless it is enforced.
5. **Model selection:** `Default` and explicit models work as for tasks; an unsupported model fails visibly without fallback; switching the runtime keeps history and starts a fresh native session.
6. **Streaming and cancellation:** a response streams. Cancelling stops the CLI and stores the partial response as cancelled.
7. **Decisions:** a drafted decision becomes project knowledge only after acceptance, and survives deletion of its conversation.
8. **Task proposals:** proposals can be edited. Accepted proposals create tasks in `Backlog` with an origin reference. Nothing is queued or executed automatically.
9. **Global-to-project proposals:** proposals from a global conversation require explicit selection and confirmation of a target project.

### 18.12 Open technical questions (to verify during implementation)

These are **not** confirmed capabilities:

- Per CLI: streaming output format, native session persistence and resume, model switching within a session, context-window limits and reporting, structured output for proposals, and effective-model metadata.
- Per CLI: whether Conversation Mode can run with **no tools** or read-only tools, whether that can be verified as enforced, and whether repository instruction files or settings are loaded from the working directory.
- Whether web search or browsing (useful for Global AI research) can be enabled safely, and how it is controlled.
- Whether conversation turns share the per-CLI execution capacity of §6 or use separate limits, and how provider rate limits affect concurrent use.
- How large selected files and histories are bounded, summarized and presented.
- What happens to a project's conversations and decisions when the project is disconnected (§4.1 requires an explicit decision about associated resources).

---

**Next:** `ARCHITECTURE.md` — data model, module boundaries, orchestration, process control, and security design.  
**Then:** `IMPLEMENTATION_PLAN.md` — small, verifiable milestones built on the successful PoC.
