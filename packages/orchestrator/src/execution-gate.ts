import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { findUnsafeLaunchArguments } from '@ai-agent-manager/agents';
import {
  agentRuntimeSchema,
  assessControl,
  executionSecurityPolicySchema,
  requiredSecurityControls,
  runtimeSecurityProfileSchema,
  type AgentRuntime,
  type AuthorizedControl,
  type AuthorizedInvocation,
  type ExecutionAuthorization,
  type ExecutionAuthorizationDecision,
  type ExecutionSecurityPolicy,
  type RuntimeSecurityProfile,
  type SecurityDenial,
  type VerifiedWorkspace,
} from '@ai-agent-manager/core';
import {
  GitInputError,
  inspectTaskWorktree,
  listWorktrees,
  TaskWorktreeError,
  validateRepository,
  type GitCommandOptions,
  type TaskWorktreeInspection,
  type TaskWorktreeIssue,
} from '@ai-agent-manager/git';

/** The workspace facts recorded when the task worktree was created (`TaskWorktree`). */
export type ExecutionWorkspaceRequest = {
  taskId: string;
  /** Canonical main working tree root (`TaskWorktree.repository.root`). */
  repositoryPath: string;
  /** Canonical common Git directory (`TaskWorktree.repository.commonDir`). */
  commonDir: string;
  /** Managed worktree root the task worktree was created under. */
  worktreeRoot: string;
  /** Canonical worktree path (`TaskWorktree.path`). */
  worktreePath: string;
  branchName: string;
  /** Full SHA recorded at creation (`TaskWorktree.baseCommit`). */
  baseCommit: string;
  /** Process `cwd`; defaults to `worktreePath`. Must be canonical and inside the worktree. */
  workingDirectory?: string;
};

export type AuthorizeAgentExecutionRequest = {
  runtime: AgentRuntime;
  /** CLI version detected by the adapter's availability check; `null` when unknown. */
  runtimeVersion: string | null;
  /** Trusted, code-defined launch profile (for example `getRuntimeSecurityProfile(runtime)`). */
  profile: RuntimeSecurityProfile;
  /** Untrusted until validated here. Missing means denial; there is no implicit default. */
  policy: unknown;
  /**
   * The complete launch, as prepared by the adapter (`UnauthorizedInvocationPlan.invocation`):
   * executable identity from discovery, every argument, and the environment digest. The gate
   * verifies the executable on disk and records the invocation in the authorization.
   */
  invocation: AuthorizedInvocation;
  workspace: ExecutionWorkspaceRequest;
  gitOptions?: GitCommandOptions;
  /** Clock for `checkedAt`; injectable for tests. */
  now?: () => Date;
};

const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0') && isAbsolute(value), 'must be an absolute path');

const fileNumberSchema = z.number().finite().nonnegative();

const invocationSchema = z
  .object({
    executable: z
      .object({
        path: absolutePathSchema,
        dev: fileNumberSchema,
        ino: fileNumberSchema,
        size: fileNumberSchema,
        mtimeMs: fileNumberSchema,
      })
      .strict(),
    arguments: z
      .array(
        z
          .string()
          .max(1000)
          .refine((value) => !value.includes('\0'), 'must not contain NUL characters'),
      )
      .max(200),
    environmentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a sha256 digest'),
  })
  .strict();

