# AI Agent Manager — Project Context and Decision Log

**Status:** Context snapshot v0.9 — UI-04D implementation and verification recorded; v0.8 — C4 decisions recorded (§10); v0.7: C3.1 decisions recorded (§10); v0.6: AI Conversations C3 decisions recorded (§10); v0.5: AI Conversations C2 decisions recorded (§10); v0.4: SEC-02 execution security modes recorded; v0.3 recorded platform strategy and SEC-01; v0.2 recorded AI Conversations decisions (§10)\
**Date:** 2026-11-11 (UI-04D; prior snapshot: 2026-11-07; v0.4: 2026-11-04, v0.1: 2026-11-03)\
**Related documents:** [`SPEC.md`](./SPEC.md) v0.14, [`ARCHITECTURE.md`](./ARCHITECTURE.md) v0.13, [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) v0.11

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


**UI-04A decisions (2026-11-07, after C4.2):**

- Project-centered navigation uses a shared `/projects/[projectId]/layout.tsx`: project name,
  switch-project link and Overview / Kanban / Conversations / Settings. All project descendants
  select Projects globally. The global Conversations index stays available.
- Existing project, board, conversation, task, review, proposal and message-anchor URLs remain;
  `/projects/:projectId/edit` redirects to `/projects/:projectId/settings`. Settings saves still
  return to Overview with the existing success query. No task or conversation UI redesign.
- Project Settings reuses registration editing, trust, source-sharing and disconnect controls.
  Source permission is editable only there, with a link from conversation settings. App Settings
  retains global execution consent, separate conversation consent and appearance. No permission
  scope, gate, worker command, CLI, Git or publishing behavior is changed.
- Per-project sessionStorage remembers a validated board query and conversation detail path.
  No SQLite writes on visits; blocked storage falls back to canonical links. This is per-browser-
  session convenience, not a persisted conversation selection across application/browser sessions.
- Recent Projects uses a read-only query and at most two projects, ordered by persisted project,
  task, conversation and completed-run activity. Generic categories avoid inferring a specific
  edit from an aggregate timestamp. Source permission grants/revocations now update the existing
  project settings timestamp. No migration or analytics tables. Historical revocations and
  archive/restore lack complete timestamps and cannot be reconstructed.
- UI-04A begins the staged UX roadmap; UI-04B/C/D and later deletion/working-tree transfer are
  deferred in `IMPLEMENTATION_PLAN.md` §10, including destination-status action colors.
- Browser/manual acceptance remains pending; the checklist is in `IMPLEMENTATION_PLAN.md` §10.

- UI-04A validation: Node.js 24.22.2 / pnpm 12.16.1; `pnpm lint`, `pnpm typecheck`,
  `pnpm format:check` and `pnpm test` passed (836 tests, including seven new workspace
  regressions). Default `pnpm build` failed both inside and outside the sandbox with the
  known Turbopack CSS worker port-binding error; it did not pass. The supported alternative,
  `pnpm --filter @ai-agent-manager/web exec next build --webpack`, and the worker build passed.
  Tests ran outside the sandbox because tsx's local IPC socket is blocked inside it.
- A real loopback production HTTP smoke check passed with temporary SQLite data and unavailable
  disposable repository registrations: global pages, both project workspaces, board/archived
  board, conversation list/new/detail, task detail/edit/review, Project Settings, App Settings,
  recent-project empty/single/two ordering, source-permission link, nested active navigation,
  and the old edit route's streamed redirect. No worker commands or task runs were created.
  No browser automation was available: hydration, actual sessionStorage behavior, pointer/keyboard
  interaction, visual responsive layout and browser back/forward remain manual acceptance items.
- Deliberate supporting fix: production HTTP QA found Webpack bundling the transitive SQLite
  loader without its native binary. The web app now directly declares the existing pinned
  `better-sqlite3` version and explicitly externalizes it. The rebuilt production server then
  loaded the disposable database successfully. No new dependency version or schema migration.


**UI-04B decisions (2026-11-07, after operator acceptance of UI-04A/theme follow-up):**

- Shared project conversation navigation occupies a compact desktop sidebar and collapses on
  narrow screens. It is scoped by the existing query and defensively filtered in presentation.
  Existing recent activity ordering, URLs and UI-04A remembered detail paths remain.
- Chat shows exchanges and turn states; Tasks shows all generation requests and existing cards;
  Notes shows local C1/C2 notes and Save as Note. Fixed-mode composers retain separate drafts
  while switching tabs. Notes remain excluded by the unchanged worker context assembly.
- Query-backed tabs use native browser history and existing Radix Tabs keyboard behavior;
  inactive panels remain mounted/hidden. Legacy source/batch hashes select the correct panel.
- Conversation settings now lives in a header disclosure, with the original validation,
  revision guards and Project Settings source-permission link. Enabled AI context details
  collapse; missing consent/source permission stays visible. Composer uses primary Send to AI,
  duplicate-submit protection, and IME/key-repeat-safe Ctrl/Command+Enter.
