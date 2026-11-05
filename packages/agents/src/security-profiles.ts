import {
  runtimeSecurityProfileSchema,
  type AgentRuntime,
  type RuntimeSecurityProfile,
} from '@ai-agent-manager/core';

/**
 * Candidate launch configurations for each CLI, assessed only from `--help` output of Claude Code
 * 2.1.317 and Codex CLI 0.166.0 and from the PoC. **No capability is verified**: verification
 * requires adversarial tests with the real CLIs (M1-03), which have not been run. The security
 * gate therefore treats every control below as unenforced.
 *
 * These are code-defined descriptions of how an adapter would launch a CLI, not user-facing agent
 * profiles. Change a capability to `verified` only together with a test that demonstrates the
 * denial for the exact `assessedVersion` and `launchArguments`.
 */
const claudeRestrictedPrint = runtimeSecurityProfileSchema.parse({
  id: 'claude-print-restricted',
  runtime: 'claude',
  assessedVersion: null,
  launchArguments: [
    '--print',
    '--restricted',
    '--strict-mcp-config',
    '--permission-prompts',
    'none',
    // SEC-02e.4: an intentional Trusted Local capability choice so file edits in the working
    // directory are approved without a prompt. Not a confinement mechanism and not verified.
    // Anything else that would prompt is still denied by `--permission-prompts none`, and
    // `--restricted` documents that writes to settings, Git and tool-configuration files need a
    // person or a permission handler, so they stay denied.
    '--permission-mode',
    'acceptEdits',
  ],
  capabilities: [
    {
      control: 'workspace_write_confinement',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        '--restricted is documented to remove command-running tools and confine file tools to the working directories. This is the CLI permission system, not an OS sandbox; managed settings and their hooks still apply.',
    },
    {
      control: 'network_denied',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        '--restricted removes WebFetch. Other network-capable tools and the CLI process itself are not isolated by the operating system.',
    },
    {
      control: 'git_history_mutation_denied',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        'Without command tools, Git state can only change through file tools. Help text states writes to Git files need approval from a person or the permission handler (not covered by acceptEdits), which --permission-prompts none denies. A linked worktree keeps its Git directory outside the worktree.',
    },
    {
      control: 'git_push_denied',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes: 'Relies on command tools being unavailable; no OS-level network or write isolation.',
    },
    {
      control: 'credential_isolation',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        'File tools are documented as confined to the working directories. The process inherits the environment chosen by the adapter and the CLI keeps access to its own login.',
    },
    {
      control: 'untrusted_config_isolation',
      mechanism: 'launch_configuration',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        '--restricted ignores user, project and local settings files; --strict-mcp-config ignores MCP configuration not passed explicitly. Managed settings still apply.',
    },
    {
      control: 'non_interactive_approval',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        '--permission-prompts none is documented to deny anything that would prompt. --permission-mode acceptEdits approves file edits in the working directories without a prompt (intentional); it does not approve writes that --restricted reserves for a person or a permission handler.',
    },
  ],
});

const codexWorkspaceWrite = runtimeSecurityProfileSchema.parse({
  id: 'codex-exec-workspace-write',
  runtime: 'codex',
  assessedVersion: null,
  launchArguments: [
    'exec',
    '--sandbox',
    'workspace-write',
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
  ],
  capabilities: [
    {
      control: 'workspace_write_confinement',
      mechanism: 'os_sandbox',
      coversSubprocesses: true,
      verification: 'unverified',
      notes:
        'Codex runs model-generated commands under macOS Seatbelt with the workspace writable. Which additional roots (for example temporary directories) are writable has not been established.',
    },
    {
      control: 'network_denied',
      mechanism: 'os_sandbox',
      coversSubprocesses: true,
      verification: 'unverified',
      notes:
        'workspace-write is expected to disable network access by default; --ignore-user-config prevents user overrides. Repository-level configuration has not been assessed.',
    },
    {
      control: 'git_history_mutation_denied',
      mechanism: 'os_sandbox',
      coversSubprocesses: true,
      verification: 'unverified',
      notes:
        'A linked worktree stores refs, objects and config in the common Git directory outside the worktree, which should not be writable. The same restriction prevents `git add`.',
    },
    {
      control: 'git_push_denied',
      mechanism: 'os_sandbox',
      coversSubprocesses: true,
      verification: 'unverified',
      notes:
        'Depends on network denial (hosted remotes) and on local-path remotes lying outside the writable roots.',
    },
    {
      control: 'credential_isolation',
      mechanism: 'none',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        'workspace-write restricts writes, not reads: files such as ~/.ssh and Git credential stores may remain readable, and the environment is inherited unless the adapter filters it.',
    },
    {
      control: 'untrusted_config_isolation',
      mechanism: 'launch_configuration',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        '--ignore-user-config and --ignore-rules skip user configuration and execpolicy rules. Project-level configuration and hook trust have not been assessed.',
    },
    {
      control: 'non_interactive_approval',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        'codex exec runs non-interactively. --approve-for-me (automatic approval) is rejected as an unsafe argument.',
    },
  ],
});

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export const runtimeSecurityProfiles: Readonly<Record<AgentRuntime, RuntimeSecurityProfile>> =
  deepFreeze({ claude: claudeRestrictedPrint, codex: codexWorkspaceWrite });

