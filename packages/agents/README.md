# Agent runtime security profiles

This package will hold the `AgentAdapter` contract and the Claude Code and Codex adapters (M1-02,
not implemented). For now it contains only security metadata for the security gate in
`@ai-agent-manager/orchestrator`:

- `getRuntimeSecurityProfile(runtime)`: the candidate launch arguments for each CLI, and for
  each security control the mechanism it relies on (`os_sandbox`, `cli_permission`,
  `launch_configuration`, `instruction_only`, `none`). These were assessed from `--help` output
  of Claude Code 2.1.317 and Codex CLI 0.166.0. **Every capability is `unverified`**, so the gate
  treats none of them as enforced.
- `findUnsafeLaunchArguments(runtime, args)`: rejects known options that bypass approvals,
  permissions, or the sandbox, or that widen the workspace (`--dangerously-*`, `--add-dir`,
  `--permission-mode bypassPermissions|auto`, `--settings`, `--sandbox danger-full-access`,
  `-c sandbox_mode=…`, `--approve-for-me`, `--profile`, `--cd`, `--worktree`, …).

Profiles are code, not configuration. They describe how an adapter launches a CLI. They are not
user-facing agent profiles. Mark a capability `verified` only together with an adversarial test
against the exact CLI version and launch arguments, and name that test as `evidence`.

See `packages/orchestrator/README.md` for guarantees, limitations, and residual risks.