const requestSchema = z.object({
  runtime: agentRuntimeSchema,
  runtimeVersion: z.string().trim().min(1).max(100).nullable(),
  invocation: invocationSchema,
  workspace: z
    .object({
      taskId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      repositoryPath: absolutePathSchema,
      commonDir: absolutePathSchema,
      worktreeRoot: absolutePathSchema,
      worktreePath: absolutePathSchema,
      branchName: z.string().min(1).max(255),
      baseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'must be a full commit SHA'),
      workingDirectory: absolutePathSchema.optional(),
    })
    .strict(),
});

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'value'}: ${issue.message}`)
    .join('; ');

/** True when `child` is `parent` itself or inside it. */
const isWithin = (parent: string, child: string): boolean => {
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
};

const overlaps = (first: string, second: string): boolean =>
  isWithin(first, second) || isWithin(second, first);

const realpathOrNull = async (path: string): Promise<string | null> => {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/** Inspection issues that have a more specific denial than `worktree_not_verified`. */
const issueDenials: Partial<Record<TaskWorktreeIssue, SecurityDenial['code']>> = {
  branch_mismatch: 'branch_mismatch',
  branch_missing: 'branch_mismatch',
  lock_missing: 'ownership_not_verified',
  lock_reason_mismatch: 'ownership_not_verified',
  different_repository: 'repository_mismatch',
  main_worktree: 'unsafe_path_relationship',
  path_is_symlink: 'path_not_canonical',
};

/**
 * Verifies that the executable is a canonical, executable regular file whose identity still
 * equals the one observed at discovery. Read-only.
 */
const verifyExecutable = async (
  executable: AuthorizedInvocation['executable'],
): Promise<SecurityDenial[]> => {
  const deny = (message: string): SecurityDenial[] => [
    { code: 'executable_not_verified', message },
  ];
  const canonical = await realpathOrNull(executable.path);
  if (canonical === null) {
    return deny(`The executable ${executable.path} does not exist.`);
  }
  if (canonical !== executable.path) {
    return deny(
      `The executable ${executable.path} resolves to ${canonical}; only canonical paths are accepted.`,
    );
  }
  const stats = await stat(canonical).catch(() => null);
  const runnable = await access(canonical, constants.X_OK).then(
    () => true,
    () => false,
  );
  if (stats === null || !stats.isFile() || !runnable) {
    return deny(`The executable ${canonical} is not an executable regular file.`);
  }
  if (
    stats.dev !== executable.dev ||
    stats.ino !== executable.ino ||
    stats.size !== executable.size ||
    stats.mtimeMs !== executable.mtimeMs
  ) {
    return deny(
      `The executable ${canonical} changed since it was detected; detect the CLI again before authorizing.`,
    );
  }
  return [];
};

const assessPolicy = (
  policy: ExecutionSecurityPolicy,
  profile: RuntimeSecurityProfile,
  runtimeVersion: string | null,
): { controls: AuthorizedControl[]; denials: SecurityDenial[] } => {
  const controls: AuthorizedControl[] = [];
  const denials: SecurityDenial[] = [];
  for (const control of requiredSecurityControls(policy)) {
    const assessment = assessControl(profile, control, runtimeVersion);
    if (assessment.status === 'enforced') {
      controls.push({ control, status: 'enforced', mechanism: assessment.mechanism });
      continue;
    }
    // Mandatory controls are fail-closed: an acknowledgement is context for the user, not a waiver.
    const acknowledgement = policy.riskAcknowledgements.find(
      (acknowledgement) => acknowledgement.control === control,
    )?.reason;
    denials.push({
      code: 'control_not_enforced',
      control,
      message: `The policy requires "${control}", but launch profile "${profile.id}" does not enforce it (${assessment.status}, ${assessment.mechanism}): ${assessment.notes} A verified enforcement mechanism is required; acknowledging the risk does not authorize execution.`,
      assessment,
      ...(acknowledgement === undefined ? {} : { acknowledgement }),
    });
  }
  return { controls, denials };
};

/** Verifies the worktree and working directory; read-only. */
const verifyWorkspace = async (
  workspace: z.output<typeof requestSchema>['workspace'],
  gitOptions: GitCommandOptions,
): Promise<{ verified: VerifiedWorkspace | null; denials: SecurityDenial[] }> => {
  const denials: SecurityDenial[] = [];
  const deny = (code: SecurityDenial['code'], message: string, issues?: readonly string[]) => {
    denials.push(issues === undefined ? { code, message } : { code, message, issues });
    return { verified: null, denials };
  };

  const workingDirectory = workspace.workingDirectory ?? workspace.worktreePath;
  const recordedPaths = {
    repositoryPath: workspace.repositoryPath,
    commonDir: workspace.commonDir,
    worktreePath: workspace.worktreePath,
    workingDirectory,
  };
  for (const [name, path] of Object.entries(recordedPaths)) {
    const canonical = await realpathOrNull(path);
    if (canonical === null) {
      denials.push({
        code: name === 'worktreePath' ? 'worktree_not_verified' : 'invalid_request',
        message: `${name} ${path} does not exist or cannot be resolved.`,
      });
    } else if (canonical !== path) {
      denials.push({
        code: 'path_not_canonical',
        message: `${name} ${path} resolves to ${canonical}; symlinked or non-canonical paths are not accepted.`,
      });
    }
  }
  const worktreeRoot = await realpathOrNull(workspace.worktreeRoot);
  if (worktreeRoot === null) {
    denials.push({
      code: 'invalid_request',
      message: `worktreeRoot ${workspace.worktreeRoot} does not exist or cannot be resolved.`,
    });
  }
  if (denials.length > 0 || worktreeRoot === null) {
    return { verified: null, denials };
  }

  let inspection: TaskWorktreeInspection;
  try {
    inspection = await inspectTaskWorktree({
      ...gitOptions,
      repositoryPath: workspace.repositoryPath,
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
    });
  } catch (error) {
    if (error instanceof TaskWorktreeError && error.code === 'INVALID_REPOSITORY') {
      return deny('repository_invalid', error.message);
    }
    if (error instanceof GitInputError) {
      return deny('invalid_request', error.message);
    }
    return deny(
      'inspection_failed',
      `The worktree could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const { repository } = inspection;
  if (
    repository.root !== workspace.repositoryPath ||
    repository.commonDir !== workspace.commonDir
  ) {
    deny(
      'repository_mismatch',
      `The repository at ${repository.root} (Git directory ${repository.commonDir}) is not the repository recorded for the task.`,
    );
  }

  if (inspection.state !== 'ready') {
    const unmapped: TaskWorktreeIssue[] = [];
    for (const issue of inspection.issues) {
      const code = issueDenials[issue];
      if (code === undefined) {
        unmapped.push(issue);
      } else {
        deny(code, `Worktree check failed: ${issue}.`, [issue]);
      }
    }
    if (unmapped.length > 0 || inspection.issues.length === 0) {
      deny(
        'worktree_not_verified',
        `Git does not confirm ${inspection.path} as a ready task worktree (${inspection.state}${
          unmapped.length > 0 ? `: ${unmapped.join(', ')}` : ''
        }).`,
        unmapped,
      );
    }
    return { verified: null, denials };
  }

  if (inspection.head?.commit !== workspace.baseCommit) {
    deny(
      'unexpected_head',
      `HEAD is ${inspection.head?.commit ?? 'unknown'}, not the recorded base commit ${workspace.baseCommit}; commits were made in the worktree outside the publish workflow.`,
    );
  }
  if (inspection.branchCommit !== workspace.baseCommit) {
    deny(
      'unexpected_head',
      `Branch "${inspection.branch}" points to ${inspection.branchCommit ?? 'nothing'}, not the recorded base commit.`,
    );
  }

  const expectedPath = join(worktreeRoot, repository.key, workspace.taskId);
  if (inspection.path !== expectedPath) {
    deny(
      'path_outside_workspace',
      `The worktree ${inspection.path} is not at the managed location ${expectedPath} for this task.`,
    );
  }

  if (
    overlaps(inspection.path, repository.root) ||
    overlaps(inspection.path, repository.commonDir)
  ) {
    deny(
      'unsafe_path_relationship',
      'The worktree overlaps the main checkout or the Git directory.',
    );
  }
  try {
    const others = (await listWorktrees(repository.root, gitOptions)).filter(
      (entry) => entry.path !== inspection.path,
    );
    const nested = others.filter((entry) => overlaps(entry.path, inspection.path));
    if (nested.length > 0) {
      deny(
        'unsafe_path_relationship',
        `The worktree overlaps other worktrees: ${nested.map((entry) => entry.path).join(', ')}.`,
      );
    }
  } catch (error) {
    deny(
      'inspection_failed',
      `Registered worktrees could not be listed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const uid = process.getuid?.();
  for (const path of [inspection.path, join(worktreeRoot, repository.key)]) {
    const stats = await lstat(path).catch(() => null);
    if (stats === null || !stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      deny('ownership_not_verified', `${path} must be a directory owned by the current user.`);
    }
  }

  if (!isWithin(inspection.path, workingDirectory)) {
    deny(
      'path_outside_workspace',
      `The working directory ${workingDirectory} is outside the worktree ${inspection.path}.`,
    );
  } else if (workingDirectory !== inspection.path) {
    const stats = await lstat(workingDirectory).catch(() => null);
    const validation = await validateRepository(workingDirectory, {
      ...gitOptions,
      allowNestedPath: true,
    }).catch(() => null);
    if (stats === null || !stats.isDirectory()) {
      deny('invalid_request', `The working directory ${workingDirectory} is not a directory.`);
    } else if (
      validation === null ||
      !validation.valid ||
      validation.repository.root !== inspection.path ||
      validation.repository.commonDir !== repository.commonDir
    ) {
      deny(
        'unsafe_path_relationship',
        `The working directory ${workingDirectory} belongs to a different or nested repository.`,
      );
    }
  }

  if (denials.length > 0) {
    return { verified: null, denials };
  }
  return {
    verified: {
      repositoryRoot: repository.root,
      commonDir: repository.commonDir,
      worktreePath: inspection.path,
      workingDirectory,
      branch: inspection.branch,
      baseCommit: workspace.baseCommit,
    },
    denials,
  };
};

/**
 * Decides, before launch, whether an agent execution satisfies the security policy. Denies by
 * default: a missing or invalid policy, profile, or workspace fact, an unsafe launch argument, or
 * any required control that is not enforced produces a denial. Risk acknowledgements never waive one.
 *
 * Read-only: inspects Git and the filesystem without modifying either. Never changes Git
 * configuration (including `safe.directory`). The result is a point-in-time check; see
 * `ExecutionAuthorization` for what the execution layer must preserve.
 */
export const authorizeAgentExecution = async (
  request: AuthorizeAgentExecutionRequest,
): Promise<ExecutionAuthorizationDecision> => {
  const parsedRequest = requestSchema.safeParse(request);
  if (!parsedRequest.success) {
    return {
      authorized: false,
      denials: [{ code: 'invalid_request', message: describeIssues(parsedRequest.error) }],
    };
  }
  const { runtime, runtimeVersion, invocation, workspace } = parsedRequest.data;
  const denials: SecurityDenial[] = [];

  let policy: ExecutionSecurityPolicy | null = null;
  if (request.policy === undefined || request.policy === null) {
    denials.push({
      code: 'policy_missing',
      message: 'No security policy was supplied; executions are denied without one.',
    });
  } else {
    const parsed = executionSecurityPolicySchema.safeParse(request.policy);
    if (parsed.success) {
      policy = parsed.data;
    } else {
      denials.push({ code: 'policy_invalid', message: describeIssues(parsed.error) });
    }
  }

  let profile: RuntimeSecurityProfile | null = null;
  const parsedProfile = runtimeSecurityProfileSchema.safeParse(request.profile);
  if (!parsedProfile.success) {
    denials.push({ code: 'profile_invalid', message: describeIssues(parsedProfile.error) });
  } else if (parsedProfile.data.runtime !== runtime) {
    denials.push({
      code: 'profile_invalid',
      message: `Launch profile "${parsedProfile.data.id}" is for ${parsedProfile.data.runtime}, not ${runtime}.`,
    });
  } else {
    profile = parsedProfile.data;
    const { launchArguments } = profile;
    const startsWithProfile =
      invocation.arguments.length >= launchArguments.length &&
      launchArguments.every((argument, index) => invocation.arguments[index] === argument);
    if (!startsWithProfile) {
      denials.push({
        code: 'invocation_invalid',
        message: `The invocation arguments do not start with the launch arguments of profile "${profile.id}".`,
      });
    }
    // Check the complete invocation, so options appended after the profile arguments are covered.
    const checkedArguments = startsWithProfile ? invocation.arguments : launchArguments;
    for (const problem of findUnsafeLaunchArguments(runtime, checkedArguments)) {
      denials.push({ code: 'unsafe_launch_arguments', message: problem });
    }
  }

  denials.push(...(await verifyExecutable(invocation.executable)));

  let assessment: ReturnType<typeof assessPolicy> | null = null;
  if (policy !== null && profile !== null) {
    assessment = assessPolicy(policy, profile, runtimeVersion);
    denials.push(...assessment.denials);
  }

  const workspaceResult = await verifyWorkspace(workspace, request.gitOptions ?? {});
  denials.push(...workspaceResult.denials);

  if (
    denials.length > 0 ||
    policy === null ||
    profile === null ||
    assessment === null ||
    workspaceResult.verified === null
  ) {
    return deepFreeze({
      authorized: false,
      denials:
        denials.length > 0
          ? denials
          : [{ code: 'inspection_failed', message: 'Authorization could not be completed.' }],
    });
  }

  const authorization: ExecutionAuthorization = {
    runtime,
    runtimeVersion,
    launchProfileId: profile.id,
    launchArguments: [...profile.launchArguments],
    invocation: {
      executable: { ...invocation.executable },
      arguments: [...invocation.arguments],
      environmentDigest: invocation.environmentDigest,
    },
    workspace: workspaceResult.verified,
    policy,
    controls: assessment.controls,
    checkedAt: (request.now?.() ?? new Date()).toISOString(),
  };
  return deepFreeze({ authorized: true, authorization });
};
