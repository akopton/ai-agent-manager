# AI Agent Manager — Project Context and Decision Log

**Status:** Context snapshot v0.8 — C4 decisions recorded (§10); v0.7: C3.1 decisions recorded (§10); v0.6: AI Conversations C3 decisions recorded (§10); v0.5: AI Conversations C2 decisions recorded (§10); v0.4: SEC-02 execution security modes recorded; v0.3 recorded platform strategy and SEC-01; v0.2 recorded AI Conversations decisions (§10)  
**Date:** 2026-11-07 (v0.4: 2026-11-04, v0.1: 2026-11-03)  
**Related documents:** [`SPEC.md`](./SPEC.md) v0.11, [`ARCHITECTURE.md`](./ARCHITECTURE.md) v0.10, [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) v0.10

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
| Execution security (SEC-02, 2026-11-04) | **Personal-use MVP runs agents in an explicit Trusted Local Mode:** operator opt-in with a versioned disclosure, trusted repositories only, existing binding/worktree/version/timeout/output-limit/process-group safeguards, a detect-only post-run Git integrity check, and publishing only through Approve & Push. No strict control is claimed as enforced. The fail-closed gate is kept as **Strict Isolated Mode**, deferred together with the VM-based verification (M1-04B.2). Conversation Mode needs its own opt-in. (`SPEC.md` §12.1, `ARCHITECTURE.md` §7.5, `IMPLEMENTATION_PLAN.md` §9.3–9.4) |
| Platform | **macOS-first, cross-platform-ready.** macOS is the only targeted and tested platform. Windows/WSL2/Linux are possible future platforms, not MVP commitments, each needing its own compatibility and security verification. Platform-specific behavior stays behind module boundaries; shared domain logic must not assume macOS (`ARCHITECTURE.md` §16). |

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
- *(2026-11-05)* Node.js 20 caused React `ArrayBuffer` compatibility errors in the web app. The supported runtime is now **Node.js 24** (root `package.json` `engines` and `.nvmrc`; on macOS Apple Silicon via a version manager or Homebrew `node@24`). After switching Node.js major versions, `pnpm rebuild better-sqlite3` is required.
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

1. **Permission boundary:** Prompt instructions are not enough to prevent agent commits, pushes or access outside a worktree. Test actual tool restrictions, sandboxing, subprocesses, network and credential exposure per runtime. *SEC-02:* in Trusted Local Mode these are **accepted, disclosed risks**: the agent may use the operator's files, credentials and network and could commit or push on its own. The application detects unexpected Git mutations after runs where it can, but prevents none of them. Enforcement belongs to the deferred Strict Isolated Mode.
2. **Session continuation:** Resuming a saved Claude/Codex run is not yet verified; implement as a capability-dependent option, not an assumption.
3. **Process supervision:** Verify child process cleanup, cancellation races and accurate slot release after stop or crash. M1-04A showed that process-group stop does not reach descendants that create their own session or process group; tracked as **SEC-01** (`ARCHITECTURE.md` §7.4, `IMPLEMENTATION_PLAN.md` §9.2). Results report `process_group_only` containment, and a verifiable strategy is required before unattended execution of untrusted agent workloads. In Trusted Local Mode with operator-trusted repositories, SEC-01 is an accepted, disclosed risk (SEC-02).
4. **Restart recovery:** Reconcile durable run records, OS processes and retained worktrees without duplicate launches.
5. **Review integrity:** Collect tracked and untracked files and compare immutable snapshot hashes before staging.
6. **Publishing retries:** A commit followed by failed push must be recoverable without duplicate commits or wrong-branch pushes.
7. **Model availability:** CLI model support varies by installed version/account; `Default` is safest. An unsupported explicit model should cause a clear recoverable error, never silent substitution.
8. **Runtime versions:** Check Node and pnpm requirements when scaffolding Next.js/Drizzle and lock supported versions.
9. **Storage:** Choose a user-writable data root and explicit cleanup/backup processes for SQLite WAL and managed worktrees.
10. **Conversation isolation (planned AI Conversations):** Running a CLI outside a repository is not confinement. Conversation Mode needs its own verified, fail-closed runtime policy before it can be described as read-only.
11. **Context leakage and privacy:** Project data must not reach global conversations or other projects. Selected source files are sent to the provider behind the chosen CLI, and CLI-side memory or settings could leak context across projects.
12. **Prompt injection through context:** Repository files, documents and model output are untrusted. Decisions and task proposals must only take effect after explicit user approval.
13. **Platform portability:** Security and process facts verified on macOS do not transfer to other platforms. Future Windows, WSL2 or Linux support needs its own verification, including SEC-01.

