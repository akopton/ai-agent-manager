# SEC-02e: Trusted Local real CLI smoke runs (design and operator runbook)

**Status:** design accepted; the runner is implemented and tested offline (SEC-02e.1, see
§3.1). **No real CLI has been run for SEC-02e.** The first supervised run waits for the owner's
approvals (§9).
Related: [`real-cli-verification.md`](real-cli-verification.md) (VM plan, adversarial testing,
compatibility IDs C-01 to C-13), [`supervisor-verification-design.md`](supervisor-verification-design.md)
(G2), `docs/ARCHITECTURE.md` §7.5, `docs/IMPLEMENTATION_PLAN.md` §9.3.

## 1. Purpose and non-goals

SEC-02e checks that the locally installed Claude Code and Codex CLIs work with the shipped
adapters **through the production Trusted Local path**: gate → issuance → launch boundary →
supervisor → parser → outcome classifier, with a Git integrity baseline and comparison around
each run.

It is a **compatibility** check. It does not show, and reports must not claim:

- filesystem, credential or network isolation;
- prevention of Git commits or pushes (the integrity check only detects observable changes);
- complete process containment (`processContainment` stays `process_group_only`, SEC-01);
- that `post_run_git_integrity_check` is a production safeguard. The smoke runner performs the
  check itself; the authorization never lists the safeguard, and the worker integration
  (ARCHITECTURE §7.5, four conditions) does not exist yet.

The runs happen on the host under the operator's macOS account. The CLI can use everything that
account can use: other repositories, `~/.ssh`, Keychain items, CLI logins and the network. A
benign prompt is not a boundary. These are the accepted risks of Trusted Local Mode.

## 2. Assessment of the current launch path

| Requirement                             | Today                                                                                                                                                                                                                                                                            | Consequence                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Gate and launch in one process          | The issuance registry is in memory; the gate claims the issuer at module load. `orchestrator/tests/trusted-local-scenario.ts` already runs gate + launch end to end against a fake Codex CLI and a real task worktree.                                                           | A single short-lived process can host both. No worker needed.                                            |
| Trusted state from operator-only setup  | `TrustedLocalState` is an injected argument until M2/M3. There is no persisted settings source.                                                                                                                                                                                  | The runner must build it in memory, only after operator confirmation, for one fixture repository only.   |
| Run and prompt binding                  | The gate binds `runId` and a prompt digest; the boundary redeems once and compares.                                                                                                                                                                                              | Reused as is.                                                                                            |
| Executable identity and full invocation | Gate re-prepares the invocation; boundary re-reads executable identity, argv, env digest, cwd.                                                                                                                                                                                   | Reused as is. The runner must pass exactly `adapter.prepareExecution()` output.                          |
| Timeout and output limits               | Policy `timeoutMs` is mandatory; limits may only be tightened (`safeguard_unavailable` otherwise).                                                                                                                                                                               | Timeout and output-limit checks are possible with real CLIs by **tightening** values (§4: C-15, C-16).   |
| Strict Mode                             | Unchanged and fail-closed.                                                                                                                                                                                                                                                       | Not touched.                                                                                             |
| Existing harness                        | `cli-diagnostics` does **not** depend on `orchestrator`. Its `cli.ts` transitively loads `@ai-agent-manager/agents/diagnostics` (the unguarded supervisor) through the fake runner. The `prepare` fixture puts a probe helper and a credential canary next to the task worktree. | No existing command can run the Trusted Local path. Reusing `cli.ts` or the probe fixture is unsuitable. |
| Git integrity                           | `captureGitIntegritySnapshot` / `verifyGitIntegrity` exist as a library; no CLI command exposes them.                                                                                                                                                                            | The runner calls them in process.                                                                        |

Manual shell runs (runbook §8.3 plus `replay`) remain possible, but they exercise neither the
gate nor the launch boundary nor the supervisor, and they have no integrity check. They do not
satisfy the SEC-02 exit criterion on their own.

## 3. Recommendation: a minimal smoke-run entry point

**Yes, a small entry point is necessary.** Proposed scope (to implement only after review):

**Location and isolation**

- `packages/cli-diagnostics/src/smoke/` with its own entry script, e.g. `pnpm --filter
@ai-agent-manager/cli-diagnostics smoke <command>`. It is **not** a `diagnostics` subcommand
  and is not exported from the package index.
- `cli-diagnostics` gains a dependency on `@ai-agent-manager/orchestrator`. The smoke module
  imports only public entry points: `authorizeTrustedLocalExecution`, `startAgentExecution`,
  `getAgentAdapter`, the `git` integrity and change APIs, and the fixture/manifest helpers.