export const getRuntimeSecurityProfile = (runtime: AgentRuntime): RuntimeSecurityProfile =>
  runtimeSecurityProfiles[runtime];

type ArgumentRule = {
  /** Long and short spellings of the option. */
  names: readonly string[];
  /** Returns a reason when the option (with its value, if any) is unsafe. */
  check: (value: string | undefined) => string | null;
  /** Whether the option consumes the next argument as its value. */
  takesValue: boolean;
};

const always = (reason: string) => (): string | null => reason;

const sharedRules: readonly ArgumentRule[] = [
  {
    names: ['--add-dir'],
    takesValue: true,
    check: always('grants access to directories outside the task worktree'),
  },
];

const claudeRules: readonly ArgumentRule[] = [
  {
    names: ['--allow-dangerously-skip-permissions'],
    takesValue: false,
    check: always('enables bypassing all permission checks'),
  },
  {
    names: ['--permission-mode'],
    takesValue: true,
    check: (value) =>
      value === 'bypassPermissions' || value === 'auto'
        ? `permission mode "${value}" approves actions without denial`
        : null,
  },
  {
    names: ['--permission-prompt-tool'],
    takesValue: true,
    check: always('delegates approval decisions to an external tool'),
  },
  {
    names: ['--settings'],
    takesValue: true,
    check: always('loads additional settings that may grant permissions'),
  },
];

/** Codex config keys that change the sandbox, approvals, or the subprocess environment. */
const codexSecurityConfigKeys = [
  'sandbox_mode',
  'sandbox_workspace_write',
  'sandbox_permissions',
  'approval_policy',
  'shell_environment_policy',
  'permissions',
  'features',
];

const codexRules: readonly ArgumentRule[] = [
  {
    names: ['--sandbox', '-s'],
    takesValue: true,
    check: (value) =>
      value === 'workspace-write' || value === 'read-only'
        ? null
        : `sandbox mode "${value ?? ''}" is not an approved sandbox`,
  },
  {
    names: ['--approve-for-me', '--full-auto', '--yolo'],
    takesValue: false,
    check: always('approves actions automatically or disables the sandbox'),
  },
  {
    names: ['--config', '-c'],
    takesValue: true,
    check: (value) => {
      const key = (value ?? '').split('=')[0]?.trim() ?? '';
      return codexSecurityConfigKeys.some(
        (prefix) => key === prefix || key.startsWith(`${prefix}.`),
      )
        ? `config override "${key}" changes security settings`
        : null;
    },
  },
  {
    names: ['--enable', '--disable'],
    takesValue: true,
    check: always('feature flags may change sandbox behavior'),
  },
  {
    names: ['--profile', '-p'],
    takesValue: true,
    check: always('loads an additional configuration layer'),
  },
  {
    names: ['--cd', '-C'],
    takesValue: true,
    check: always('changes the working root away from the verified worktree'),
  },
  {
    names: ['--worktree'],
    takesValue: false,
    check: always('runs in a worktree created by the CLI instead of the verified worktree'),
  },
];

const rulesByRuntime: Record<AgentRuntime, readonly ArgumentRule[]> = {
  claude: [...sharedRules, ...claudeRules],
  codex: [...sharedRules, ...codexRules],
};

/**
 * Returns reasons why launch arguments would bypass or widen the CLI's restrictions. This is a
 * deny list of known options for the assessed CLI versions, a defense in depth on top of fixed,
 * reviewed launch profiles; it cannot recognize options added by future CLI versions.
 */
export const findUnsafeLaunchArguments = (
  runtime: AgentRuntime,
  args: readonly string[],
): string[] => {
  const rules = rulesByRuntime[runtime];
  const problems: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (argument.startsWith('--dangerously')) {
      problems.push(`${argument}: bypasses approvals, permissions, or the sandbox`);
      continue;
    }
    const separator = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const rule = rules.find((candidate) => candidate.names.includes(name));
    if (rule === undefined) {
      continue;
    }
    let value: string | undefined;
    if (separator !== -1) {
      value = argument.slice(separator + 1);
    } else if (rule.takesValue) {
      value = args[index + 1];
      index += 1;
    }
    const reason = rule.check(value);
    if (reason !== null) {
      problems.push(`${name}: ${reason}`);
    }
  }
  return problems;
};
