import {
  runtimeSecurityProfileSchema,
  type AgentRuntime,
  type RuntimeSecurityProfile,
} from '@ai-agent-manager/core';

/**
 * Conversation Mode launch profiles (C2). They are separate from the execution profiles in
 * `security-profiles.ts` and are never used for task runs; an execution profile is never used for
 * a conversation turn.
 *
 * Evidence (2026-11-07, Claude Code 2.1.317 and Codex CLI 0.166.0 on macOS):
 *
 * - Every option below is listed by the CLI's own help (captured in `tests/cli-help/`).
 * - Both complete argument lists were run **unauthenticated** (empty `HOME`, empty
 *   `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, no API keys; Claude additionally with `--bare`, which never
 *   reads OAuth or the keychain) in an empty directory. Both CLIs accepted the arguments and failed
 *   only on authentication. Claude's `init` event reported `"tools": []`, no MCP servers, skills or
 *   slash commands, and the model resolved from `--model`.
 * - No authenticated or adversarial run was made. Every capability therefore stays `unverified`,
 *   and Strict Isolated Mode refuses every conversation turn.
 */

const claudeConversation = runtimeSecurityProfileSchema.parse({
  id: 'claude-conversation-no-tools',
  runtime: 'claude',
  assessedVersion: null,
  launchArguments: [
    '--print',
    '--restricted',
    '--strict-mcp-config',
    '--permission-prompts',
    'none',
    // An empty list disables every built-in tool (documented: `Use "" to disable all tools`).
    '--tools',
    '',
    '--disable-slash-commands',
    // Nothing is written under ~/.claude/projects and the session cannot be resumed.
    '--no-session-persistence',
    // Disables CLAUDE.md, skills, plugins, hooks, MCP servers and custom agents; managed (policy)
    // settings still apply.
    '--safe-mode',
  ],
  capabilities: [
    {
      control: 'workspace_write_confinement',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        'The session starts with no built-in tools (--tools ""), so the model has no file or command tool. This is a CLI setting, not an OS sandbox, and has not been adversarially verified.',
    },
    {
      control: 'network_denied',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        'No web tools are available to the model. The CLI process itself connects to the provider and is not network-isolated by the operating system.',
    },
    {
      control: 'git_history_mutation_denied',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        'Without tools the model cannot run Git. The working directory is an empty scratch directory outside every repository. Not OS-enforced.',
    },
    {
      control: 'git_push_denied',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes: 'Relies on tools being unavailable; no OS-level isolation.',
    },
    {
      control: 'credential_isolation',
      mechanism: 'none',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        'The CLI runs as the operator and uses its own login. Nothing prevents the process from reading files the account can read.',
    },
    {
      control: 'untrusted_config_isolation',
      mechanism: 'launch_configuration',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        '--restricted ignores user, project and local settings; --safe-mode disables CLAUDE.md, skills, plugins, hooks and MCP; --strict-mcp-config ignores MCP configuration. Managed settings still apply.',
    },
    {
      control: 'non_interactive_approval',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes: '--permission-prompts none denies anything that would prompt.',
    },
  ],
});

const codexConversation = runtimeSecurityProfileSchema.parse({
  id: 'codex-conversation-read-only',
  runtime: 'codex',
  assessedVersion: null,
  launchArguments: [
    'exec',
    '--sandbox',
    'read-only',
    '--ignore-user-config',
    '--ignore-rules',
    // No session files are written to disk.
    '--ephemeral',
    // The scratch directory is deliberately not a Git repository.
    '--skip-git-repo-check',
    '--json',
  ],
  capabilities: [
    {
      control: 'workspace_write_confinement',
      mechanism: 'os_sandbox',
      coversSubprocesses: true,
      verification: 'unverified',
      notes:
        'Model-generated commands run under the read-only sandbox (macOS Seatbelt) with no writable root. Commands can still run and read files. Not adversarially verified.',
    },
    {
      control: 'network_denied',
      mechanism: 'os_sandbox',
      coversSubprocesses: true,
      verification: 'unverified',
      notes:
        'The read-only sandbox is expected to deny network access to model-generated commands. The CLI itself connects to the provider.',
    },
    {
      control: 'git_history_mutation_denied',
      mechanism: 'os_sandbox',
      coversSubprocesses: true,
      verification: 'unverified',
      notes:
        'Relies on the read-only sandbox; the working directory is an empty scratch directory outside every repository.',
    },
    {
      control: 'git_push_denied',
      mechanism: 'os_sandbox',
      coversSubprocesses: true,
      verification: 'unverified',
      notes: 'Relies on the sandbox denying network access and writes.',
    },
    {
      control: 'credential_isolation',
      mechanism: 'none',
      coversSubprocesses: false,
      verification: 'unverified',
      notes: 'The read-only sandbox restricts writes, not reads: credential files may be readable.',
    },
    {
      control: 'untrusted_config_isolation',
      mechanism: 'launch_configuration',
      coversSubprocesses: false,
      verification: 'unverified',
      notes:
        '--ignore-user-config and --ignore-rules skip user configuration and execpolicy rules; the scratch directory contains no project configuration. Authentication still uses CODEX_HOME.',
    },
    {
      control: 'non_interactive_approval',
      mechanism: 'cli_permission',
      coversSubprocesses: false,
      verification: 'unverified',
      notes: 'codex exec runs non-interactively; automatic approval options are never passed.',
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

/** Code-defined conversation profile per runtime. */
export const conversationSecurityProfiles: Readonly<Record<AgentRuntime, RuntimeSecurityProfile>> =
  deepFreeze({ claude: claudeConversation, codex: codexConversation });

export const getConversationSecurityProfile = (runtime: AgentRuntime): RuntimeSecurityProfile =>
  conversationSecurityProfiles[runtime];

/** How each runtime's conversation invocation is completed after the profile arguments. */
export const conversationInvocationShape: Readonly<
  Record<
    AgentRuntime,
    {
      /** Help options the conversation profile needs beyond the execution profile. */
      requiredOptions: readonly string[];
      outputArguments: readonly string[];
      trailingArguments: readonly string[];
      /** Options never emitted for a conversation turn, in addition to the security deny list. */
      forbiddenOptions: readonly string[];
    }
  >
> = deepFreeze({
  claude: {
    requiredOptions: [
      '--tools',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--safe-mode',
    ],
    outputArguments: ['--output-format', 'stream-json', '--verbose'],
    trailingArguments: [],
    forbiddenOptions: [
      '--fallback-model',
      '--resume',
      '-r',
      '--continue',
      '-c',
      '--fork-session',
      '--session-id',
      '--worktree',
      '-w',
      '--background',
      '--bg',
      '--cloud',
      '--remote-control',
      '--allowedTools',
      '--allowed-tools',
      '--mcp-config',
      '--plugin-dir',
      '--plugin-url',
      '--agents',
      '--setting-sources',
      '--add-dir',
      '--chrome',
      '--permission-mode',
    ],
  },
  codex: {
    requiredOptions: ['--ephemeral', '--skip-git-repo-check'],
    outputArguments: [],
    trailingArguments: ['-'],
    forbiddenOptions: [
      '--oss',
      '--local-provider',
      '--image',
      '-i',
      '--output-schema',
      '--output-last-message',
      '-o',
      '--cyber-access-program',
      '--thread-source',
      '--search',
      '--add-dir',
      '--cd',
      '-C',
    ],
  },
});
