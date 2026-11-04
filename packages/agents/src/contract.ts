import type {
  AgentRuntime,
  AuthorizedInvocation,
  ExecutableIdentity,
  RuntimeSecurityProfile,
} from '@ai-agent-manager/core';

/**
 * File facts of the CLI binary observed during discovery. Checked by the gate and again
 * immediately before spawning, so a binary replaced after discovery (for example by a CLI
 * auto-update) is not executed.
 */
export type ExecutableFingerprint = Omit<ExecutableIdentity, 'path'>;

/** A locally installed CLI that passed discovery. Discovery says nothing about security. */
export type CliInstallation = {
  runtime: AgentRuntime;
  /** Canonical absolute path (symlinks resolved); the process is spawned from exactly this path. */
  executablePath: string;
  fingerprint: ExecutableFingerprint;
  /** Parsed version, for example `2.1.317`; compared verbatim with security profiles. */
  version: string;
  /** Long options listed in the CLI help output that the adapter relies on or may use. */
  detectedOptions: readonly string[];
  detectedAt: string;
};

export const cliUnavailableReasons = [
  'not_found',
  'not_executable',
  'version_failed',
  'version_unrecognized',
  'version_unsupported',
  'help_failed',
  'options_missing',
] as const;

export type CliUnavailableReason = (typeof cliUnavailableReasons)[number];

export type CliDetection =
  | { status: 'available'; installation: CliInstallation }
  | {
      status: 'unavailable';
      runtime: AgentRuntime;
      reason: CliUnavailableReason;
      /** Actionable explanation; never contains environment values. */
      message: string;
      executablePath?: string;
      version?: string;
    };

export type CliDetectionOptions = {
  /** Absolute path to the CLI; skips the `PATH` search. */
  executablePath?: string;
  /** Directories searched for the executable; defaults to `PATH` of `sourceEnvironment`. */
  searchPath?: readonly string[];
  /** Environment the allow-listed child environment is derived from; defaults to `process.env`. */
  sourceEnvironment?: NodeJS.ProcessEnv;
  /** `cwd` for `--version`/`--help`; defaults to the OS temporary directory. */
  probeDirectory?: string;
  /** Per-probe timeout; defaults to 15 seconds. */
  timeoutMs?: number;
  now?: () => Date;
};

/** How a session can be continued later. Resume is not implemented in M1-02. */
export type SessionResumeSupport =
  { status: 'unsupported'; reason: string } | { status: 'unverified'; reason: string };

/**
 * What the adapter can do with a detected installation. These are interface facts, not security
 * facts: security enforcement is described only by `RuntimeSecurityProfile` and decided by the
 * execution gate.
 */
export type AgentCapabilities = {
  runtime: AgentRuntime;
  /** Execution Mode: one non-interactive task run in a verified worktree. */
  executionMode: boolean;
  /** Conversation Mode is a separate future contract (AI Conversations, C1). */
  conversationMode: 'not_implemented';
  /** The CLI emits machine-readable events that the adapter parses. */
  structuredEvents: boolean;
  /** An explicit model can be passed (`--model`). `null` (Default) is always supported. */
  explicitModelSelection: boolean;
  /** The CLI reports a session/thread identifier in its event stream. */
  sessionIdReporting: boolean;
  /** The CLI reports the model it actually used. */
  reportedModelMetadata: boolean;
  /** Tool or command activity is reported as events. */
  toolActivityEvents: boolean;
  sessionResume: SessionResumeSupport;
};

/** Execution Mode request: one task run in a worktree. Untrusted until validated. */
export type AgentExecutionRequest = {
  /** Opaque run identifier attached to every event. */
  runId: string;
  /** Final prompt text (instructions already composed by the worker). Sent via stdin, never logged. */
  prompt: string;
  /** `null` means Default: no model option is passed and the CLI decides. */
  modelId: string | null;
  /** Canonical working directory; must equal the authorization's `workspace.workingDirectory`. */
  workingDirectory: string;
  /** Wall-clock limit; the run fails with `timeout` when exceeded. */
  timeoutMs?: number;
  /** Not supported yet; any value is rejected. Reserved for verified session resume. */
  resumeSessionId?: string;
};

/**
 * A prepared CLI invocation. **Not authorized and not safe to execute by itself**: only
 * `startAgentExecution`, given a matching `ExecutionAuthorization`, launches anything. Contains no
 * environment values.
 */
export type UnauthorizedInvocationPlan = {
  runtime: AgentRuntime;
  authorization: 'required';
  executablePath: string;
  /** Exactly `profileArguments`, then adapter output options, then the model option, if any. */
  args: readonly string[];
  /** The security profile's `launchArguments`, verbatim, at the start of `args`. */
  profileArguments: readonly string[];
  launchProfileId: string;
  cwd: string;
  /** The prompt is written to stdin and the stream closed. */
  promptTransport: 'stdin';
  modelId: string | null;
  /** Names of environment variables passed to the child (values are never part of the plan). */
  environmentNames: readonly string[];
  /**
   * What the gate must authorize (`AuthorizeAgentExecutionRequest.invocation`): executable
   * identity, exactly `args`, and the digest of the child environment.
   */
  invocation: AuthorizedInvocation;
};

export const invocationErrorCodes = [
  'invalid_request',
  'model_invalid',
  'model_selection_unsupported',
  'resume_unsupported',
  'unsafe_arguments',
  'installation_mismatch',
] as const;

export type InvocationErrorCode = (typeof invocationErrorCodes)[number];