- A file-scoped ESLint rule forbids `@ai-agent-manager/agents/diagnostics` and the fake-CLI
  modules in `src/smoke/**`, so a process that can launch a real CLI never loads the unguarded
  supervisor. A unit test asserts the smoke entry's static import graph contains neither.
- Production packages and `apps/*` still cannot import `cli-diagnostics` (existing rule).

**Commands**

1. `smoke prepare --parent DIR` creates a **compatibility fixture** (§5): reuses
   `createDiagnosticFixture` with a new `profile: 'compatibility'` option that omits the probe
   helper, `outside/`, `credentials/` and the canary. Starts no CLI. The existing `--parent`
   validation and ownership marker apply.
2. `smoke run --manifest M --runtime claude|codex --check ID` performs **exactly one** run and
   exits. No batch mode, no retry, no `--yes`.
3. Cleanup uses the existing ownership-checked `diagnostics cleanup --manifest M`.

**What `smoke run` accepts and refuses**

- Accepts no executable path, arguments, model, prompt text, environment, working directory,
  repository path or trusted-state input. All of these derive from the manifest, the check
  catalog (§4) and `adapter.detect()` on the operator's `PATH`.
- Refuses unless: stdin and stdout are TTYs; the manifest passes the existing ownership checks;
  the fixture was created with the compatibility profile; the repository, worktrees and
  `origin` remote URL all resolve inside the fixture root; the task worktree verifies; the
  effective UID is non-zero.

**Sequence (one process)**

1. Detect the CLI (`adapter.detect()`), record version and fingerprint. Refuse if unsupported.
2. Prepare the invocation with `adapter.prepareExecution()` for the check's prompt, model and a
   fresh `runId`.
3. Show the operator: runtime, executable path, version, fingerprint, full argv, cwd, model,
   prompt text, timeout, limits, fixture ID, the seven accepted risks and the smoke disclosure
   (§6). Require the operator to type `<fixture-id-prefix>/<runtime>/<check>` exactly.
4. Capture the Git integrity baseline. If the `repository` or `taskWorktree` section is not
   observed, stop without launching.
5. Build `TrustedLocalState` in memory: `enabled: true`, disclosure version `sec-02e-smoke.1`
   (never a production version), acceptance timestamped at the confirmation, accepted risks =
   the required controls not enforced, `trustedRepositories` = only the fixture repository
   identity. It is never persisted, logged as reusable input, or read from a file or env.
6. `authorizeTrustedLocalExecution` with the Trusted Local policy and the check's timeout. A
   denial ends the run (`refused_before_launch`). The runner never adds
   `post_run_git_integrity_check`.
7. `startAgentExecution({ securityMode: 'trusted_local', ... })` with the check's limits (only
   tightened). For C-11 the runner calls `handle.stop()` itself (§4); `SIGINT` to the runner
   also calls `handle.stop()`.
8. After **every** terminal outcome, including a launch rejection: `verifyGitIntegrity(baseline)`,
   `inspectTaskChanges` (paths only), re-detect the CLI version.
9. Write the report (§7) to the fixture's results directory (0600). Leave the fixture in place.

**Offline tests required before the first real run** (fake CLIs only, as in
`orchestrator/tests/trusted-local-scenario.ts`; detection is injected through an internal factory
that the command line does not expose):

- refusals: non-TTY, wrong confirmation, foreign manifest, fixture without the compatibility
  profile, remote or worktree outside the fixture, unsupported version, failed baseline;
- the import-graph test above;
- each check with a fake that behaves as expected → `pass`;
- a fake that edits only the expected file → integrity `clean`; a fake that commits, moves a
  ref or edits `.git/config` → `integrity_violation`;
- stop, timeout and output-limit checks → `stopped`, `timeout`, `output_limit_exceeded`;
- the report contains no prompt-derived assistant text, environment values or tool inputs.

### 3.1 Implementation notes (SEC-02e.1)

Code: `packages/cli-diagnostics/src/smoke/` (`main.ts` entry, `cli.ts`, `runner.ts`, `fixture.ts`,
`checks.ts`, `approval.ts`, `report.ts`), shared ownership helpers in `src/owned-directory.ts`.
Tests: `tests/smoke.test.ts` (fake CLIs, disposable fixtures) and `tests/smoke-imports.test.ts`
(static import graph). It differs from the design above in these points:

- **Separate fixture type, not a profile flag.** `smoke prepare` writes its own prefixes
  (`ai-agent-manager-smoke-fixture-`/`-results-`), marker (`.aam-smoke-fixture.json`) and
  manifest (`smoke-manifest.json`). Cleanup is therefore `smoke cleanup`, not `diagnostics
cleanup`; neither harness accepts the other's directories. Both reuse the same ownership checks.
- **Single use.** Approval writes `run-claim.json` in the results directory; a claimed or
  non-pristine fixture is refused. The fixture is re-verified after approval, before the claim.
- **Confirmation token** is `<fixture-id[0:8]>/<runtime>/<check>/<last 6 of runId>`, so it binds
  one run. `smoke run` refuses non-TTY stdin/stdout before discovery.
- **Stop** is requested at the first structured output event (`metadata`, `message`, tool or
  provider notice), not the first assistant message, because Claude `stream-json` may emit the
  whole message only at the end. `SIGINT` to the runner also calls `AgentHandle.stop()`.
- **Timeout and output-limit prompts** count to 2000 (`Do not use any tools.` appended), and the
  output limit is 4096 bytes: 65 536 would not be reached by either CLI's event stream.
- **Integrity identity.** The baseline is captured with `expectedRepository` (root and common Git
  directory with their `dev`/`ino`), so a repository replaced after verification yields only an
  incomplete baseline and nothing launches.
- **`auth-error` (C-08)** is in the catalog as `blocked`; the runner refuses it before discovery.
- **Not implemented:** raw stdout capture (the production launch path does not expose it; use
  runbook §8.3 with `replay` to reproduce a `compat_failure`), and C-12 (manual `ps`).

### 3.2 Terminal, interruption and failure behavior (SEC-02e.2)

Verified on the owner's Mac on 2026-11-05 with a generated fake `codex` only. A Python `pty`
harness drove the real `pnpm --filter … smoke run` command. Its `PATH` excluded the directory of
the real CLIs, and it required `codex` to resolve to the fake and `claude` to resolve to nothing.
The process chain is `pnpm` → `sh` → `tsx` → `node` (runner) → CLI in its own process group.

| Situation                                 | Observed                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTY detection and approval through `pnpm` | Works; `pass`, exit 0.                                                                                                                                                                                                      |
| Ctrl+C at the approval prompt             | readline receives it (raw mode); the approval is cancelled, `aborted`, the CLI never starts. Before SEC-02e.2 readline only paused here.                                                                                    |
| One Ctrl+C during the run                 | SIGINT reaches the runner; `AgentHandle.stop()`; integrity compared; `inconclusive` (operator interruption); report written; process group gone.                                                                            |
| Second Ctrl+C                             | The runner acknowledges and ignores it. **`pnpm` exits (SIGTERM) and returns the shell prompt**, while the runner finishes in the background and still writes the report. Direct `tsx` invocation (below) keeps the output. |
| SIGTERM to the runner                     | Same as one Ctrl+C.                                                                                                                                                                                                         |
| Terminal closed (SIGHUP)                  | Same as one Ctrl+C; output is lost, the report is written.                                                                                                                                                                  |
| A child in a new session (SEC-01)         | Survives the stop, as documented; the report says `process_group_only`. The group child is stopped.                                                                                                                         |
| SIGKILL to the runner                     | Cannot be handled: the CLI keeps running in its own process group, and no report or integrity result is written. Recovery below.                                                                                            |

**Recommended invocation for real runs** (no `pnpm` layer; press Ctrl+C once):

```sh
cd packages/cli-diagnostics
./node_modules/.bin/tsx --conditions=@ai-agent-manager/source src/smoke/main.ts run \
  --manifest "$MANIFEST" --runtime codex --check stdin-token
```

**Guarantees on interrupted or failed runs:**

- An operator interruption is always `inconclusive` (or `integrity_violation`), never `pass` or
  `compat_failure`.
- Any exception after the fixture claim is caught. The runner then:
  1. stops a running CLI through its handle;
  2. attempts the integrity comparison;
  3. writes an `inconclusive` report (`aborted` if nothing started, `integrity_violation` if one
     was found).
- Reports record error classes only. Messages, which can embed Git stderr, go to the terminal.
- An interruption between approval and launch launches nothing.
- `smoke cleanup` refuses while a claimed run has no report and its runner or CLI process may
  still be alive (`run-claim.json` records the runner PID, `run-process.json` the CLI PID and
  process group).

**Recovery after SIGKILL or a crash without a report:**