## 7. Current repository/document status

At the point of writing this snapshot:

- Product requirements were reviewed and accepted as `docs/SPEC.md` **v0.3**.
- Technical architecture was prepared as `docs/ARCHITECTURE.md` **v0.1**.
- Small scripts exist in `poc/` for agent execution and stop testing.
- The next document and implementation steps are described in `docs/IMPLEMENTATION_PLAN.md`.
- Actual app scaffolding, SQLite/Drizzle models, scheduler, web UI and production adapters have **not yet been confirmed implemented**.

**Update 2026-11-04** (from Git history):

- Implemented and committed: monorepo foundation (core package, worker, SQLite/Drizzle initialization, runtime path configuration); safe Git repository inspection; safe task worktree lifecycle; read-only task change inspection; and the fail-closed execution security gate (M1-03 foundation).
- Implemented (uncommitted at the time of writing): M1-02 adapter contract and the Claude Code and Codex adapters (`packages/agents`), tested only against fake CLIs. Not yet done: live validation of the adapters' assumptions and the adversarial per-CLI verification that M1-03 requires. Until then, the gate denies every execution, and the adapters refuse to launch without an authorization. Scheduler, web UI flows and publishing are not implemented.
- AI Conversations has been specified (§10); no implementation exists.
- M1-04B.1/1a (real-CLI verification plan, offline `replay`, `prepare --parent`) are complete. **SEC-02 (2026-11-04):** the personal-use MVP will execute in Trusted Local Mode (contracts, gate and launch boundary implemented as SEC-02a–c; the read-only Git integrity check as SEC-02d, not yet wired into a run; smoke runs open). M1-04B.2 VM-based verification and the VM preparation are deferred, and agent execution stays disabled until SEC-02 stages a–e pass.
- M1-04A (CLI compatibility and security test harness) adds `packages/cli-diagnostics`: disposable fixtures, fake-CLI compatibility checks, security probe scenarios with conservative verdict rules, and preparation of supervised real-CLI probes. No real CLI was run beyond `--version`/`--help`. No security control has been verified; the shipped profiles and the gate are unchanged.

This document is a **context snapshot**, not an authoritative record of future implementation progress. Update it when major decisions or verified milestones change; prefer Git history and tests for detailed evidence.

## 8. Working with coding agents

When opening the repository in VS Code, ask the coding agent to read `AGENTS.md` and all files under `docs/`, inspect the repository and report its understanding **without changing files**. Then assign one bounded work package from the implementation plan (start with M0) and review its diff and test results before proceeding.

## 9. Future decisions and change control

- A third runtime may be added later through a new code-level adapter; a plugin installation UI is out of scope.
- Automatic task dependencies, cloud runners, automatic merges/PRs and multi-user access remain out of scope.
- If requirements change, update `SPEC.md` first, then reconcile `ARCHITECTURE.md`, this file and the plan.
- Windows, WSL2 and Linux support may be planned later as separate work with its own verification (decision recorded 2026-11-04: macOS-first, cross-platform-ready).

## 10. AI Conversations — agreed product decisions (2026-11-04)

Specified in `SPEC.md` §18, with the architecture in `ARCHITECTURE.md` §15 and the workstream in `IMPLEMENTATION_PLAN.md` §8.

