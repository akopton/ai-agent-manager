# Agent adapters

This package holds the `AgentAdapter` contract and the adapters for Claude Code and Codex (M1-02).
It also holds the launch security profiles that the orchestrator's execution gate (M1-03) uses.

> **No agent is launched today.** `startAgentExecution` requires an explicit security mode and a
> matching authorization. Strict Isolated authorizations are never issued for the shipped
> (unverified) profiles. Trusted Local launches (SEC-02c) are possible only with an authorization
> that the orchestrator's Trusted Local gate issued in the same process, and no worker calls
> either yet. Every test in this package uses fake CLI scripts. No real agent was run.

## Runtimes and model selection

| Runtime  | CLI         | Assessed version | Non-interactive invocation                                                                                                                                     |
| -------- | ----------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | Claude Code | 2.1.317          | `claude --print --restricted --strict-mcp-config --permission-prompts none --permission-mode acceptEdits --output-format stream-json --verbose [--model <id>]` |
| `codex`  | Codex CLI   | 0.166.0          | `codex exec --sandbox workspace-write --ignore-user-config --ignore-rules --json [--model <id>] -`                                                             |

- Each CLI is **one runtime**. Models are selected per request; there are no agent profiles.
- `modelId: null` means Default: no `--model` is passed, and the CLI's own configuration decides.
- An explicit model is checked for syntax only (`cliModelIdSchema`: starts with a letter or digit;
  letters, digits and `. _ : / @ [ ] -`). There is **no model list**: whether a model exists for
  the current account and authentication mode is only known when the CLI runs.
- A refused model is reported as `failed` with code `model_unavailable`. That classification is a
  heuristic on the error text; anything it misses is reported as `provider_error`. There is never
  a fallback: the adapters do not emit `--fallback-model` and never retry.
- The prompt is written to stdin and never appears in the arguments. It therefore cannot inject
  options, is not visible in `ps`, and is not limited by `ARG_MAX`.

## Public API

```ts
import { getAgentAdapter, startAgentExecution } from '@ai-agent-manager/agents';
import { authorizeAgentExecution } from '@ai-agent-manager/orchestrator';

const adapter = getAgentAdapter('codex'); // or claudeAdapter / codexAdapter

// 1. Discovery: executable, version and supported options. Not a security check.
const detection = await adapter.detect(); // { executablePath?, searchPath?, ... }
if (detection.status === 'unavailable') {
  detection.reason; // not_found | not_executable | version_failed | version_unrecognized
  //                    | version_unsupported | help_failed | options_missing
}
const { installation } = detection; // canonical path, fingerprint, version, detectedOptions

adapter.capabilities(installation); // interface facts (see below)

// 2. An unauthorized plan. Its `invocation` is what the gate must authorize.
const preparation = adapter.prepareExecution(installation, request); // { ok, plan } | { ok: false, code, message }

// 3. Launch. Authorize immediately beforehand; the authorization is consumed.
const decision = await authorizeAgentExecution({
  runtime: adapter.runtime,
  runtimeVersion: installation.version,
  profile: adapter.securityProfile,
  invocation: preparation.plan.invocation, // executable identity, arguments, environment digest
  policy,
  workspace,
});
if (decision.authorized) {
  const started = await startAgentExecution({
    securityMode: 'strict_isolated', // explicit; must equal authorization.mode
    adapter,
    installation,
    request: { runId, prompt, modelId: null, workingDirectory, timeoutMs },
    authorization: decision.authorization,
    emit: (event) => persist(event), // must not throw
  });
  if (started.started) {
    await started.handle.stop(); // graceful stop
    await started.handle.completed; // AgentRunResult; never rejects
  }
}
```