- No dependency, API, schema, model catalog, consent, source retrieval, worker, task lifecycle,
  scheduler or Git/publication changes. UI-04C (message/task refinements) and UI-04D
  (references/chips/final polish) remain deferred; no deletion was added.
- Validation on Node.js 24.22.2 / pnpm 12.16.1: `pnpm lint`, `pnpm typecheck`,
  `pnpm format:check` and `pnpm test` passed (842 tests). The final generation-status copy
  cleanup also passed all 33 focused conversation/workspace/proposal UI tests. Webpack production
  build and the separate worker build passed. Default `pnpm build` failed both inside and
  outside the sandbox with the existing Turbopack CSS worker port-binding error (`Operation
  not permitted (os error 1)`); it did not pass. The second failed recursive build killed the
  parallel worker build; the separate worker build passed afterward. Tests needed outside-
  sandbox execution for tsx IPC sockets.
- Headless Chrome QA against the final Webpack production server passed with a temporary
  migrated SQLite database, unavailable disposable repository registrations and a fresh browser
  profile. Completed replies/proposal generations were synthetic database fixtures; no CLI or
  worker was launched by this browser run. The full test suite separately exercised fake CLIs.
- Browser checks passed: scoped navigation and active item; Chat excludes notes/cards; Tasks
  shows cards and failed requests; note persistence and same-tick double-submit protection;
  retained chat draft across tabs; query refresh and back/forward; legacy source/batch hashes
  (including conflicting queries); source links across tabs; arrow focus and Enter activation;
  settings validation/save/runtime change; proposal edit/reject/reopen/approve into Backlog;
  all four primary accents and matching active-control accents; collapsed/open narrow list;
  no 360px horizontal overflow; IME/key-repeat guards; keyboard Send, waiting, switching during
  a pending turn, blocked note saving and Stop. No browser runtime exceptions. Database checks
  confirmed zero execution commands, task runs, workspaces and publications. Desktop (1440px)
  and mobile (360px) screenshots were visually inspected.
- Operator acceptance is still required for UI-04B. The full manual checklist is in
  `IMPLEMENTATION_PLAN.md` §10; remaining broader checks include Safari, blocked browser storage,
  long real transcripts/input, Project-Aware Sources, all running/interruption/retry variants,
  lost responses, stale settings revisions, explicit branch/model changes and approved-task
  origin navigation. Existing automated coverage of those underlying behaviors remains; no
  authenticated CLI verification or CLI-isolation claim is added. UI-04C/D stay deferred.


**UI-04B scroll-to-latest follow-up (after manual layout acceptance):**

- The operator accepted the UI-04B sidebar, tabs, settings disclosure and composer. This
  supersedes the earlier pending layout acceptance note; scroll-to-latest is a bounded follow-up.
- Chat previously used document scrolling and opened at the oldest exchange. It now uses a
  bounded focusable transcript, with its composer in a separate footer. Each mounted conversation
  starts at latest unless a fragment specifies otherwise. A successful Send resumes following;
  new replies/layout changes follow within 96px of the bottom, while scrolling upward preserves
  reading position. Notes/Tasks transitions retain Chat state; note saving never resumes following.
- Relative scroll offsets preserve message anchors without scrolling the whole workspace. Layout
  effects suppress the initial oldest-message flash; ResizeObserver covers delayed rendering.
  Polling does not repeatedly scroll an unchanged viewport. No automatic composer focus, backend,
  persistence, context assembly, task execution or dependency changes.
- Deliberate layout limit: existing mobile navigation can exceed a small viewport; ordinary
  page scrolling may be needed to reach Chat initially. The pane retains a 384px readability
  minimum and a bounded composer footer; browsing its history then leaves page/navigation
  position unchanged. Changing the surrounding mobile application shell is outside this follow-up.
- Node.js 24.22.2 validation: `pnpm lint`, `pnpm typecheck`, `pnpm format` and `pnpm test`
  passed (850 tests, including eight new scroll regressions). All 41 focused conversation,
  workspace, proposal and scroll tests passed. Webpack production build passed for browser QA;
  the known Turbopack problem was not re-tested as part of this follow-up. Tests ran outside
  the sandbox for tsx IPC sockets.
- Real headless Chrome QA used two long disposable conversations (24 synthetic completed
  exchanges each, over 10,000px transcript height), temporary SQLite and no real CLI/worker.
  Passed: latest on open/refresh/switch; visible desktop composer; no autofocus; outgoing chat
  after reading history; following a reply from 60px above bottom; no forced movement while
  reading older messages through polling and reply arrival; Tasks/Notes restoration and note
  saving; source links and direct anchored refresh; delayed anchor alignment and delayed
  bottom growth; keyboard PageDown; no mobile horizontal overflow; narrow-screen local scrolling
  and tab restoration. Desktop header and page stayed fixed during Chat scrolling. No browser
  runtime exceptions or task/execution mutations occurred. Mobile geometry confirmed the
  documented outer-navigation limit; the QA explicitly reached Chat before checking local scroll.
- Remaining manual checks: Safari, touch/virtual-keyboard behavior, browser zoom and unusually
  large composer input. No authenticated CLI verification or new isolation claim was added.