1. Read `run-process.json` in the results directory.
2. Inspect the process group: `ps -o pid,pgid,command -g <processGroup>`.
3. If the CLI is still alive: `kill -TERM -- -<processGroup>`. After 10 s, use `-KILL` if it is
   still alive.
4. Check the fixture manually with `git -C <repository> log --all --oneline` and
   `git -C <repository> worktree list`.
5. Record the run as `inconclusive` in the operator log.

## 4. Compatibility test matrix

Run every check for both runtimes unless noted. Each run uses a **fresh** compatibility fixture.
Default limits are the production defaults; the timeout is 180 s unless stated.

| ID   | Check (`--check`)      | Prompt (fixed catalog)                                                                                                                 | Model / limits                           | Expected                                                                                                                                                                                                                                                     | Covers                     |
| ---- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| C-01 | (every run)            | —                                                                                                                                      | —                                        | CLI detected; version supported; identical before and after.                                                                                                                                                                                                 | discovery, version, G10    |
| C-02 | (every run)            | —                                                                                                                                      | —                                        | Required options detected (`detectedOptions`).                                                                                                                                                                                                               | options                    |
| C-03 | `stdin-token`          | `Reply with exactly AAM-COMPAT-OK-<nonce> and nothing else.` (nonce generated per run)                                                 | Default model                            | `completed`; the token appears in an assistant output event (checked in memory, reported as a boolean); the prompt is not in argv (boundary binding).                                                                                                        | stdin, success             |
| C-04 | (same run)             | —                                                                                                                                      | —                                        | No `malformed_output` diagnostics; event types counted. Unknown types are recorded, not failures.                                                                                                                                                            | structured JSON            |
| C-05 | (same run)             | —                                                                                                                                      | —                                        | Terminal result `completed`; integrity `clean`; no worktree changes.                                                                                                                                                                                         | completion                 |
| C-07 | (same run)             | —                                                                                                                                      | —                                        | Claude: session ID and model reported. Codex: thread ID reported, no model expected.                                                                                                                                                                         | provider event parsing     |
| C-10 | (same run)             | —                                                                                                                                      | —                                        | Success with no `--model` in argv.                                                                                                                                                                                                                           | default model              |
| C-06 | `stdin-token` ×3       | as C-03                                                                                                                                | —                                        | 3/3 `completed` (no `incomplete_output`). Three separate approved invocations.                                                                                                                                                                               | result flushed to pipe     |
| C-09 | `explicit-model-error` | as C-03                                                                                                                                | `aam-nonexistent-model-000`              | `failed`, code `model_unavailable` (or `provider_error`: an adapter heuristic finding); no event reports another model.                                                                                                                                      | error classification       |
| C-14 | `coding-edit`          | `Create the file src/greeting.ts containing exactly: export const greeting = 'hello';  Change no other file. Do not run Git commands.` | Default model                            | `completed`; changes = exactly `src/greeting.ts` (untracked), content matches; integrity `clean`. Claude may be unable to write under `--restricted --permission-prompts none`: then `compat_failure` with the outcome recorded, **never** a profile change. | edit, integrity, no FP     |
| C-11 | `stop`                 | `Count from 1 to 400, one number per line.`                                                                                            | Default model                            | Runner calls `handle.stop()` after the first assistant output event → `stopped`; `lingeringProcesses` recorded; integrity compared.                                                                                                                          | honest stop reporting      |
| C-12 | (during C-11)          | —                                                                                                                                      | —                                        | Operator runs `ps -o pid,ppid,pgid,sess,command -U "$USER"` in a second terminal before and 5 s after the stop. Survivors outside the group are a SEC-01 finding, not a failure.                                                                             | subprocess layout (report) |
| C-15 | `timeout`              | as C-11                                                                                                                                | policy `timeoutMs: 15000`                | `failed`, code `timeout`. A run that completes first → `inconclusive`, not pass.                                                                                                                                                                             | honest timeout reporting   |
| C-16 | `output-limit`         | as C-11                                                                                                                                | `maxStdoutBytes: 65536` (tightened only) | `failed`, code `output_limit_exceeded`. Completion below the limit → `inconclusive`.                                                                                                                                                                         | output limit               |
| C-13 | (every run)            | —                                                                                                                                      | —                                        | No `malformed_output`; `unrecognized_event` diagnostics listed for adapter review.                                                                                                                                                                           | parser tolerance           |
| C-08 | —                      | —                                                                                                                                      | —                                        | **Not run on the host.** It needs an unauthenticated CLI; logging out the operator's own sessions is out of scope. Stays with the VM plan.                                                                                                                   | deferred                   |

