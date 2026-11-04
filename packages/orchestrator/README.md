# Execution security gate (M1-03 foundation)

`authorizeAgentExecution` decides, **before an agent process is launched**, whether a proposed
execution satisfies the configured security policy. It verifies the task worktree through the
Git package and compares the policy with what the chosen CLI launch configuration can actually
enforce. It denies by default.

> **Current state: no execution-time restriction is enforced.** None of the CLI restrictions has
> been verified by adversarial tests. With the shipped launch profiles and the default policy,
> every execution is denied with `control_not_enforced`. Every required control is mandatory and
> fail-closed: acknowledging a risk does not authorize execution, and there is no bypass switch.
> A verified worktree and safe launch arguments are necessary but never sufficient. Nothing in
> this package sandboxes an agent.

## API

```ts
import { codexAdapter } from '@ai-agent-manager/agents';
import { authorizeAgentExecution } from '@ai-agent-manager/orchestrator';

// installation = (await codexAdapter.detect()).installation
// plan = codexAdapter.prepareExecution(installation, request).plan
const decision = await authorizeAgentExecution({
  runtime: 'codex',
  runtimeVersion: installation.version, // detected by the adapter; null when unknown
  profile: codexAdapter.securityProfile, // trusted, code-defined
  policy: { mode: 'strict_isolated', version: 1 }, // untrusted input; `mode` is required
  invocation: plan.invocation, // executable identity, every argument, environment digest
  workspace: {
    taskId: worktree.taskId,
    repositoryPath: worktree.repository.root,
    commonDir: worktree.repository.commonDir,
    worktreeRoot, // resolveRuntimePaths().worktreeRoot
    worktreePath: worktree.path,
    branchName: worktree.branch,
    baseCommit: worktree.baseCommit,
    // workingDirectory: optional, canonical, inside the worktree
  },
});

if (decision.authorized) {
  decision.authorization; // ExecutionAuthorization: invocation, verified workspace, controls
} else {
  decision.denials; // [{ code, message, control?, issues? }, ...]
}
```

Types live in `@ai-agent-manager/core` so that adapters can consume an authorization without
depending on the orchestrator:

| Type                        | Package  | Purpose                                                                                              |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `ExecutionSecurityPolicy`   | `core`   | What AI Agent Manager requires (Zod schema `executionSecurityPolicySchema`).                         |
| `SecurityControl`           | `core`   | One required outcome, such as `git_push_denied`.                                                     |
| `RuntimeSecurityProfile`    | `core`   | What one fixed CLI launch configuration claims per control, and how it was verified.                 |
| `assessControl`             | `core`   | Classifies a control: `enforced`, `cli_tools_only`, `unverified`, `instruction_only`, `unsupported`. |
| `ExecutionAuthorization`    | `core`   | The result that the execution layer must consume.                                                    |
| `getRuntimeSecurityProfile` | `agents` | The shipped candidate profile per runtime (all unverified).                                          |
| `findUnsafeLaunchArguments` | `agents` | Deny list of CLI options that bypass or widen restrictions.                                          |

`listWorktrees` is now also exported by `@ai-agent-manager/git` (read-only, unchanged).

### Policy

```ts
{
  version: 1,
  workspaceAccess: 'task_worktree_only',       // only value
  network: 'deny' | 'allow',                   // default 'deny'
  interactiveApproval: 'deny',                 // only value: runs are unattended in MVP
  gitMutations: 'deny',                        // only value: publishing belongs to the trusted service
  riskAcknowledgements: [{ control, reason }], // default []; informational only
}
```

Unknown fields are rejected, and permissive values that could not be honored (allowing pushes,
other directories, interactive approval) cannot be represented. A missing policy is a denial
(`policy_missing`); there is no implicit default at the gate. `network: 'allow'` removes only
`network_denied` from the required controls.