| Export                                                   | Purpose                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `AgentAdapter`                                           | `runtime`, `securityProfile`, `detect`, `capabilities`, `prepareExecution`, `createOutputParser`, `buildEnvironment` |
| `claudeAdapter`, `codexAdapter`, `getAgentAdapter`       | The two shipped adapters                                                                                             |
| `startAgentExecution`                                    | The only function that spawns a CLI (the launch boundary); per-mode checks, see below                                |
| `AgentExecutionRequest`                                  | `runId`, `prompt`, `modelId`, `workingDirectory`, `timeoutMs?`, `resumeSessionId?` (always rejected)                 |
| `UnauthorizedInvocationPlan`                             | Prepared arguments, `cwd`, environment **names**; `authorization: 'required'`                                        |
| `AgentEvent`, `AgentRunResult`, `AgentHandle`            | Event stream, final result, process handle                                                                           |
| `cliModelIdSchema`                                       | Model identifier syntax                                                                                              |
| `defaultExecutionLimits`                                 | Output, grace period and authorization-age limits                                                                    |
| `getRuntimeSecurityProfile`, `findUnsafeLaunchArguments` | Security metadata used by the gate (unchanged from M1-03)                                                            |

## Discovery and capabilities

`detect()` looks for the executable without a shell. It uses an explicit absolute
`executablePath` or searches `PATH`, ignoring relative entries. It resolves symlinks and requires
a regular executable file, and it records the canonical path and a fingerprint (device, inode,
size, mtime). It then runs `--version` and the help command (`claude --help`,
`codex exec --help`) in the temporary directory, with the allow-listed environment and a timeout.
The probes write stdout to a file in a private temporary directory, not to a pipe. Claude Code
2.1.317 exits before flushing `--help` to a pipe, so its output arrives truncated at an
unpredictable point and required options appear to be missing.

- The version is parsed from `2.1.317 (Claude Code)` or `codex-cli 0.166.0`. Versions older than
  the assessed version are `version_unsupported`, because their interface was never inspected.
- Newer versions must still list every option the adapter uses. Otherwise detection fails with
  `options_missing`. `--model` is optional, and `explicitModelSelection` reports whether it is
  listed.

Discovery tells you that the options **exist**. It says nothing about whether they **enforce**
anything. Enforcement is described only by the security profiles and decided by the gate.

| Capability               | Claude Code               | Codex                        |
| ------------------------ | ------------------------- | ---------------------------- |
| `executionMode`          | yes                       | yes                          |
| `conversationMode`       | `not_implemented`         | `not_implemented`            |
| `structuredEvents`       | stream-json               | JSONL                        |
| `explicitModelSelection` | if `--model` is listed    | if `--model` is listed       |
| `sessionIdReporting`     | `session_id`              | `thread_id`                  |
| `reportedModelMetadata`  | yes (`system/init` model) | no                           |
| `toolActivityEvents`     | tool name only            | command / file paths (short) |
| `sessionResume`          | `unverified` (not usable) | `unverified` (not usable)    |

## Events

Every event carries `runId`, `runtime`, a per-run `sequence` (1, 2, …) and a `timestamp`.

| Event                              | Claude Code source                                           | Codex source                                                      |
| ---------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `started`                          | process spawned (`pid`, `processGroupId`)                    | same                                                              |
| `metadata`                         | `system/init` (session, model), `result`                     | `thread.started`                                                  |
| `message`                          | assistant `text` blocks                                      | `item.completed` `agent_message`                                  |
| `tool_activity`                    | `tool_use` / `tool_result` (name, id)                        | `command_execution`, `file_change`, `mcp_tool_call`, `web_search` |
| `provider_notice`                  | none                                                         | `error` events and items (may be transient)                       |
| `stderr`                           | stderr lines (bounded)                                       | same                                                              |
| `diagnostic`                       | malformed or unknown output, truncation, lingering processes | same                                                              |
| `stopping`                         | stop, timeout, output limit, failing handler                 | same                                                              |
| `completed` / `failed` / `stopped` | exactly one, carrying the `AgentRunResult`                   | same                                                              |

The two CLIs report different things, and the mapping keeps those differences. Codex has no
reported model. Claude reports tool names but not inputs. Claude's thinking blocks, Codex's
reasoning, todo lists and `item.updated` are not forwarded.