The prompt for C-14 is a request, not a control. Any commit, ref move or metadata change shows up
as an integrity violation.

Suggested order per runtime: C-03 → C-09 → C-14 → C-11/C-12 → C-15 → C-16 → C-06 (two more
`stdin-token` runs). Codex first is reasonable (its sandbox is the stronger default); the order is
the operator's choice.

## 5. Fixture: creation, rules and cleanup

**Contents** (compatibility profile): a fixture root under the validated `--parent`, containing:

- `repository/`: `git init`, synthetic `README.md` and `src/index.ts`, one base commit;
- `origin.git/`: a local bare remote inside the fixture, `main` pushed (so remote-tracking refs
  exist for the integrity check);
- `worktrees/task-smoke/` (assigned, branch `agent/task-smoke`) and `worktrees/task-other/`, both
  created with `createTaskWorktree` (registered, locked);
- the marker and a sibling results directory with the manifest (0600).

No probe helper, credential canary, `outside/` directory, real file, real remote, application data,
SSH key, token or copy of any private repository. The fixture uses the operator's Git binary and
global Git config only for commands the harness runs.

**Creation and one run**

```sh
SMOKE() { pnpm --silent --filter @ai-agent-manager/cli-diagnostics smoke "$@"; }
FIXTURES="$HOME/aam-fixtures"    # 0700, outside every Git repository and the app data root
mkdir -m 700 -p "$FIXTURES"
OUT="$(SMOKE prepare --parent "$FIXTURES")"
MANIFEST="$(printf '%s\n' "$OUT" | sed -n 's/^Manifest: //p')"
SMOKE run --manifest "$MANIFEST" --runtime codex --check stdin-token   # interactive approval
```

**Cleanup** (only after the operator has inspected the fixture and exported the report):

```sh
SMOKE cleanup --manifest "$MANIFEST"                     # fixture only; keeps the report
SMOKE cleanup --manifest "$MANIFEST" --include-results   # also the results directory
```

`cleanup` refuses unless the directory identities, prefix, marker, owner and parent all match.
Never delete fixtures with `rm -rf` or wildcards. A fixture with an integrity violation stays in
place until the operator has reviewed it. Remove `$FIXTURES` itself manually when empty.

## 6. Prerequisites and approvals

**Before the first run (one-time):**

- [ ] This design is reviewed; the smoke runner (§3) and compatibility fixture profile are
      implemented in a separate task, with the offline tests in §3.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass on a clean checkout of the reviewed commit.
- [ ] The owner approves in writing: use of their **existing** Claude Code and Codex logins on
      the host; provider usage costs; the runtimes and checks for the session.
- [ ] The owner reviews the smoke disclosure (`sec-02e-smoke.1`): the run uses the operator's
      account, files, credentials and network; the agent could read other repositories and
      credentials, make network requests, and commit or push; the integrity check detects only
      observable changes in the fixture repository; process cleanup covers the process group only.
- [ ] `claude --version` and `codex --version` recorded; both at least the adapters' supported
      minimum (otherwise the gate denies with `cli_version_unsupported`).
- [ ] No other agent session is running against the fixture parent.

**Per run:**

- [ ] A fresh fixture from `smoke prepare`.
- [ ] The operator reads the displayed invocation and types the confirmation token. Nothing runs
      without it.
- [ ] For C-11/C-12, a second terminal is ready for the `ps` snapshots.
- [ ] After the run: review the report, inspect the fixture, then decide on cleanup.

**Terminal preflight (once per terminal application, before the first real run).** It repeats
§3.2 in the operator's own terminal with a fake CLI. No provider is contacted.

```sh
# A fixed, new, private directory (not a generated path that could fall back to the current
# directory). $HOME must be canonical; otherwise use its `pwd -P` form.
PRE="$HOME/aam-smoke-preflight"
mkdir -m 700 "$PRE" "$PRE/fixtures"   # stop here if this fails: it must not exist yet
cd packages/cli-diagnostics
./node_modules/.bin/tsx --conditions=@ai-agent-manager/source tests/make-smoke-fake.ts "$PRE/bin" hang
FAKEPATH="$PRE/bin:$(dirname "$(command -v node)"):$(dirname "$(command -v pnpm)"):/usr/bin:/bin"
PATH="$FAKEPATH" command -v codex     # must print $PRE/bin/codex
PATH="$FAKEPATH" command -v claude    # must print nothing; otherwise stop here
OUT="$(PATH="$FAKEPATH" ./node_modules/.bin/tsx --conditions=@ai-agent-manager/source src/smoke/main.ts prepare --parent "$PRE/fixtures")"
M="$(printf '%s\n' "$OUT" | sed -n 's/^Manifest: //p')"
PATH="$FAKEPATH" ./node_modules/.bin/tsx --conditions=@ai-agent-manager/source src/smoke/main.ts \
  run --manifest "$M" --runtime codex --check stdin-token
```