`riskAcknowledgements` records the user's acknowledgement of known limitations
(ARCHITECTURE §7.3). It is **informational metadata only**. When a required control is not
enforced, the execution is still denied with `control_not_enforced`. The acknowledgement is
copied to that denial (`acknowledgement`), next to the profile's `assessment`, so the UI can
explain the limitation. It never waives a control, and an authorization only ever contains
`enforced` controls. The workspace checks below are likewise mandatory.

### Controls

| Control                       | Required outcome                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `workspace_write_confinement` | The process tree writes only inside the task worktree (so the main checkout and other worktrees are protected). |
| `network_denied`              | No network access (unless the policy allows it).                                                                |
| `git_history_mutation_denied` | No commits, merges, rebases, resets, or ref/config changes.                                                     |
| `git_push_denied`             | No pushes, including to local-path remotes.                                                                     |
| `credential_isolation`        | No access to SSH keys, credential helpers, tokens, or other credentials outside the worktree.                   |
| `untrusted_config_isolation`  | Repository-controlled CLI settings, hooks, MCP servers, or rules cannot widen permissions.                      |
| `non_interactive_approval`    | Nothing waits for approval; anything that would need approval is denied.                                        |

A control counts as **enforced** only when all of these hold:

1. The profile's mechanism is `os_sandbox`, `cli_permission`, or `launch_configuration` (never
   `instruction_only` or `none`).
2. It is `verified`, with evidence, for the exact CLI version detected at launch (`assessedVersion`).
3. For the process-boundary controls (the first five), it also covers subprocesses. A CLI
   permission that governs only the CLI's own file tools is reported as `cli_tools_only`.

Prompt or system-prompt instructions (`instruction_only`) are defense in depth and never satisfy
a requirement.

## Trusted Local gate (SEC-02b)

`authorizeTrustedLocalExecution(request, trustedState)` is a **separate** entry point for the
personal-use Trusted Local Mode (`docs/ARCHITECTURE.md` §7.5). It never changes the strict gate,
and neither gate falls back to the other. Each authorization it issues is registered with the
launch boundary in `@ai-agent-manager/agents` (SEC-02c). `startAgentExecution` with
`securityMode: 'trusted_local'` accepts it once, within 60 s, in the same process, for exactly
`run.runId` and `run.prompt`. No worker calls this yet.

```ts
const decision = await authorizeTrustedLocalExecution(
  {
    policy, // { mode: 'trusted_local', version: 1, acceptance, acceptedRisks, interactiveApproval: 'deny', timeoutMs }
    run: { runId, prompt }, // the launch must use exactly these; only a prompt digest is kept in memory
    runtime: 'codex',
    installation, // from adapter.detect()
    modelId: null,
    invocation: plan.invocation, // from adapter.prepareExecution()
    workspace, // same shape as for the strict gate
  },
  trustedState, // from operator settings, never from the request (injected until M2/M3)
);
```

It authorizes only when all of these hold:

- Trusted Local is enabled, the recorded acceptance matches the current disclosure version and is
  not in the future, and the policy repeats exactly that acceptance.
- Every control the shipped profile does not enforce is an accepted risk.
- The repository is trusted by canonical root **and** common Git directory.
- The worktree passes every strict-gate workspace check.
- The executable is the detected, unchanged CLI, at a supported version.
- The invocation, environment digest and working directory equal what the adapter prepares.
- A valid timeout is set, and the effective user is not root (an unknown user is denied).

The authorization records:

- `controlAssessments`: honest statuses from the shipped profile;
- `acceptedRisks`: every unenforced control;
- `safeguards`: what was verified or bound; `post_run_git_integrity_check` is not recorded until SEC-02d;
- `processContainment: 'process_group_only'`.

It never claims enforcement.

## What the gate verifies