**UI-04C decisions (2026-11-07, after operator acceptance of UI-04A/B):**

- Completed assistant articles now contain compact Generate tasks/optional Focus footers with
  source-specific progress/errors and View proposals in Tasks. Existing source-only request,
  consent and retry identity remain; a synchronous guard prevents same-tick duplicate submits.
- Sources lives inside the corresponding reply, initially collapsed as “N sources”. Existing
  repository-relative references, hashes, capture times, HEAD provenance, limitations and
  unverified-reference warnings remain; every excerpt shows bounded line ranges and available
  tracked/modified/untracked state. Retrieval, source consent and context budgets are unchanged.
- Proposal cards show a 240-character preview with explicit expansion, retaining labelled
  Draft/Approved/Rejected states, AI originals vs operator edits, the full field editor,
  revision validation, Reject/Reopen, source links and individual Approve to Backlog.
- Task Details repeats the same permitted Edit/Change priority link after the prompt. A read-only,
  project-scoped join fetches up to 601 characters of one original assistant/chat reply; the UI
  presents at most 600 plus an ellipsis as historical content, with an exact message anchor.
  Legacy/unavailable sources fall back to conversation links or explanatory text. No history or
  source-file bytes are duplicated into tasks, and no attachment capability is introduced.
- LifecycleButton derives destinations from core.taskTransitions and shares a semantic CSS
  variable map with Kanban indicators. Queue/Retry/Resume/Request Changes use Queued; Return to
  Backlog uses Backlog; Start uses In Progress and explains asynchronous worker acceptance.
  Destructive actions keep their existing treatment; other controls keep normal semantics.
  Fixed status tokens remain independent of all four accents. Tints retain AA text contrast on
  page/card/elevated surfaces; focus, hover and disabled behavior reuse shared button rules.
- Browser QA caught a fragment-history issue: a native proposal-batch link from an anchored reply
  could revert to the original message after a proposal mutation refreshed the router. Batch
  links now use the existing source-link History integration; Tasks and the batch hash survive
  Save/Reject/Reopen/Approve. No routes, stable anchors or tab semantics were replaced.
- No migrations, dependencies, generation schema, approval transaction, permission model,
  source retrieval, worker, execution, scheduler, Git or publication behavior changes. UI-04D is
  next for explicit message/note references, composer chips and final polish. Permanent deletion,
  attachments and working-tree transfer remain deferred. No commit or push was made.
- Node.js 24.22.2 validation: lint, typecheck and format:check passed. All 856 full-suite tests
  passed; 37 focused final presentation/theme/workspace/scroll tests also passed, including
  the added semantic-color contrast regression. Default pnpm build failed both inside and
  outside the sandbox with Turbopack's CSS worker port-binding error: “binding to a port →
  Operation not permitted (os error 1)”. The default build did not pass. Webpack production
  build and separate worker build passed. Tests ran outside the sandbox for tsx IPC sockets.
- Real headless Chrome against the final Webpack production server used temporary migrated SQLite,
  disposable unavailable repository registrations, 13 synthetic completed exchanges, synthetic
  source provenance and a 300-line task prompt. No worker or authenticated CLI was launched.
  Passed: in-card footer/eligibility; keyboard Sources expansion with hashes/local provenance and
  unverified warnings; keyboard Focus and source-specific instructions; same-tick deduplication;
  correct waiting state and Tasks batch navigation; prompt expansion/edit/save/edited labels;
  Reject/Reopen/Approve; long-chat position across tabs; lower Task Edit; bounded historical
  origin/exact-message navigation; all four accents at 360px with no horizontal overflow; and
  Queue/column computed-color equality across all accents. No browser runtime exceptions and
  zero worker commands, task runs, workspaces or publications. Mobile shell and Task Details
  screenshots were visually inspected. Unit/API tests cover other lifecycle destinations,
  noneditable/archived edit restrictions, legacy/unavailable origins and cross-project denial.
- Remaining operator acceptance: Safari, touch/virtual keyboard, zoom, authenticated real chat,
  lost responses and the full checklist in IMPLEMENTATION_PLAN.md §10. Browser coverage is
  synthetic and does not verify CLI isolation. The existing tall mobile shell still requires
  ordinary page scrolling to reach Chat; its accepted UI-04B behavior is unchanged.


**UI-04C workspace-density acceptance follow-up (2026-11-07):**

- Measured the original production UI: the shared max-w-6xl (1152px, including 40px padding)
  capped Kanban and Conversations even at 1920px. A 272px conversation sidebar plus a 24px gap,
  130px header, repeated vertical gaps and verbose composer left a 275px transcript at 1440/1920.
- Only project board and conversation routes opt into wide WorkspaceContent geometry. The
  240px app navigation is unchanged. Wide content gets 24px horizontal desktop/tablet padding
  and 16px phone padding. Task Details/review, project/app settings and task creation keep the
  previous max-width/padding. No global CSS changes. Mobile Kanban gutters were adjusted after
  browser QA exposed an 8px overflow caused by its old negative margins assuming 24px padding.