| Area | Decision |
|---|---|
| Product shape | Three capabilities: **Projects & Kanban** (existing), **Project AI** and **Global AI**. Project AI and Global AI are two scopes of **one** AI Conversations module. |
| Scope in plan | Planned extension, delivered as workstream C1–C4 (C1–C5 until 2026-11-06, see below). It is not part of the MVP acceptance criteria (`SPEC.md` §14) and does not change M0–M7. |
| Agents | Reuse the locally installed Claude Code and Codex CLIs through the shared adapter layer. Per-conversation runtime and optional model (`Default` = no override). No mandatory provider APIs, API keys or separate billing. |
| Modes | **Execution Mode** (Kanban task in a worktree) and **Conversation Mode** (discussion and planning) share adapter infrastructure but have separate runtime policies and lifecycles. |
| Conversation authority | No repository write access by default. Conversations never start agents, queue tasks, create worktrees, commit, push or publish. |
| Security claims | Conversation Mode is not called read-only or sandboxed unless runtime isolation is verified as enforced. It uses a fail-closed pre-launch gate, as M1-03 does. |
| Global AI | Multiple conversations, no project association, no automatic project context. |
| Project AI | Exactly one project per conversation, many conversations per project, shared project knowledge, separate histories. Selected files are read by the application, read-only, from a resolved commit. |
| Decisions | Architecture decisions require explicit user approval. Accepted decisions are project knowledge that survives conversation deletion. |
| Planning-to-Kanban | AI proposes tasks; the user edits and approves them; created tasks enter **Backlog** (never Queued) and keep an origin reference. Global conversations require an explicitly confirmed target project. |
| Persistence | SQLite. Permanent history is separate from the per-turn context sent to a CLI. Summaries and selective context. Native CLI sessions are never transferred between Claude Code and Codex. No stored credentials. |

**Implementation priority** *(superseded 2026-11-06)*: the earlier recommendation was C1 Foundation after M4, then C2 Global AI → C3 Project AI → C4 Decisions → C5 Planning-to-Kanban.

**Roadmap decision (2026-11-06, operator).** After Manual Task Management v1, AI Conversations becomes the next major module, with a C1–C4 roadmap that keeps M0–M7 numbering unchanged (`IMPLEMENTATION_PLAN.md` §8):

| Milestone | Scope |
|---|---|
| **C1** | Persistence and UI only. Delivered 2026-11-06. |
| **C2** | Real CLI-backed conversations. Delivered 2026-11-07. |
| **C3** | Task proposals and approval into Backlog. Delivered 2026-11-07. |
| **C4** | Project-Aware conversations with controlled source-code context. Delivered 2026-11-07. |

Global AI and Architecture Decisions remain specified but unscheduled.

C1 decisions:

- **Scope:** conversations are project-scoped only.
- **Language modes:** `pl_technical_en` (default), `pl` and `en`.
- **Messages:** C1 stores operator **notes** only. Notes are never sent to a CLI, and no placeholder AI reply is shown.
- **Runtime and model:** the default runtime is Claude Code, following the task form. The model follows the task convention (`Default` or a free-text identifier, no catalog). *(Changed in C2: provider-specific selector with a curated catalog.)*
- **Deferred:** archive and delete.

Chat stays separate from task execution: a conversation can never queue, start, review or publish a task. The only planned link is C3's explicit approval of a proposal into Backlog.

**Open technical questions** (`SPEC.md` §18.12, `ARCHITECTURE.md` §15.11):

- per-CLI streaming, session resume, model switching, context limits and structured output;
- whether no-tool or read-only Conversation Mode profiles can be verified as enforced;
- web search for Global AI;
- whether conversations share the per-CLI execution capacity;
- context budgeting;
- conversation and decision handling on project disconnect.

**C2 decisions (2026-11-07):**

- **Consent:** a separate AI Conversations opt-in with its own versioned disclosure. Neither Trusted Local execution consent nor project trust enables conversations, and the conversation acceptance enables nothing else. Strict Isolated conversations stay fail-closed.
- **Launch profiles:** Claude Code with all tools disabled, no session persistence and safe mode; Codex `exec` with the read-only sandbox and ephemeral sessions. Both run in a fresh, empty, private scratch directory per turn and receive no repository path. Every option was parse-checked against the installed CLIs **without authentication**; nothing was adversarially verified, so the product never calls conversations read-only or isolated.
- **Turns:** worker-owned and durable; replies only from completed CLI runs; no automatic retry; restart marks unfinished turns interrupted; one active turn per conversation; one conversation slot per CLI, separate from task execution slots.
- **Context:** each turn is a new CLI process; earlier completed exchanges are resent within a 60,000-character budget; notes are never sent; the language instruction is its own prompt section. Project knowledge stays in C4.
- **Model selection:** curated per-runtime catalog plus custom IDs, shared by tasks and conversations. `codex debug models --bundled` exists but is a debug command, so it informs the catalog and is not run by the application.
- **Deferred:** token streaming/SSE, partial replies on Stop, native session resume, summaries, adversarial profile verification, C3 task proposals, C4 project awareness.

