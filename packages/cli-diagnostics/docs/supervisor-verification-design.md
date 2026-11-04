# G2: Production supervisor verification design

**Milestone:** M1-04B.1a. **Status:** design only. No real-CLI runner exists, and none may be
built without an explicit owner decision. Production authorization, the gate and the security
profiles are unaffected.

## 1. What has to be verified

The production supervisor is `startSupervisedProcess` in `packages/agents/src/process-supervisor.ts`,
driven by `startAgentExecution` (`execution-launch.ts`) and classified by `classifyRunOutcome`
(`run-outcome.ts`). For each CLI we want evidence about:

- startup;
- structured stdout and stderr handling;
- successful and failed terminal results;
- stop requests;
- timeouts;
- output limits;
- process-group cleanup;
- escaped descendants and SEC-01 reporting.

Two different questions are involved:

1. **Does the supervisor behave correctly?** This is answerable with controlled fake CLI
   processes, and is largely answered already (§2).
2. **Does the real CLI behave the way the fakes model it?** This needs real runs: event shapes,
   exit codes on SIGTERM, whether the CLI or its tools leave the process group, and whether the
   final result line is flushed. It is answered partly by manual runs plus `replay` (the runbook,
   §5) and fully only by a supervised real-CLI run (§4, not implemented).

## 2. Existing fake-process coverage (no duplication needed)

All tests are offline and use generated fake CLI scripts in temporary directories.

| Behavior                                     | Existing tests                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup, exact argv, cwd, environment, stdin | `agents/tests/execution.test.ts`: "runs Claude with the exact prepared invocation and reports completion", "runs Codex with the prompt on stdin and the Default model". Diagnostics `compatibility.test.ts` (`prompt_via_stdin`, `structured_output_format` via `fakeCompatibility`).                                                                                                                                                  |
| Spawn failure                                | `execution.test.ts`: "reports a process that cannot be spawned as spawn_failed".                                                                                                                                                                                                                                                                                                                                                       |
| Structured stdout parsing                    | `agents/tests/parsers.test.ts` (Claude and Codex mapping, malformed output, partial chunks, multi-byte characters, overlong lines). Diagnostics `replay.test.ts` (the same parser and classifier over captured files).                                                                                                                                                                                                                 |
| Stderr handling and bounds                   | `execution.test.ts`: "reports a non-zero exit as a failure with the last stderr line", "discards overlong lines and bounds stderr events".                                                                                                                                                                                                                                                                                             |
| Successful and failed terminal results       | `execution.test.ts`: completion tests, "classifies a refused explicit model without fallback", "reports exit code 0 without a result as incomplete output". Diagnostics `fakeCompatibility` (`terminal_success`, `terminal_failure`, `malformed_output`, `incomplete_output`) and `replay.test.ts`.                                                                                                                                    |
| Stop requests                                | `execution.test.ts`: "stop sends SIGTERM to the process group and reports stopped, not success", "a CLI that exits 0 or 143 after SIGTERM is still reported as stopped", "escalates to SIGKILL when SIGTERM is ignored", "a SIGTERM that AI Agent Manager did not send is a failure". Diagnostics `stop_semantics`.                                                                                                                    |
| Timeouts                                     | `execution.test.ts`: "terminates the run on timeout". Diagnostics `timeout` check.                                                                                                                                                                                                                                                                                                                                                     |
| Output limits                                | `execution.test.ts`: "terminates the run when stdout exceeds the output limit". Diagnostics `output_limit` check.                                                                                                                                                                                                                                                                                                                      |
| Event handler failure                        | `execution.test.ts`: "a throwing event handler terminates the run".                                                                                                                                                                                                                                                                                                                                                                    |
| Process-group cleanup                        | `execution.test.ts`: "terminates processes left in the process group after the CLI exits". Diagnostics `process_group_cleanup` check.                                                                                                                                                                                                                                                                                                  |
| Escaped descendants and SEC-01 reporting     | `execution.test.ts`: "stop reaches only the process group; a descendant in its own session survives" (asserts `processContainment: 'process_group_only'` and `lingeringProcesses: 'none'` with a survivor). Diagnostics `probes.test.ts` (`stop_with_subprocesses`: `survivors`, `survivorKinds`, `supervisorGroupState`), `classification.test.ts` and `processes.test.ts` (PID and nonce verification, no kills of unverified PIDs). |

### Small gaps worth adding later (fake processes only)

These are proposed, not implemented here:

- **T1:** an escaped descendant after a **natural exit**. The supervisor reports
  `lingeringProcesses: 'none'` while the escaped process is alive.