Approve with the token. After `Started codex`, press Ctrl+C once. Expected output:

- `Classification: inconclusive`;
- `Integrity: clean`;
- a report with `stopRequestedBy: "operator"`;
- no process left: `ps -axo pid,command | grep "$PRE/bin"`.

Repeat with the approval prompt, pressing Ctrl+C there: expect `aborted` and no `Started` line.
Then remove each fixture with `smoke cleanup --manifest "$M" --include-results`, and finally
delete the preflight directory by its literal path: `rm -r "$HOME/aam-smoke-preflight"`.

**Abort the session (no further runs) when:** the CLI prompts interactively or hangs past the
timeout; the version changes; any integrity `violation`; any file change outside the fixture is
noticed; the displayed argv differs from the shipped profile.

## 7. Evidence and failure classification

**Report** (`smoke-<runtime>-<check>-<runId>.json`, 0600, results directory). It records:

- runtime, executable path and fingerprint, CLI version before and after, `launchArguments`,
  model, check ID, `runId`, `authorizationId`, timeout and limits;
- `securityMode`, `controlAssessments` statuses, `acceptedRisks`, `safeguards` (never including
  `post_run_git_integrity_check`), `processContainment`;
- the operator confirmation time; the gate decision (denial codes only);
- event type counts and diagnostic codes, `tokenObserved` (C-03), `sessionIdReported`,
  `reportedModelId`;
- the terminal result: status, failure code, exit code, signal, `lingeringProcesses`, duration;
- the integrity comparison: `status`, finding codes, `beforeDigest`/`afterDigest`, `coverage`;
- changed paths in the task worktree (paths and kinds only);
- the classification below, plus `productionCapabilityClaims: "none"` and
  `integrityCheck: "diagnostic_only"`.

No prompt (except the fixed catalog ID), assistant text, tool input, stderr text, environment value
or config value is stored.

**Classification** (exactly one per run):

| Result                  | When                                                                                                                                                        | Action                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pass`                  | The expected outcome (§4), integrity `clean`, version unchanged.                                                                                            | Record.                                                                                                |
| `compat_failure`        | The CLI ran but differs from adapter expectations: wrong outcome code, `malformed_output`, `incomplete_output`, token missing, edit not made or wrong file. | Record as an adapter finding; reproduce manually with runbook §8.3 + `replay` if raw output is needed. |
| `integrity_violation`   | Integrity status `violation`.                                                                                                                               | Stop the session. Keep the fixture. Never retry until it passes.                                       |
| `inconclusive`          | Integrity `inconclusive`; C-15/C-16 completed before the limit; provider-side error (rate limit, outage, authentication); version changed.                  | Record the reason; a repeat needs a new approval.                                                      |
| `refused_before_launch` | Gate denial or launch rejection.                                                                                                                            | Harness or environment defect; fix offline, never by widening input.                                   |
| `aborted`               | Operator declined, a precondition failed, or the baseline could not be captured.                                                                            | No run happened.                                                                                       |

`completed` with a clean integrity result means "no observable violation in the fixture
repository", nothing more.

## 8. What stays out of scope

Adversarial probes (VM only), C-08, OS sandboxing, changes to shipped profiles or launch
arguments, permission-bypass flags, Strict Mode changes, persisted settings, worker, scheduler,
UI, any commit or push by the application, and multiple runs per invocation.

## 9. Blockers before the first supervised run

1. ~~Smoke runner~~ and ~~compatibility fixture~~: implemented and tested offline (§3.1).
   Terminal and interruption behavior verified with fake CLIs (§3.2).
2. **Owner approvals** (§6): use of existing host logins and costs, the session's runtimes and
   checks, the smoke disclosure text (`sec-02e-smoke.1`, shown in the approval prompt).
3. **CLI versions** re-checked against the adapters' minimums on the day of the run.

4. **Terminal preflight** (§6) in the operator's own terminal application.

**Readiness: technically ready, not approved.** After items 2–4, the first run would be
`codex` / `stdin-token`, started with the direct `tsx` invocation (§3.2).
