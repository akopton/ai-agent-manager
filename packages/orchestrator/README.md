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
import { getRuntimeSecurityProfile } from '@ai-agent-manager/agents';
import { authorizeAgentExecution } from '@ai-agent-manager/orchestrator';

const decision = await authorizeAgentExecution({
  runtime: 'codex',
  runtimeVersion: '0.166.0', // detected by the adapter; null when unknown
  profile: getRuntimeSecurityProfile('codex'), // trusted, code-defined
  policy: { version: 1 }, // untrusted input; validated here
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
  decision.authorization; // ExecutionAuthorization: launch arguments, verified workspace, controls
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

## What the gate verifies

All checks are read-only (`realpath`, `lstat`, and the Git package's hardened inspection). It
never writes files or Git config, never sets `safe.directory`, and never runs hooks, fsmonitor,
or filters. Tests check that the whole fixture tree is byte-for-byte unchanged and that a
repository-configured fsmonitor and hooks do not execute.

| Check                                                                                                                                                                                                   | Denial                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Request shape: absolute paths, full base SHA, task ID pattern, known runtime                                                                                                                            | `invalid_request`                                    |
| Policy present, valid, nothing unknown                                                                                                                                                                  | `policy_missing`, `policy_invalid`                   |
| Profile valid, for the requested runtime; verified capabilities cite evidence                                                                                                                           | `profile_invalid`                                    |
| Launch arguments contain no bypass/widening options (`--dangerously-*`, `--add-dir`, `--permission-mode bypassPermissions`, `--sandbox danger-full-access`, `-c sandbox_mode=…`, `--approve-for-me`, …) | `unsafe_launch_arguments`                            |
| Every required control enforced (acknowledgements do not count)                                                                                                                                         | `control_not_enforced`                               |
| Repository, Git dir, worktree, and working directory paths are canonical (no symlinked components, no `..`)                                                                                             | `path_not_canonical`                                 |
| The repository is a valid main working tree that Git accepts (including `safe.directory`)                                                                                                               | `repository_invalid`                                 |
| Its root and common Git directory equal the recorded identity                                                                                                                                           | `repository_mismatch`                                |
| Git reports the worktree `ready`: registered, linked, same repository, not the main checkout                                                                                                            | `worktree_not_verified`, `unsafe_path_relationship`  |
| Checked out on the recorded task branch                                                                                                                                                                 | `branch_mismatch`                                    |
| Locked with the AI Agent Manager marker; the worktree and repository directory are owned by the current user                                                                                            | `ownership_not_verified`                             |
| HEAD and the task branch still at the recorded base commit (no agent commits from earlier runs)                                                                                                         | `unexpected_head`                                    |
| Located exactly at `<realpath(worktreeRoot)>/<repository key>/<taskId>`                                                                                                                                 | `path_outside_workspace`                             |
| No overlap with the main checkout, the Git directory, or any other registered worktree                                                                                                                  | `unsafe_path_relationship`                           |
| The working directory is inside the worktree and belongs to it, not to a nested repository                                                                                                              | `path_outside_workspace`, `unsafe_path_relationship` |

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
- **The version check trusts the adapter's detection.** It cannot prove which binary will run.

## Responsibilities outside the gate

**Agent adapters (M1-02, not implemented):**

- Launch with exactly `authorization.launchArguments`, `cwd = authorization.workspace.workingDirectory`,
  `spawn` with an argument array and `shell: false`. Append only the prompt and model, never
  options that change permissions.
- Re-authorize immediately before spawning if anything may have changed. Never cache an
  authorization across runs.
- Control the child environment: do not pass `GIT_*` overrides or unrelated secrets.
- Report the CLI version honestly (`runtimeVersion`), or `null`.

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
the M1-02 adapters do not exist yet. Until both are done:

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