export type InvocationPreparation =
  | { ok: true; plan: UnauthorizedInvocationPlan }
  | { ok: false; code: InvocationErrorCode; message: string };

/** Normalized output, as produced by an adapter's parser. */
export type AgentOutputEvent =
  | { type: 'message'; text: string; truncated: boolean }
  | {
      type: 'tool_activity';
      phase: 'started' | 'completed' | 'failed';
      toolName: string;
      toolId?: string;
      /** Short, truncated description (Codex command or file paths). Never tool input payloads. */
      detail?: string;
    }
  | { type: 'metadata'; sessionId?: string; reportedModelId?: string }
  /** A provider message that is not necessarily fatal (for example a Codex reconnect notice). */
  | { type: 'provider_notice'; message: string }
  | { type: 'stderr'; text: string; truncated: boolean }
  | {
      type: 'diagnostic';
      code:
        | 'malformed_output'
        | 'unrecognized_event'
        | 'line_truncated'
        | 'stderr_truncated'
        | 'lingering_processes';
      message: string;
    };

export const agentFailureCodes = [
  /** The process could not be started. */
  'spawn_failed',
  /** The launch boundary refused to start (authorization, plan, or executable mismatch). */
  'launch_rejected',
  /** The run exceeded `timeoutMs`. */
  'timeout',
  /** Stdout exceeded the output limit; the process was terminated. */
  'output_limit_exceeded',
  /** The `emit` callback threw; the process was terminated. */
  'event_handler_failed',
  /** The process was killed by a signal that AI Agent Manager did not send. */
  'terminated_by_signal',
  /** The explicitly selected model was refused (heuristic; never followed by a fallback). */
  'model_unavailable',
  /** The CLI reported an error (API, authentication, turn limit, ...). */
  'provider_error',
  /** Non-zero exit code without a more specific classification. */
  'non_zero_exit',
  /** Exit code 0, but the CLI never reported a successful result. */
  'incomplete_output',
] as const;

export type AgentFailureCode = (typeof agentFailureCodes)[number];

export type AgentRunOutcome =
  | { status: 'completed'; exitCode: 0; signal: null; summary?: string }
  | {
      status: 'failed';
      code: AgentFailureCode;
      message: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      /** Stop was requested through `AgentHandle.stop()`, whatever the exit code. */
      status: 'stopped';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    };

/** How descendants left in the process group were handled after the main process exited. */
export type LingeringProcessState = 'none' | 'terminated' | 'unknown';

export type AgentRunResult = AgentRunOutcome & {
  runId: string;
  runtime: AgentRuntime;
  pid: number | null;
  startedAt: string;
  endedAt: string;
  sessionId?: string;
  reportedModelId?: string;
  stdoutBytes: number;
  stderrBytes: number;
  lingeringProcesses: LingeringProcessState;
};

export type AgentLifecycleEvent =
  | { type: 'started'; pid: number; processGroupId: number | null }
  | { type: 'stopping'; reason: 'requested' | 'timeout' | 'output_limit' | 'event_handler_failed' }
  | { type: 'completed'; result: AgentRunResult }
  | { type: 'failed'; result: AgentRunResult }
  | { type: 'stopped'; result: AgentRunResult };

export type AgentEventEnvelope = {
  runId: string;
  runtime: AgentRuntime;
  /** Monotonic per run, starting at 1. */
  sequence: number;
  timestamp: string;
};

/** Every event delivered to `emit`. Exactly one terminal event (`completed`/`failed`/`stopped`). */
export type AgentEvent = AgentEventEnvelope & (AgentOutputEvent | AgentLifecycleEvent);

/** What a parser concluded from the CLI's own events, independent of the exit status. */
export type ProviderOutcome =
  | { status: 'none' }
  | { status: 'succeeded'; summary?: string }
  | { status: 'failed'; message: string };

/** Stateful parser for one run's stdout. Never throws on provider data. */
export type AgentOutputParser = {
  /** Parses one complete stdout line (without the newline). */
  parseLine: (line: string) => AgentOutputEvent[];
  /** Outcome reported by the CLI so far, plus the last notice for failure messages. */
  outcome: () => ProviderOutcome;
  lastNotice: () => string | null;
};

export type AgentHandle = {
  runId: string;
  pid: number | null;
  /** Requests a graceful stop (SIGTERM to the process group, SIGKILL after a grace period). */
  stop: () => Promise<AgentRunResult>;
  /** Resolves exactly once, after the process and its streams have been reconciled. Never rejects. */
  completed: Promise<AgentRunResult>;
};

/**
 * Adapter for one CLI runtime. Adapters are pure description and parsing; process execution goes
 * through `startAgentExecution`, which requires an `ExecutionAuthorization`.
 *
 * Conversation Mode will be a separate, smaller contract reusing `detect` and the parser; it is
 * deliberately not part of this type.
 */
export type AgentAdapter = {
  readonly runtime: AgentRuntime;
  /** Trusted, code-defined security profile whose arguments every invocation starts with. */
  readonly securityProfile: RuntimeSecurityProfile;
  detect: (options?: CliDetectionOptions) => Promise<CliDetection>;
  capabilities: (installation: CliInstallation) => AgentCapabilities;
  prepareExecution: (
    installation: CliInstallation,
    request: AgentExecutionRequest,
    options?: { sourceEnvironment?: NodeJS.ProcessEnv },
  ) => InvocationPreparation;
  createOutputParser: (context: { explicitModel: boolean }) => AgentOutputParser;
  /** Builds the child environment for this runtime from an allow list. */
  buildEnvironment: (source: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};