**C3 decisions (2026-11-07):**

- **Explicit generation only:** proposals come from a dedicated **Generate task proposals** request (optional focus), never from ordinary replies. It runs through the C2 consent, gate, launch profiles, scratch directory, Stop and restart handling, and shares the per-CLI conversation slot. A chat turn and a generation of one conversation never run at the same time.
- **Structured output:** a prompt-level JSON contract validated with Zod in the worker. Non-documents and truncated JSON store nothing (`malformed_output`); invalid items are skipped and counted; at most 12 per request. The CLIs' native schema options (`--json-schema`, `--output-schema`) are deliberately unused so the C2 launch profiles stay unchanged.
- **Context:** answered chat exchanges up to the request, within the C2 budget; notes excluded; no project files (C4). `pl_technical_en` produces English titles and prompts with Polish explanations.
- **Lifecycle:** `draft → approved` (final), `draft ⇄ rejected` via explicit Reopen. Revision-guarded edits; a generation only adds drafts and never changes existing proposals or the history.
- **Approval:** operator-only API mutation; one `IMMEDIATE` transaction creates exactly one `Backlog` task through `createTask` and marks the proposal approved; repeats return the same task. Never queues, starts, creates a worktree or runs Git; an explicit base branch gets the read-only existence check of manual creation.
- **Origin reference:** stored on the proposal (`task_proposals.task_id`); `tasks` is unchanged and carries no conversation metadata.
- **Deferred:** conversation archive/deletion, global conversations with target-project selection, bulk approval, dependency tracking, native CLI schema options, authenticated real-CLI verification of proposal generation. **Next:** C4 project and task awareness.

**C3.1 decisions (2026-11-07, after C3 operator acceptance):**

- **Contextual generation:** **Generate tasks** sits under each completed AI reply (optional Focus); the separate form below the transcript is gone. Ordinary replies still never produce proposals.
- **Source-scoped context:** the request sends only the selected reply, loaded server-side by ID and snapshotted at request time; no history, user messages or notes. Retries reuse the snapshot; a new click after completion is a deliberate new batch.
- **Provenance:** `task_proposal_generations.source_message_id` and `source_content` (additive migration `0011`); proposals reach their source through their generation. The UI links batches and cards back to the reply.
- **Existing C3 data:** preserved and labelled as whole-conversation; not retryable.
- **Next:** C4 project and task awareness.

**C4 decisions (2026-11-07):**

- **Context modes:** each conversation is **General Chat** (C2 behavior, no repository access) or **Project-Aware**. Existing conversations migrate to General Chat; new conversations choose explicitly. The mode is snapshotted per turn.
- **Permission:** a separate, per-project **source-sharing permission**, bound to the repository identity and a versioned disclosure, independent of the AI Conversations acceptance and of Trusted Local execution trust. Re-checked at send, claim, before reading and before each CLI launch; fail closed. The AI Conversations disclosure was versioned (`2026-11-07.2`) because it previously promised that no project file is sent.
- **Source of truth:** committed content at HEAD of the registered main checkout, read through Git object reads only (`ls-tree`, `cat-file`, `grep`, plus `ls-files` for ignore rules). Uncommitted and untracked files, task worktrees and Git metadata are never read; nothing is written.
- **Selection:** model-directed in a separate planning run that returns a validated JSON read request (≤ 8 files, ≤ 5 literal searches); the application checks every path against the commit's eligible files and reads bounded excerpts. Unusable selections fall back to deterministic keyword search. The C2 launch profiles, gate and launch boundary are reused unchanged; no tool or shell access is enabled.
- **Exclusions and limits:** sensitive, dependency, build, database, binary, generated, ignored, symlinked and oversized files are excluded by default; 60,000 characters of excerpts per turn.
- **Provenance and freshness:** each reply stores a retrieval record (commit, paths, line ranges, refusals, limits; never content) shown as **Sources**; each turn rereads HEAD and states when the repository changed.
- **C3.1:** proposals from a Project-Aware reply receive its source references (no content). Approval is unchanged.
- **Accepted limitations:** the CLI still runs as the operator with unverified CLI-level restrictions and talks to its provider; earlier Project-Aware replies remain in General Chat history; no authenticated real-CLI run yet.
- **Next:** UI-04 polishing pass (`IMPLEMENTATION_PLAN.md` §8, C4 "Remaining work for UI-04").