- Desktop project navigation shares a compact row. The conversation header keeps title and
  runtime/model/context; Project-Aware has a labelled icon/tone. Settings (including language)
  stay in the native on-demand disclosure. Source-sharing notices/gates are unchanged.
  Chat has smaller gaps, a two-row initial input, concise visible guidance and an accessible
  recipient form name. Reply cards cap at 90ch at body-text size; code scrolls locally. Existing
  viewport measurement, anchors, near-bottom following and tab state are retained.
- Before/after headless Chrome measurements below use 1000px-high viewports, a short title,
  closed settings, synthetic long replies and default input height. Values are CSS pixels:

| Viewport width | Chat width before → after | Header height before → after | Transcript height before → after |
|---|---|---|---|
| 1280 | 664 → 736 | 130 → 52 | 231 → 573 |
| 1440 | 776 → 896 | 130 → 52 | 275 → 573 |
| 1920 | 776 → 1376 | 130 → 52 | 275 → 573 |
| 768 | 480 → 480 | 158 → 52 | 164 → 459 |
| 360 | 312 → 328 | 158 → 48 | 138 → 203 |

- Desktop transcript begins at y=246 instead of 436; the separate composer ends at y=984.
  At 1920px, Kanban's main box grows 1152 → 1680px and its useful content 1072 → 1632px.
  Extra centered margins disappear (264px per side before padding → 0); 24px inner gutters
  remain. Task Details and both settings main boxes remain 1152px with 40px padding at 1920px.
  At 1440px, extra centered margins shrink 24 → 0px per side; padding changes 40 → 24px.
- Browser QA passed at all five widths: computed geometry; no horizontal overflow in workspace,
  task or settings pages; local overflow of a deliberately long code line; open Sources with
  long paths; stable sidebar/active conversation; all four accents; keyboard settings/language
  access; visible Project-Aware plus blocked source consent; resized composer separate from
  a usable transcript. The full original UI-04C browser flow also passed against the new build:
  source-specific generation, Focus, Tasks navigation, proposal edit/reject/reopen/approval,
  preserved chat scroll, lower Edit and exact task-origin links. Temporary SQLite/synthetic
  replies only; no real worker/CLI. Zero execution commands/runs/workspaces/publications or
  browser runtime exceptions. Desktop/mobile screenshots were visually inspected.
- Additional browser checks passed at 1280×720 and 1280×900: transcript heights were 293px
  and 473px respectively, with the composer ending 16px above the viewport bottom. Client-side
  Settings → Kanban navigation switched reading/wide containers correctly.
- Final Node.js 24.22.2 validation: lint, typecheck, format:check and all 858 full-suite tests
  passed. Webpack production build passed. The initial suite attempt failed only on the new
  test assuming the label had no shared classes; the corrected assertion and complete rerun
  passed. The default Turbopack build was not rerun for this layout follow-up; its previously
  recorded CSS worker port-binding failure is still an unresolved build limitation, not a pass.
  The existing long-chat Chrome suite also passed against the new layout (latest on open/refresh/
  switch, near-bottom following, older-history preservation, delayed layout, anchors, local page/
  transcript scrolling and mobile tab restoration). Safari, touch/virtual keyboard,
  browser zoom and unusually long titles/input remain manual acceptance. The tall mobile shell
  still needs normal outer scrolling to bring all of Chat into view; no shell redesign or
  UI-04D work was introduced. No commit or push was made.

**UI-04C unified application geometry and conversation panels (2026-11-07; acceptance pending):**

- Supersedes the prior route-specific outer width and native settings disclosure correction.
  Root causes: WorkspaceContent changed both max-width and padding by route, placing shared
  project navigation inside different boundaries; only Chat had a bounded pane; settings used
  an open-state grid span that moved its own control; global permission prose lived in history.
- One outer WorkspaceContent now aligns Overview, Projects, App Settings and all project
  sections. lib/layout centralizes 16px phone / 24px desktop gutters, 16px top padding and inner
  width classes. AppShell's top bar shares the gutter. PageContent and ProjectContent constrain
  only internal settings/task columns below the shared project navigation. No centered feature
  column can reposition navigation. Stable root scrollbar gutters avoid width jumps between
  short and long pages. The 240px desktop application sidebar is unchanged.
- Measured before/after navigation changes across Project Overview / Kanban / Conversations /
  Project Settings, in CSS pixels (same project, 1000px-high Chrome viewports):

| Width | Largest navigation x/y change before | Largest x/y change after | Shared final navigation x/y |
|---|---|---|---|
| 1280 | 16 / 24 | 0 / 0 | 887.20 / 72 |
| 1440 | 40 / 24 | 0 / 0 | 1047.20 / 72 |
| 1920 | 280 / 24 | 0 / 0 | 1527.20 / 72 |
| 360 | 8 / 32 | 0 / 0 | 16 / 399.5 |

- Navigation width/height also showed 0px variation across sections after the correction.
  Shared outer main x/width are 240/1040, 240/1200, 240/1680 and 0/360 respectively, identical
  across all seven measured global/project routes. Internal reading/form limits remain separate.