All checks are read-only (`realpath`, `lstat`, and the Git package's hardened inspection). It
never writes files or Git config, never sets `safe.directory`, and never runs hooks, fsmonitor,
or filters. Tests check that the whole fixture tree is byte-for-byte unchanged and that a
repository-configured fsmonitor and hooks do not execute.

| Check                                                                                                                                                                                                                    | Denial                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Request shape: absolute paths, full base SHA, task ID pattern, known runtime                                                                                                                                             | `invalid_request`                                    |
| Policy present, valid, nothing unknown                                                                                                                                                                                   | `policy_missing`, `policy_invalid`                   |
| Profile valid, for the requested runtime; verified capabilities cite evidence                                                                                                                                            | `profile_invalid`                                    |
| Invocation present and well formed: canonical absolute executable path, file identity, at most 200 arguments without NUL, `sha256:` environment digest                                                                   | `invalid_request`                                    |
| The executable is a canonical, executable regular file whose device, inode, size, and mtime equal the identity recorded at discovery                                                                                     | `executable_not_verified`                            |
| The invocation arguments start with the profile's `launchArguments`                                                                                                                                                      | `invocation_invalid`                                 |
| The complete invocation arguments contain no bypass/widening options (`--dangerously-*`, `--add-dir`, `--permission-mode bypassPermissions`, `--sandbox danger-full-access`, `-c sandbox_mode=…`, `--approve-for-me`, …) | `unsafe_launch_arguments`                            |
| Every required control enforced (acknowledgements do not count)                                                                                                                                                          | `control_not_enforced`                               |
| Repository, Git dir, worktree, and working directory paths are canonical (no symlinked components, no `..`)                                                                                                              | `path_not_canonical`                                 |
| The repository is a valid main working tree that Git accepts (including `safe.directory`)                                                                                                                                | `repository_invalid`                                 |
| Its root and common Git directory equal the recorded identity                                                                                                                                                            | `repository_mismatch`                                |
| Git reports the worktree `ready`: registered, linked, same repository, not the main checkout                                                                                                                             | `worktree_not_verified`, `unsafe_path_relationship`  |
| Checked out on the recorded task branch                                                                                                                                                                                  | `branch_mismatch`                                    |
| Locked with the AI Agent Manager marker; the worktree and repository directory are owned by the current user                                                                                                             | `ownership_not_verified`                             |
| HEAD and the task branch still at the recorded base commit (no agent commits from earlier runs)                                                                                                                          | `unexpected_head`                                    |
| Located exactly at `<realpath(worktreeRoot)>/<repository key>/<taskId>`                                                                                                                                                  | `path_outside_workspace`                             |
| No overlap with the main checkout, the Git directory, or any other registered worktree                                                                                                                                   | `unsafe_path_relationship`                           |
| The working directory is inside the worktree and belongs to it, not to a nested repository                                                                                                                               | `path_outside_workspace`, `unsafe_path_relationship` |

Ownership is established from Git's records and the lock marker, never from the directory name.
A manually created worktree at the expected path is rejected. All independent denials are
returned together. An unexpected error yields `inspection_failed`, never an authorization.

## What the gate does not guarantee

- **It is not a sandbox.** Setting `cwd`, choosing launch flags, and writing instructions do not
  confine an agent. Only the mechanisms recorded in a verified profile do, and there are none yet.
- **It is a point-in-time check.** Between authorization and launch, or during the run, the
  worktree, CLI binary, user configuration, or filesystem can change (TOCTOU). The execution
  layer must preserve the verified restrictions (see below).
- **Profiles are trusted input.** The gate validates their structure but cannot detect a
  profile that lies. Profiles must come from code in `@ai-agent-manager/agents`, never from the
  database, the API, or the user.
- **The unsafe-argument list is a deny list** for the assessed CLI versions. It cannot recognize
  options added by future versions; fixed, reviewed launch arguments are the primary control.
- **The version check trusts the adapter's detection.** The gate binds the binary's identity
  (path, device, inode, size, mtime), not its contents or the version it prints. A file
  rewritten in place with the same size and a restored mtime would not be detected. Neither
  would libraries, interpreters, or resources the binary loads at run time.

## Responsibilities outside the gate

**Agent adapters (M1-02, `@ai-agent-manager/agents`):** `startAgentExecution` enforces the
following before it spawns anything. See `packages/agents/README.md`.

- It spawns exactly `authorization.invocation`. The executable must be the detected
  installation, with an identical path and file identity. The argument array must be
  identical, and the child environment's digest must match. The authorized `arguments` must
  also equal the adapter's freshly prepared plan, so a different model or an extra option is
  refused. The prompt goes to stdin, and the process runs with
  `cwd = authorization.workspace.workingDirectory`, through `spawn` with `shell: false`.
- The authorization must match the detected CLI version and the adapter's own shipped profile.
  Every required control must be `enforced` both in the authorization and in that profile.
  Authorizations are single use and refused after 60 s, so the caller must authorize
  immediately before every launch.
- The child environment comes from an allow list. `GIT_*` overrides, `SSH_AUTH_SOCK`, and API
  keys are dropped. `GIT_TERMINAL_PROMPT=0` is set.
- Immediately before spawning, it re-reads the executable's canonical path and file identity.
  A window between that check and the operating system's `exec` remains (see the agents
  README).