**What is never emitted:** the prompt, Claude user messages, tool inputs, and the content of
lines that fail to parse. Diagnostics give only the line number and byte length.

**Robustness:** blank lines are skipped. Malformed JSON, non-objects and events without a
`type` produce `malformed_output`, at most 20 per run. Each unknown event type is reported once.
A partial last line at exit is still parsed.

**Limits** (`defaultExecutionLimits`, overridable per launch; in Trusted Local Mode only
tightening is allowed):

| Limit                   | Default     | Effect                                             |
| ----------------------- | ----------- | -------------------------------------------------- |
| `maxStdoutBytes`        | 32 MiB      | the run is terminated with `output_limit_exceeded` |
| `maxLineBytes`          | 1 MiB       | longer lines are discarded with `line_truncated`   |
| `maxStderrEventBytes`   | 256 KiB     | further stderr is counted, not delivered           |
| message / summary       | 64 / 16 KiB | text is truncated (`truncated: true`)              |
| `stopGraceMs`           | 10 s        | delay between SIGTERM and SIGKILL                  |
| `maxAuthorizationAgeMs` | 60 s        | older authorizations are refused                   |

## Termination and results

`AgentRunResult` contains the outcome, plus `runId`, `runtime`, `securityMode`, `pid`,
`startedAt`/`endedAt`, `sessionId`, `reportedModelId`, byte counts, `lingeringProcesses` and
`processContainment` (always `process_group_only`). The `started` event also carries
`securityMode` and `processContainment`. The outcome is decided in this order:

1. `stop()` was called → **`stopped`**, whatever the exit code. A CLI that catches SIGTERM and
   exits with 0 or 143 is still `stopped`, never `completed`.
2. AI Agent Manager terminated the process → `failed` with `timeout`, `output_limit_exceeded` or
   `event_handler_failed`.
3. The process could not start → `failed` with `spawn_failed`.
4. A signal that AI Agent Manager did not send → `failed` with `terminated_by_signal`.
5. The CLI reported failure (a Claude `result` with an error, or a Codex `turn.failed`) →
   `model_unavailable` (explicit model only) or `provider_error`.
6. A non-zero exit → `non_zero_exit`, with the last provider notice or stderr line. Codes
   129–159 are noted as likely signal-initiated.
7. Exit 0 without a success result (Claude `result/success`, Codex `turn.completed`) →
   `incomplete_output`.
8. Otherwise → **`completed`**, with a `summary` taken from the Claude result text or the last
   Codex agent message.

**Stopping and children.** On POSIX each CLI leads its own process group. `stop()` is
idempotent. It sends SIGTERM to the group, then SIGKILL after the grace period, and resolves
once the process has been reconciled. When the main process exits, anything still in its group
is terminated the same way, and the result reports `lingeringProcesses` as `terminated`, or as
`unknown` if something survived SIGKILL. Stdio held open by descendants does not block
completion. `completed` never rejects.

**Containment is process-group only.** Every result carries
`processContainment: 'process_group_only'`. `lingeringProcesses: 'none'` means the process group
was empty, not that every descendant has ended. A descendant that calls `setsid` or `setpgid`
(daemonizing tools, some package managers or language servers) is outside the group. It
survives `stop()` and timeouts, and is reported nowhere. A regression test documents this
(`stop reaches only the process group…`). No process-tree tracking is attempted. PID scans on
macOS are racy and could be evaded, so they would give a false sense of security. Reliable
containment needs an OS-level mechanism (for example running the CLI as a dedicated user, or a
sandbox that forbids `setsid`), which is out of scope here. Do not describe a stopped run as
"all processes terminated".

The handle exposes `pid` and the `started` event carries `processGroupId`, so the future worker
can persist both for crash recovery. That recovery is not implemented here.

## Security restrictions