- ConversationViews owns one bounded workspace height and persistent header/control/tab list.
  Settings swaps only the body, with the same button at the top-right labelled Back to chat.
  Two-line title presentation keeps the full title available. Chat/Tasks/Notes/settings remain
  mounted; ConversationPanel supplies consistent min-height:0/flex/overflow boundaries, a
  keyboard-focusable history area and separate Chat/Notes composers. Oversized inputs/feedback
  may scroll inside the footer; native textareas retain their ordinary editing scrollbars.
- Tasks batch anchors now use local offsets rather than scrollIntoView. Handled fragments do
  not repeatedly overwrite a user-scrolled proposal position on return. Chat retains the existing
  latest/following/anchor controller and delayed-layout handling. Settings back restores the prior
  tab, drafts and scroll. Tab/fragment history and pending worker-owned operations remain.
- Full AI explanation is consolidated into the existing App Settings AI Conversations consent
  card (#ai-conversations), retaining versioned acceptance/revocation. Project repository/source
  permission stays in Project Settings (#source-sharing). Conversations show only explicit
  Project-Aware mode and actionable blockers outside the transcript. No consent version,
  permission check, retrieval, database, task lifecycle or execution change.
- Production Chrome QA used temporary migrated SQLite, synthetic turns/proposals/notes and no
  CLI/worker. At 1280/1440/1920/360px, all seven route boundaries and all four project navigation
  rectangles matched. Header, button, tab list, sidebar and page scroll showed exactly 0px changes
  while switching Chat/Tasks/Notes/settings and scrolling their long contents. Header/button DOM
  nodes persisted. Chat, note and proposal drafts and per-view positions survived round trips.
  Expanded editors remained local. Settings keyboard activation, validation/save, return from
  Notes/Tasks, polling and a pending turn across settings all passed. Global consent discovery,
  all accents and absence of permission prose from history passed; no horizontal overflow.
- QA exposed an implicit-grid min-width overflow in the Projects library with long fixture
  paths at 360px. An explicit zero-minimum single column and shrinkable list items fixed it.
  Desktop/mobile screenshots were visually inspected. The original UI-04C browser workflow
  also passed: source-specific Focus/generation, same-tick deduplication, Sources, batch/source
  links, proposal editing/reject/reopen/approval, lower Task Edit, exact origin and semantic colors.
  No browser runtime exceptions or execution/publication records were created by these checks.
- The final long-chat browser suite also passed: initial latest on open/refresh/conversation
  change, no autofocus, outgoing/near-bottom following, preserved older-history reading through
  polling, delayed layout/anchor alignment, local source/batch navigation, keyboard PageDown,
  note saving/tab restoration and mobile local scrolling. Its synthetic replies exceeded 25,000px
  of transcript height. No task/execution mutations or browser runtime exceptions occurred.
- Node.js 24.22.2 validation: lint, typecheck, format:check and all 860 tests passed. The default
  pnpm build failed both inside/outside the sandbox with Turbopack's CSS worker “binding to a port
  → Operation not permitted (os error 1)”; it did not pass. Webpack production and separate worker
  builds passed. Tests ran outside the sandbox because tsx requires local IPC sockets.
- Remaining operator checks: Safari, touch/virtual keyboard, zoom and real conversation content.
  The shared frame has a 520px minimum. The existing tall mobile shell may need initial outer
  scrolling to reach it; subsequent panel reading/switching remains local. UI-04D is not
  implemented. No commit or push was made.

**UI-04C persistent navigation and task-action acceptance fix (2026-11-08):**

- The operator confirms Conversations works correctly; UI-04C overall remains under review.
  Both remaining issues were reproduced in production Chrome before edits. Scrolling standard
  project pages by 700px moved the project tabs from y=72 to y=-628 at 1280px. A real disposable
  Task Details Queue click moved its action group from (957.83,177), width 298.17, to (264,261),
  width 886.91; Return restored the old position. The shared wrapping flex row allowed the longer
  Queued controls/archive-unavailable copy to force the action group beneath the title. Start
  also lived in the separate Execution panel rather than this header.
- AppShell now has a desktop viewport-height grid/flex chain with min-height:0 boundaries.
  The single project layout keeps its existing header/nav outside ProjectContent's bounded
  focusable scroll viewport. Overview, board, settings and all task descendants share it;
  existing reading/form widths and outer gutters remain. Global pages use main scrolling.
  Conversations delegates directly to its existing panes; list/new forms have a local scroller.
  ConversationViews fills the project region rather than measuring a competing page height.
- Phones retain the existing tall application navigation in normal document flow. An 800px
  project frame is the deliberate readability exception: initial outer scrolling may be needed,
  especially in short windows, then reading project content remains local. The conversation
  sidebar has an independent small-screen scroll limit. No body-wide overflow lock was added.
- Streamed-page tests exposed timing races in local restoration. Relative anchors now wait for
  targets via mutation/resize observation. createProjectContentScroll ends ordinary restoration
  when its position is reached, so later mutations cannot pull readers back to the top. Anchors
  follow delayed layout until manual scrolling. Per-path offsets remain in memory and browser
  back/forward restores them; no database/browser storage writes were introduced. Regression
  tests cover new-page reading, short loading placeholders and delayed anchors.
- TaskHeader separates identity from a 24rem action column at lg (1024px and above), with a
  160px minimum action height. Below lg it deliberately stacks title then actions. The same
  container holds lifecycle, existing Start/Stop, recovery, Edit/archive and review links.
  TaskExecutionActions reuses the previous endpoints/eligibility/error feedback; Task Details
  disables only the duplicate inline controls in TaskExecutionPanel. Polling, status/async notes,
  server permission gates, destination colors and the lower Edit link remain unchanged.
- Final production browser QA used temporary migrated SQLite and an actual disposable Git
  repository, long instructions, 36 Backlog tasks, a 500-line prompt, long/short titles and
  synthetic conversation history/proposals/notes. It waited for actual rendered page content
  and positive scroll capacity before measuring. Long Overview/board/settings/task content
  scrolled 700px at all four widths; tab/header/sidebar/page-position changes were exactly 0px.
  Desktop document height stayed within the viewport. Task Edit/Review retained the same shell
  and Kanban highlight; narrow Review content scrolled locally where needed.

| Viewport | Task action rectangle x, y, width, height: Backlog = Queued = returned Backlog |
|---|---|
| 1280 | 872, 177, 384, 160 |
| 1440 | 1032, 177, 384, 160 |
| 1920 | 1032, 177, 384, 160 |

- These desktop rectangles matched for short and 235-character titles, including a deliberately
  delayed Queue response while controls were disabled/loading. Mobile (360px) deliberately
  stacked at x=16, width=328; the short-title action origin stayed y=512.5 through both
  transitions. Its content height changed 76 → 116 → 76px as Start/archive feedback appeared.
  The long-title mobile origin stayed y=800.5. This is intentional stacked-content growth,
  not an unexpected desktop displacement. Screenshots were visually inspected.
- Project tab coordinates stayed x/y=887.20/72, 1047.20/72 and 1527.20/72 at the three desktop
  widths. At 360px, after initial outer access, x/y=16/219.5 remained unchanged while content
  scrolled. The lower Edit link remained reachable without moving navigation. Project source
  anchors scrolled the local viewport. Browser back/forward restored the board's 450px offset.
  Keyboard PageDown scrolled the project region; the existing dialog portal escaped clipping
  and was cancelled without mutation. All accents had no horizontal overflow.
- Conversations checks passed: no additional outer scrollbar; Chat/Tasks/Notes/Settings scrolling,
  persistent header/settings control, drafts, pending operations and consent placement. The full
  long-chat suite passed latest/following/reading preservation, delayed source anchors, refresh,
  keyboard scrolling, conversation changes and narrow-screen restoration. No CLI/worker was
  launched for browser QA. Real Queue/Return transitions created zero worker commands, task
  runs, workspaces or publications; no browser runtime exceptions occurred.
- Node.js 24.22.2: lint, typecheck, format:check and all 865 tests passed. The 24 focused final
  scroll/header/navigation/execution presentation regressions passed. Default pnpm build failed
  inside and outside the sandbox with Turbopack's CSS worker “binding to a port → Operation not
  permitted (os error 1)”; it did not pass. The Webpack production build and separate worker
  build passed. Tests ran outside the sandbox for tsx local IPC sockets.
- Manual acceptance remains: repeat real operator Queue/Return and long-page scrolling; Safari,
  touch/virtual keyboard, browser zoom, very short/narrow windows and large project names.
  UI-04D remains deferred. No commit or push was made.

**UI-04D — Conversation references and reusable structures (2026-11-11):**

- The operator accepted UI-04C and selected this bounded follow-up. Existing AppShell/project
  layouts, ConversationViews/ConversationPanel, mounted tabs, scroll controllers, MessageComposer,
  shared Button/Input/Card controls, reply footer and Nebula Graphite tokens were audited and
  reused. No application-wide layout/theme refactor, new dependency or permission expansion.
- User messages and completed assistant replies expose Reference. Notes expose Reference in chat,
  returning to Chat without changing the note or launching a process. Shared previews identify
  role/kind, show 240 characters, link to original stable anchors and offer individual removal.
  User chat messages now have anchors; sent user messages retain snapshot provenance previews.
- `ReferenceDraftProvider` holds selections within the conversation-keyed workspace, outside
  mounted panels. Tab/settings switches preserve text, request state and references. Other
  conversations get fresh state. Same-route message/note links navigate local panes and preserve
  drafts; reference selection never focuses the composer. State remains in memory and is lost
  when the conversation is unmounted/reloaded. Existing note saving is unchanged.
- `referenceIds` is an optional ordered UUID array on Send. Database resolution uses the scoped
  conversation inside the existing send transaction. Missing/foreign/ineligible sources, duplicate
  IDs, more than five selections, sources over 20,000 characters or combined references over
  30,000 characters fail before a message/turn is inserted. Existing history/excerpt caps remain,
  bounding combined source content to 110,000 characters (General) / 140,000 (Project-Aware).
  Oversized references are refused, never silently shortened for the model.
- Additive migration `0014_conversation_references` adds `references_json` to turns (historical
  default `[]`). It snapshots source ID/kind/role/sequence/content atomically. Ordered IDs are
  part of request idempotency; repeat sends return the original turn without resolving source
  text again. Retry copies/validates the snapshot, including through interruptions/restart, and
  never refreshes referenced content. No existing message/note content is rewritten by this work.
- General and Project-Aware answer prompts include JSON quotations in a separate
  `<explicit_references trust="untrusted">` section, after history and before the new message.
  Angle brackets in quotations are JSON escaped; fixed instructions identify them as untrusted
  data with no capabilities. Project-Aware file selection/catalog/retrieval is unchanged. Notes
  are excluded unless explicitly referenced; the manifest counts only unreferenced notes as
  excluded. An answer can naturally quote a shared note and then become ordinary chat history.
- The composer explicitly names the recipient of note content before Send. AI Conversations
  disclosure `2026-11-11.1` corrects the former unconditional never-sent promise and requires renewed
  acceptance. Login, model profiles, task execution permissions and per-project source consent
  remain unchanged. Apply the new migration explicitly with the existing database migration
  command before starting this web/worker version; no real operator database was migrated here.
- Regression tests cover input limits/framing, same/different-project scoping, eligible sources,
  atomic failure, ID-only API payloads, bounded public provenance, immutable snapshots after a
  source changes, request conflicts/deduplication, fake Claude/Codex execution after restart and
  Retry, default note exclusion, Project-Aware answering, no task/publication records and shared
  preview accessibility. Existing source-specific proposal tests remain in place; their user
  anchor assertion was updated because user messages are now valid navigation targets.
- Remaining maintenance: similar request/error/loading and empty-state presentation across
  settings/proposal forms can be consolidated in a future bounded task. Safe permanent deletion,
  optional task-worktree local-change transfer, file attachments, summaries, streaming/partial
  replies and all previous platform/security follow-ups remain deferred. No commit or push.
- Final Node.js 24.22.2 validation: `pnpm lint`, `pnpm typecheck`, `pnpm format:check` and
  `pnpm test` passed (873 tests). A separate 45-test final web run passed after the footer/preview
  composition changes. `pnpm build` failed inside and outside the sandbox with the known
  Turbopack CSS worker “binding to a port → Operation not permitted (os error 1)” error; it did
  not pass. `pnpm --filter @ai-agent-manager/web exec next build --webpack` and
  `pnpm --filter @ai-agent-manager/worker build` passed. Tests used outside-sandbox tsx for local
  IPC sockets. Initial attempts caught fixture/API expectation mistakes and an old test asserting
  user messages had no anchors; those were corrected before the complete passing rerun.
- Final production headless Chrome reference QA used a temporary migrated SQLite database,
  disposable Git repository, sixteen synthetic completed exchanges and fake Claude/Codex
  executables. It passed old-user keyboard selection, completed-reply selection, note return to
  Chat and provider notice, individual removal without note changes, message/note source links,
  browser return, tab draft/reference retention, no autofocus, fresh state in another conversation,
  Cmd+Enter Send, exact reference IDs/content in fake CLI stdin, unselected-note exclusion,
  draft clearing and persisted sent provenance. At 1440/768/360px all four accents fit without
  horizontal overflow. Desktop/mobile screenshots were visually inspected. Large reference
  selections use the existing bounded composer's footer scrollbar on short/narrow screens.
- Existing production Chrome regressions also passed against the final build: Sources keyboard
  disclosure/provenance; source-specific Generate tasks and same-tick deduplication; Focus; proposal
  edit/save/reject/reopen/approve and origin links; Kanban destination colors; initial latest and
  near-bottom following; deliberate old-history reading through refresh/delayed layout; message
  anchors; Chat/Tasks/Notes scroll restoration; fixed project navigation; stable Task Details
  Queue/Return positions; back/forward; dialogs and all four accents. The old proposal QA driver
  was narrowed to find Focus inside its form after Reference became the first footer button.
  No application regression was required to fix that selector. All browser flows finished with
  zero runtime exceptions and zero task runs, worker commands, workspaces or publications. The
  reference flow used one fake conversation CLI invocation; other browser flows used no worker.
- Operator acceptance remains for Safari, touch/virtual keyboard, zoom, very short windows and an
  authenticated real conversation. Browser tests verify application behavior, not provider CLI
  isolation. See IMPLEMENTATION_PLAN §10 for the manual checklist. Safe permanent deletion and
  optional task-worktree local-change transfer remain unscheduled. No commit or push was made.

**UI-04D acceptance follow-up — Saved note editing and deletion (2026-11-11):**

- The operator requested note management before closing the still-uncommitted UI-04D milestone.
  ConversationNotes, MessageComposer, reference snapshots, scoped API/transaction/revision patterns,
  shared buttons/fields and Radix AlertDialog were inspected. Existing panels, scroll ownership,
  navigation and composer structures are preserved; no broad UI refactor or dependency was added.
- Inline Edit populates the current text; Save uses existing note normalization/limits and a
  captured revision. Cancel discards local edits and restores Edit focus. Creation time, sequence,
  conversation and ID survive; edited time/revision advance. Revision conflicts preserve typed
  text for review rather than overwriting another edit. Ordinary chat/assistant messages cannot
  be changed through these endpoints, and note changes launch no CLI or execution work.
- Deletion uses a destructive confirmation, initially focused on Cancel. Migration
  `0015_conversation_note_management` adds revision, updated_at and deleted_at metadata. Delete
  clears the current body and retains a tombstone with ID/request ID/sequence/timestamps, preserving
  FK identity and sequence allocation. Active lists/counts hide tombstones. This is logical deletion,
  not secure erasure; historical reference snapshots/provider records and other copies remain.
  Confirmations bind to their opened revision; repeated completed deletion is idempotent. Stale
  edits/create-request replays cannot resurrect a deleted note. No other resource is deletable.
- PATCH/DELETE on the scoped messages/:noteId route retain Host/Origin/content-type/body-size/Zod
  guards. Update returns a message-only response; Delete returns deleted:true, also on repetition.
  Missing/foreign/non-note targets return 404, stale revisions 409, invalid content 400.
- Existing references_json is not rewritten. New references resolve current note text; saved
  snapshots and Retry keep earlier text even when the live note changes or disappears. Turn views
  mark source availability from current scoped messages; unavailable historical sources keep
  bounded snapshot previews without dead links. Current source previews feed the existing draft
  provider, so unsent note previews update after edits. Deleted unsent references remain removable
  and block client/server submission; the message draft is preserved. The worker's note-exclusion
  count now accounts for referenced live IDs, avoiding subtraction of already-deleted sources.
- Focused production headless Chrome QA passed with temporary migrated SQLite, a disposable
  repository and long synthetic chat/note lists. Keyboard Edit populated/focused existing text;
  Cancel restored Edit focus without a write; empty/oversized changes were refused; Save advanced
  revision/edited time; tab switching preserved Chat text and refreshed selected-note previews.
  A new queued message captured the updated note while older snapshots retained their original
  text. A simulated other-client edit caused a 409 without replacing the unsaved editor draft.
- Delete confirmation initially focused Cancel and explained retained copies. Cancellation kept
  the note and restored the trigger after the dialog exit animation. Confirmed deletion removed
  the active card, cleared the current body into a revisioned tombstone and focused Notes.
  Historical previews retained both original/edited snapshots without dead links; an unsent
  deleted-note reference blocked Send before a new turn was inserted and preserved the draft.
  Note creation after deletion, desktop/mobile fixed header geometry, 360px editor/actions and
  confirmation geometry, and all four accents without horizontal overflow passed. The mobile
  confirmation screenshot was visually inspected. This note-management browser flow launched zero
  CLIs and created zero tasks, worker commands, task runs, workspaces or publications; no browser
  runtime exceptions occurred.
- The existing UI-04D reference browser acceptance flow also passed against the final build:
  old user/reply and note selection, source anchors, removal, tabs, fresh state in another
  conversation, 1440/768/360px across all accents, keyboard Send, exact fake-CLI reference context
  and default note exclusion. That separate regression used one fake conversation CLI invocation
  and zero task execution/publication records. No authenticated CLI was launched.
- Browser QA caught an update-response mismatch: Save initially expected the create response's
  required created flag. A message-only update response schema and API assertion fixed this;
  the final complete browser flow passed. The confirmation focus check waits for the shared
  dialog's existing exit animation. No layout or process-launch code was changed to resolve it.
- Final Node.js 24.22.2 validation: pnpm lint, pnpm typecheck, pnpm format:check and pnpm test
  passed (878 tests). The initial full attempt failed an unchanged process-stop test expecting
  SIGKILL but receiving SIGTERM while builds were running; the complete rerun passed without
  changing that test or launch behavior. Focused persistence/fake-CLI (15) and API/presentation
  (27) runs passed before the browser response-schema correction, which the final full suite
  additionally verifies. Default pnpm build failed inside and outside the sandbox with the known
  Turbopack CSS worker port-binding error; it did not pass. The final Webpack production build
  passed, and the worker build passed. Tests ran outside the sandbox for tsx IPC sockets.
- Apply additive migration 0015 (and 0014 if still pending) with the existing database migration
  command before running the updated app. The operator database was not migrated. Remaining
  acceptance: real operator note flows, Safari/touch/virtual keyboard/zoom, and any authenticated
  AI checks. Deleted note snapshots retain their original full text locally and in any prior
  provider records; preview display remains bounded to 240 characters. No undelete, secure wipe,
  ordinary chat editing or deletion of conversations/proposals/tasks is implemented. Prior backlog
  for safe permanent deletion of those resources and optional worktree-change transfer remains
  deferred. No commit or push was made.