**C4.1 decisions (2026-11-07):**

- The operator reports successful manual C4 Project-Aware conversations with authenticated CLIs. C4.1 itself is tested only with fake CLIs; this does not verify CLI isolation.
- Supersedes C4's committed-only source policy: current eligible Git-tracked bytes from the registered checkout, including staged/unstaged changes and tracked additions. Untracked/ignored files and managed task worktrees remain excluded. Git determines membership; HEAD remains provenance.
- A small application-owned C helper supplies descriptor-relative `openat`/no-follow reads missing from Node's public filesystem API. Root inode is checked inside the helper; every path component rejects symlinks, and type/size/change checks run around bounded reads. Requires Xcode Command Line Tools at build time and the compiled helper at runtime; unsupported/unavailable mechanisms fail closed. No target-repository code is executed.
- Source permission must be renewed for disclosure `2026-11-07.2`. Migration `0013_source_identity` binds grants to checkout/common-directory device and inode; same-path replacement fails closed, including across turns.
- Catalogs contain names only. Two-stage selection and existing exclusion/excerpt limits remain; literal search adds an overall 200-file / 8 MiB scan budget and uses the same captures as its excerpt lines.
- Sources and persisted metadata distinguish current working tree from legacy committed-only records, include per-file HEAD-byte comparison, SHA-256, capture time and exact line ranges, and never store full source text. Subsequent turns reread even when HEAD is unchanged. Proposals receive references and source mode only.
- Accepted limits: captures are individual files rather than a repository-wide atomic snapshot; later edits may differ; matching HEAD bytes does not mean a clean repository; macOS-only validation and the original unverified CLI-level restrictions remain. C4.1 is a narrow refinement before UI-04; its browser acceptance checklist is in the implementation plan.


**C4.2 decisions (2026-11-07, before UI-04):**

- Saved untracked source/documentation files are eligible without staging. Git `ls-files --others --exclude-standard -z` supplies candidates using nested .gitignore, info/exclude and global exclude rules. The existing tracked catalog and untracked candidates share entry and prompt budgets; discovery commands have hard output/time caps and fail closed on overflow.
- The existing exclusions remain, plus a conservative recognized source/documentation type allowlist for untracked paths. Ignored files, sensitive names, keys/certificates, Git metadata, managed worktrees, dependencies/build/generated files, local databases, binaries, symlinks, submodules and oversized files stay excluded. Git does not descend into nested repositories/worktrees, and directory placeholders are refused. The canonical configured managed-worktree root is excluded even if nested Git metadata is missing. No application recursive filesystem scan or target-repository code execution is added.
- Existing native descriptor-relative reads are reused. Exact tracked/nonignored-untracked membership and ignores are checked around capture, then checked again at retrieval completion; repository identity/consent gates remain. Source-sharing disclosure `2026-11-07.3` requires renewal for the expanded sharing scope.
- Catalog labels and Sources distinguish tracked and **Untracked · Local** files. Untracked state never compares with or attributes content to HEAD. Hashes, capture times and line ranges remain; HEAD is a separate repository reference. Optional record fields preserve historical metadata. Later turns rediscover and reread saved files, including transitions to tracked files after staging. Proposal references preserve local provenance without source text.
- Two-stage model selection, bounded keyword fallback (including root-level filenames), source/context limits and planning-only CLI profiles remain. Tests use fake CLIs, disposable Git repositories and temporary SQLite; no authenticated sessions, commit or push performed by this work.
- Known limits: macOS/Node.js 24 and compiled native helper; per-file rather than atomic repository captures; unfamiliar untracked types excluded; tracked-first entry caps and search budgets may omit files; CLI restrictions remain unverified. Manual acceptance is listed under C4.2 in the implementation plan; UI-04 remains next.

- C4.2 validation: Node.js 24.22.2 / pnpm 12.16.1; lint, typecheck, format:check and 829 full-suite tests passed. Final refinements passed 21 focused worker context/boundary tests and 85 core tests, plus the worker and webpack web builds. Default build remains blocked both inside/outside the sandbox by Turbopack’s CSS worker port binding (`Operation not permitted (os error 1)`); the supported webpack alternative passed. Tests required outside-sandbox execution because tsx’s local IPC socket was denied inside it. Browser/manual acceptance remains pending.