**Scheduler / execution layer (M4, not implemented):**

- Treat a denial as a recoverable, user-visible task error. Never fall back to a weaker profile
  or policy, and never offer a way to override a mandatory control.
- Persist the authorization (its enforced `controls`) with the run, and surface denials,
  including their `assessment` and `acknowledgement`, so the user can see why a run was blocked.
- After the run, before review, re-verify the worktree. Change inspection already reports
  `committed` files and `baseIsAncestor`, and the gate's `unexpected_head` check blocks follow-up
  runs on a worktree with agent commits.

**Trusted publish service (M6):** the only component allowed to commit and push, after the
approved snapshot is re-verified. This is the backstop that remains even when agents are not
confined.

## Requires OS-level isolation

These outcomes cannot be achieved through CLI permissions alone while the agent can run
commands. They need an operating-system boundary covering the whole process tree:

- confining writes to the worktree (protecting the main checkout, other worktrees, app data);
- denying network access;
- preventing commits, merges, and ref changes: a linked worktree's refs, objects, and config live
  in the shared Git directory, which `git` inside the worktree can write unless the OS prevents it;
- preventing pushes: the agent inherits the user's SSH agent and credential helpers;
- isolating credentials: reads of `~/.ssh`, Git credential stores, and environment variables.

Codex's `--sandbox workspace-write` (macOS Seatbelt) is a candidate for the first four. It is
**unverified**, and as documented it does not restrict reads, so it is not a candidate for
credential isolation. Claude Code's `--restricted` mode removes command tools and confines file
tools. That is a CLI permission boundary (`cli_tools_only`), not OS isolation. Claude Code's own
OS sandbox settings have not been assessed. Building a separate general-purpose sandbox was out
of scope.

## Blocked M1-03 acceptance criteria

The original M1-03 asks to _verify per CLI_ what can be restricted, using adversarial runs that
try to commit, push, and write outside the workspace. This requires running the real CLIs, and
the M1-02 adapters exist but have only been exercised against fake CLIs. Until the adversarial runs are done:

- every shipped capability is `unverified` with `assessedVersion: null`;
- no required control is enforced, so every execution is denied (fail-closed);
- "both adapters run in isolated test worktrees" is not met.

To unblock it, implement the adapters. Then run the adversarial tests against disposable
repositories and a local bare remote for the exact CLI versions. Mark only the capabilities that
were observed to deny the operation as `verified`, citing that test as `evidence`.

## Tests

```sh
pnpm --filter @ai-agent-manager/orchestrator test
```

Tests use temporary repositories and worktrees created with `createTaskWorktree` (names
containing spaces), and test-only verified profiles to exercise the authorization path. No agent
CLI is started.
