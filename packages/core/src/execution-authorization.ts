import type { AgentRuntime } from './agent-runtime.js';
import type {
  ControlAssessment,
  EnforcementMechanism,
  ExecutionSecurityPolicy,
  SecurityControl,
} from './security-policy.js';

export const securityDenialCodes = [
  /** The request is malformed (missing fields, relative paths, invalid identifiers). */
  'invalid_request',
  /** No security policy was supplied. */
  'policy_missing',
  /** The policy is invalid or requests something unsupported. */
  'policy_invalid',
  /** The launch profile is invalid or belongs to another runtime. */
  'profile_invalid',
  /** The launch profile contains arguments that bypass or widen CLI restrictions. */
  'unsafe_launch_arguments',
  /** A required control is not enforced; risk acknowledgements do not change this. */
  'control_not_enforced',
  /** The repository is not a valid main working tree, or Git refused it (safe.directory). */
  'repository_invalid',
  /** The repository is not the one recorded for the task. */
  'repository_mismatch',
  /** Git does not confirm the worktree as a ready AI Agent Manager task worktree. */
  'worktree_not_verified',
  /** The worktree is not on the expected task branch. */
  'branch_mismatch',
  /** The AI Agent Manager lock marker or filesystem ownership does not match. */
  'ownership_not_verified',
  /** HEAD or the task branch moved away from the recorded base commit. */
  'unexpected_head',
  /** A supplied path is not canonical (symlinked components, `..`, trailing segments). */
  'path_not_canonical',
  /** A path is outside the managed layout or the task worktree. */
  'path_outside_workspace',
  /** The worktree overlaps the main checkout, the Git directory, or another worktree. */
  'unsafe_path_relationship',
  /** Git or the filesystem failed unexpectedly; nothing could be verified. */
  'inspection_failed',
  /** The executable is not a canonical executable file, or differs from the identity in the request. */
  'executable_not_verified',
  /** The invocation does not start with the profile's launch arguments, or is malformed. */
  'invocation_invalid',
] as const;

export type SecurityDenialCode = (typeof securityDenialCodes)[number];

export type SecurityDenial = {
  code: SecurityDenialCode;
  /** Actionable explanation for the user. */
  message: string;
  control?: SecurityControl;
  /** Git inspection issues, when the worktree could not be verified. */
  issues?: readonly string[];
  /** For `control_not_enforced`: why the launch profile does not enforce the control. */
  assessment?: ControlAssessment;
  /**
   * For `control_not_enforced`: the user's risk acknowledgement from the policy, if any. Shown for
   * context only; it does not change the decision.
   */
  acknowledgement?: string;
};

/** Workspace facts verified during preflight. */
export type VerifiedWorkspace = {
  repositoryRoot: string;
  commonDir: string;
  worktreePath: string;
  /** Canonical directory to use as the process `cwd`; inside `worktreePath`. */
  workingDirectory: string;
  branch: string;
  baseCommit: string;
};

/**
 * Identity of an executable file: its canonical path plus the file facts observed at discovery.
 * A replaced or modified binary has a different identity.
 */
export type ExecutableIdentity = {
  /** Canonical absolute path (no symlinked components); the process is spawned from it. */
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

/** The complete process launch an authorization covers. */
export type AuthorizedInvocation = {
  executable: ExecutableIdentity;
  /**
   * Every argument after the executable, starting with the profile's `launchArguments`. The prompt
   * is not part of it: adapters send the prompt via stdin.
   */
  arguments: readonly string[];
  /**
   * `sha256:<hex>` over the complete child environment (sorted names and values). Binds the
   * environment without storing its values in the authorization.
   */
  environmentDigest: string;
};

export type AuthorizedControl = {
  control: SecurityControl;
  /** Always `enforced`: an authorization exists only when every required control is enforced. */
  status: 'enforced';
  mechanism: EnforcementMechanism;
};

/**
 * Preflight permission to launch one agent execution. It exists only when the workspace is
 * verified, the launch arguments are safe, **and** every required control is enforced; a valid
 * workspace and safe arguments alone never produce one.
 *
 * It is a point-in-time check, not a lasting guarantee: the execution layer must spawn exactly
 * `invocation.executable.path` with exactly `invocation.arguments`, an environment matching
 * `invocation.environmentDigest`, and `workspace.workingDirectory` as `cwd`, and must
 * re-authorize if anything (worktree, CLI binary or version, policy, profile, model) changes.
 */
export type ExecutionAuthorization = {
  runtime: AgentRuntime;
  runtimeVersion: string | null;
  launchProfileId: string;
  /** The profile's fixed arguments; `invocation.arguments` starts with them. */
  launchArguments: readonly string[];
  invocation: AuthorizedInvocation;
  workspace: VerifiedWorkspace;
  policy: ExecutionSecurityPolicy;
  controls: readonly AuthorizedControl[];
  checkedAt: string;
};

export type ExecutionAuthorizationDecision =
  | { authorized: true; authorization: ExecutionAuthorization }
  | { authorized: false; denials: readonly SecurityDenial[] };