- **T2:** an escaped descendant after a **timeout**. This is the same limitation, on the timeout
  path.
- **T3:** a process-group child that ignores SIGTERM while the CLI exits. This checks the
  `reapGroup` escalation to SIGKILL and the `terminated` / `unknown` reporting.

Each follows the pattern of the existing escaped-descendant test: tagged child, PID-and-nonce
cleanup in `finally`. They pin SEC-01 on every termination path. They are cheap and contain no
real-CLI risk.

## 3. Why there is no general-purpose entry point

The diagnostics subpath (`@ai-agent-manager/agents/diagnostics`) already exposes
`startSupervisedProcess`, `classifyRunOutcome` and `createLineSplitter`. It is lint-restricted to
`packages/cli-diagnostics`. The harness's only process launcher, `runFakeCli`, refuses every
executable except a byte-verified fake generated inside an owned fixture. No command of the harness
accepts an arbitrary executable or arguments, and none should: a generic "run this command under
the supervisor" entry point would be an unaudited way around `startAgentExecution`.

## 4. Future diagnostic-only real-CLI runner (not implemented)

If the owner decides that supervisor-level evidence with the real CLIs is needed (stop, timeout,
output limit, `lingeringProcesses`, escaped descendants), a `supervised-run` command in
`packages/cli-diagnostics` would reuse the same pieces as `runFakeCli`:

1. `adapter.detect()`;
2. `adapter.prepareExecution()` (exact profile arguments);
3. the allow-listed environment;
4. `startSupervisedProcess`;
5. the adapter parser;
6. `classifyRunOutcome`.

It would differ only in executing the detected CLI. Every interlock below is required and
fail-closed:

| Interlock                                                                                                                                                                                                                     | Purpose                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `sysctl -n kern.hv_vmm_present` must print `1` (the host printed `0` on 2026-11-04).                                                                                                                                          | Refuse to run outside a virtual machine.                                                                  |
| A root-owned provisioning marker (for example `/etc/aam-diagnostics-vm`, owner `root`, not writable by others) created by the VM admin in phase A.                                                                            | A second, deliberate signal that this is the disposable test VM. The standard test user cannot create it. |
| The running user is not in the `admin` group.                                                                                                                                                                                 | Tests run as `aam-tester`, never as an administrator.                                                     |
| The working directory is the assigned worktree of a fixture whose manifest passes the existing ownership checks, created with a validated `--parent`.                                                                         | No real repository can be a target.                                                                       |
| Arguments are exactly the prepared plan: no extra or user-supplied arguments, deny list re-checked. The prompt comes only from a harness-written prompt file.                                                                 | No profile broadening; nothing to make a scenario "pass".                                                 |
| `--operator-approval <id>` plus an interactive confirmation (typing the fixture ID) for every run, both recorded in the report.                                                                                               | Explicit, per-run operator control; nothing runs from scripts by accident.                                |
| Mandatory timeout and production output limits.                                                                                                                                                                               | Bounded runs.                                                                                             |
| After the run: tracked-PID reconciliation, plus a `ps` listing of all of the user's processes that is **reported, never acted on** beyond nonce-verified PIDs. `processContainment: 'process_group_only'` is always reported. | Escaped descendants are visible; no false containment claim (SEC-01).                                     |

It would never import or call `startAgentExecution` or `authorizeAgentExecution`, never construct
an `ExecutionAuthorization`, and never read or write security profiles. Its reports would carry
`productionCapabilityClaims: 'none'` like every other report. Production code cannot reach it:
the package is not a dependency of any app or production package, and ESLint forbids importing it
or the diagnostics subpath elsewhere.

**Limits of the interlocks.** They prevent accidents, not a determined owner. Someone with root
on the host could fake the marker, and the VM check only says that a hypervisor is present. That is
acceptable because the runner never changes production authorization: even a misused runner
produces only a diagnostic report. Any change to a security profile remains a separate, reviewed
code change (runbook §7).

## 5. Decisions for the owner

1. Implement the `supervised-run` runner (§4), or accept manual approximations (runbook §8.4)
   plus `replay` for supervisor-level questions. Recommendation: decide after the first manual
   compatibility runs (C-11, C-12) show whether the real CLIs leave their process group. If they
   do, supervisor-level runs add little beyond confirming SEC-01.
2. Add the fake-process tests T1–T3 (§2). Recommended: yes, small and offline.
3. If the runner is approved: the marker path and contents, the approval ID format, and the
   default timeout.