- **Fail-closed launch boundary.** `startAgentExecution` refuses (`authorization_mismatch`) when:
  - the runtime, the CLI version, the profile ID or the profile arguments do not match;
  - any required control is missing from the authorization, or is not `enforced` by the adapter's
    shipped profile for the installed version;
  - the policy is invalid;
  - the authorization is stale or has already been used;
  - the working directory differs from the authorized one or is not canonical;
  - `authorization.invocation` differs from the launch it is about to perform: an executable
    path or file identity other than the installation's, any argument added, removed or
    changed (including a different model), or a different environment digest.

  It refuses with `executable_changed` when the binary's canonical path or file identity changed
  after discovery. It re-reads them immediately before spawning.

- **Arguments.** They are built from constants plus the validated model. The final list is
  checked against the security deny list (`findUnsafeLaunchArguments`) and against adapter
  rules. Those rules forbid options such as `--fallback-model`, `--resume`, `--continue`,
  `--worktree`, `--tools`, `--mcp-config`, `--settings`, `--oss`, `--output-last-message` and
  `--skip-git-repo-check`. Requests with unknown fields, or with `resumeSessionId`, are rejected.
- **Processes.** `spawn` uses an argument array, `shell: false`, an explicit `cwd`, and never
  `process.chdir`.
- **Environment.** Only an allow list is passed: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
  `TMPDIR`, locale and `TZ`, plus `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. On top of that,
  `NO_COLOR=1`, `TERM=dumb` and `GIT_TERMINAL_PROMPT=0` are set. `GIT_*` overrides,
  `SSH_AUTH_SOCK`, cloud credentials and API keys are dropped, so API-key authentication is not
  supported. Dropping these variables reduces exposure. It is **not** credential isolation: the
  agent can still read credential files.
- **Permission flags are not a sandbox.** Claude Code's `--restricted` mode is a CLI permission
  boundary. Codex's `--sandbox workspace-write` uses macOS Seatbelt but is unverified. Neither
  is claimed as enforced.

## Security modes at the launch boundary (SEC-02c)

`startAgentExecution` validates the authorization against the full contract, requires
`securityMode` to equal `authorization.mode` (`mode_mismatch` otherwise) and switches on it. See
`docs/ARCHITECTURE.md` §7.5 for the full list.

- **Strict Isolated:** unchanged. Every required control must be enforced by the authorization
  and the shipped profile, so every strict launch with the shipped profiles is refused.
- **Trusted Local:** the authorization is redeemed from an in-process issuance registry, which
  only the orchestrator's gate can write to. It claims `claimTrustedLocalIssuer` once, from the
  restricted subpath `@ai-agent-manager/agents/trusted-local-issuer` (ESLint allows it only in the
  gate; it is not on the main entry point). This
  establishes provenance and single use (copies and serialized forms are refused; a failed
  attempt uses the authorization up), and binds it to `request.runId` and `request.prompt` by
  digest. It then requires the shipped adapter, a supported and matching CLI version, the
  profile's arguments, honest control assessments, a non-root effective user
  (`elevated_privileges`), the policy's timeout, non-widened limits and process-group support
  (`safeguard_unavailable`). It never claims that a control is enforced.

This is **in-process provenance**. It guards against untrusted data (forged, deserialized, copied
or replayed authorizations), not against hostile code already running in the worker process. The
gate and the launch must run in the same process, entries expire after 65 s, and a worker restart
invalidates every outstanding authorization.

## Remaining gaps (require real-CLI or adversarial validation)

- **Security:** every profile capability is still `unverified`. The M1-03 adversarial runs
  (commit, push, writes outside the worktree, credential reads, network) must be done with the
  real CLIs before any capability can be marked `verified`.
  `packages/cli-diagnostics` prepares these runs (fixtures, scenarios, evidence, verdict rules)
  but does not perform them.
- **Executable binding and the check-to-spawn race:** the authorization binds the executable's
  path and file identity (device, inode, size, mtime), every argument, the working directory,
  and a digest of the child environment. These are verified by the gate and again just before
  `spawn`. Two windows remain. First, between the final check and the operating system's
  `exec`, a binary replaced at the same path is executed: identity checks narrow this race but
  cannot close it without exec-by-descriptor, which Node does not offer. Second, between the
  gate's working-directory checks and `spawn`. Identity is not content: a same-size in-place
  rewrite with a restored mtime is not detected. Libraries, interpreters (for script-based
  CLIs) and resources loaded at run time are not covered. Protect the CLI installation
  directories against writes by agents. That protection is part of the unverified
  `workspace_write_confinement` control.
- **Process groups:** descendants that call `setsid` or `setpgid` escape group signals. Whether
  either CLI does this has not been tested.
- **Live assumptions:** invocation syntax was checked against the installed help (fixtures in
  `tests/cli-help/`) and against error strings in the binaries, but not by running an agent.
  Still unverified:
  - Claude reads the prompt from stdin under `--print`, and `stream-json` requires `--verbose`.
    The binary contains that error message, but this has not been run.
  - Codex reads stdin with `-`.
  - The exact event shapes for the assessed versions.
  - The wording of model, authentication and rate-limit errors.
  - Exit codes after a stop (the PoC observed 143 for Claude and SIGTERM for Codex).
  - Whether Claude flushes its final stream-json `result` line to a pipe before exiting. Its
    `--help` does not; a lost `result` line would show up as `incomplete_output`.
  - That `--permission-mode acceptEdits` (added in SEC-02e.4, after the real 2.1.317 smoke run
    showed `--permission-prompts none` alone denies every file write) lets Claude edit files in
    the worktree, while writes that `--restricted` reserves for a person (settings, Git and
    tool-configuration files) stay denied. `acceptEdits` is a Trusted Local capability choice,
    not a verified confinement. Claude smoke results from the previous argv do not apply.
- **Not implemented:** session resume, retries, redaction of secrets in model output or stderr,
  and persistence of events (that belongs to the worker, M4).

## Diagnostics entry point

`@ai-agent-manager/agents/diagnostics` exports the process supervisor and `classifyRunOutcome`
(the terminal-state classifier shared with `startAgentExecution`). **It is not protected by any
security gate:** the supervisor spawns whatever executable, arguments, `cwd` and environment it is
given, without an authorization, profile or deny-list check. It exists only so the CLI diagnostics
harness ([`packages/cli-diagnostics`](../cli-diagnostics/README.md)) can exercise these pieces
against harness-generated fake CLIs. Production code must launch agents only through
`startAgentExecution`.

ESLint forbids importing it (and reaching into `agents/src` or `agents/dist` by relative path)
outside the diagnostics package. No application package depends on it. The rule is static: it
does not cover dynamic `import()` or `require`, so it is a review aid, not a runtime boundary.

## Future integration

- **Worker (M4):** detect the CLIs on startup and on scheduling, never caching an installation
  across CLI updates. Compose the global and project instructions with the task prompt. Call the
  gate, then `startAgentExecution` right away. Persist the events (already bounded), `pid` and
  process group. Map the result to the run state: `stopped` → Stopped, `failed` → Failed,
  `completed` → Review. Treat a launch rejection as a user-visible error, with no fallback.
- **AI Conversations (C1):** Conversation Mode will be a **separate entry point** with its own
  runtime policy, launch profiles and gate. It will reuse `detect`, the parsers, the line limits
  and the process supervisor, but not `prepareExecution`, the execution profiles or
  `ExecutionAuthorization`. Nothing in the current contract assumes a Git worktree beyond
  Execution Mode itself.

## Tests

```sh
pnpm --filter @ai-agent-manager/agents test
```

The tests cover discovery, version parsing, missing CLIs and unsupported versions and options,
model selection, argument construction and rejection, the environment allow list, Claude and
Codex parsing (valid, malformed and partial output), and the launch boundary's refusals. Process
behavior (completion, non-zero exit, SIGTERM stop, SIGKILL escalation, foreign signals, timeout,
output limits, lingering children, spawn failure) is tested against fake CLI scripts in temporary
directories. No real CLI, network or authentication is used.
