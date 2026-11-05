import { z } from 'zod';
import {
  disclosureVersionSchema,
  securityControlSchema,
  securityControls,
  type SecurityControl,
} from './security-policy.js';

// Durable execution vocabulary for the first worker execution slice (M2-01/M2-02 run model,
// M4-02 run lifecycle, SEC-02 Trusted Local persistence). Task status, run status and Git
// integrity status are separate: a run can complete while its integrity check blocks review.

/** Run states (`ARCHITECTURE.md` §5.2). A task may have several runs (attempts). */
export const taskRunStatuses = [
  'pending',
  'starting',
  'running',
  'stopping',
  'completed',
  'stopped',
  'failed',
  'interrupted',
] as const;

export const taskRunStatusSchema = z.enum(taskRunStatuses);

export type TaskRunStatus = z.infer<typeof taskRunStatusSchema>;

/** Runs that hold runtime capacity. A slot is released only when the run leaves these states. */
export const activeTaskRunStatuses = [
  'pending',
  'starting',
  'running',
  'stopping',
] as const satisfies readonly TaskRunStatus[];

export const isActiveTaskRunStatus = (status: TaskRunStatus): boolean =>
  (activeTaskRunStatuses as readonly TaskRunStatus[]).includes(status);

export const taskRunStatusLabels: Readonly<Record<TaskRunStatus, string>> = {
  pending: 'Pending',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  completed: 'Completed',
  stopped: 'Stopped',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

/**
 * Outcome of the post-run Git integrity check (SEC-02d), stored separately from the process
 * outcome. `not_run` means no comparison exists (for example, no baseline was captured).
 */
export const gitIntegrityResultStatuses = [
  'not_run',
  'clean',
  'violation',
  'inconclusive',
] as const;

export const gitIntegrityResultStatusSchema = z.enum(gitIntegrityResultStatuses);

export type GitIntegrityResultStatus = z.infer<typeof gitIntegrityResultStatusSchema>;

/**
 * Whether a run may enter the human change review: the agent process completed **and** the Git
 * integrity check is clean. A clean check is "no observable violation", never an approval.
 */
export const isRunReviewEligible = (run: {
  status: TaskRunStatus;
  gitIntegrityStatus: GitIntegrityResultStatus;
}): boolean => run.status === 'completed' && run.gitIntegrityStatus === 'clean';

/** Per-project execution trust (SEC-02). `none` is the default; nothing runs without trust. */
export const projectExecutionTrusts = ['none', 'trusted_local'] as const;

export const projectExecutionTrustSchema = z.enum(projectExecutionTrusts);

export type ProjectExecutionTrust = z.infer<typeof projectExecutionTrustSchema>;

/**
 * The versioned Trusted Local disclosure (`SPEC.md` §12.1). Changing any statement requires a new
 * `version`; an acceptance of an older version is stale and blocks every launch until the operator
 * accepts again.
 */
export const trustedLocalDisclosure = Object.freeze({
  version: '2026-11-05.1',
  title: 'Trusted Local Mode',
  statements: Object.freeze([
    'Agents run as your macOS user, with your account permissions, on repositories you mark as trusted.',
    'The task worktree is the agent’s working directory, not an OS-enforced boundary.',
    'The agent may read and write other files, use local credentials (SSH keys, Git credential helpers, CLI logins) and reach the network, as far as your account allows.',
    'The agent could independently run `git commit` or `git push`. AI Agent Manager detects unexpected Git mutations after the run where it can, but does not prevent them. Pushes that update no local ref are not detected.',
    'Stop terminates the agent CLI’s process group, not every possible descendant process.',
    'The agent CLI may keep its own local records outside AI Agent Manager. Claude Code can persist session transcripts under ~/.claude/projects/, which may include prompts, replies, tool inputs and repository content.',
    'A run that ends successfully does not show that the task was done. Only the change review shows what changed.',
    'Nothing is committed or pushed automatically. Publishing happens only through Approve & Push.',
  ] as const),
  /** Every strict control is accepted as not enforced: no shipped profile enforces any of them. */
  acceptedRisks: Object.freeze([...securityControls]) as readonly SecurityControl[],
});

/** Mandatory wall-clock limit of a Trusted Local run started by the worker. */
export const defaultRunTimeoutMs = 30 * 60 * 1000;

/** Body of the operator's explicit Trusted Local acceptance. Must match the current disclosure. */
export const acceptTrustedLocalInputSchema = z.strictObject({
  disclosureVersion: disclosureVersionSchema,
  acceptedRisks: z.array(securityControlSchema).max(securityControls.length),
});

export type AcceptTrustedLocalInput = z.infer<typeof acceptTrustedLocalInputSchema>;

/**
 * Body of a project trust change. Granting names the repository identity the operator saw, so a
 * repository replaced at the same path is never trusted by accident.
 */
export const projectExecutionTrustInputSchema = z.discriminatedUnion('trust', [
  z.strictObject({
    trust: z.literal('trusted_local'),
    localPath: z.string().min(1).max(4096),
    gitCommonDir: z.string().min(1).max(4096),
  }),
  z.strictObject({ trust: z.literal('none') }),
]);

export type ProjectExecutionTrustInput = z.infer<typeof projectExecutionTrustInputSchema>;

/** Persisted operator consent, as the worker reads it before every claim and authorization. */
export type TrustedLocalConsent = {
  enabled: boolean;
  disclosureVersion: string | null;
  /** Unix milliseconds. */
  acceptedAt: number | null;
  acceptedRisks: readonly SecurityControl[];
};

/** Persisted project trust, with the project's registered repository identity. */
export type ProjectTrustState = {
  localPath: string;
  gitCommonDir: string;
  executionTrust: ProjectExecutionTrust;
  trustedCommonDir: string | null;
  /** Unix milliseconds. */
  trustedAt: number | null;
};

/** Expected reasons an execution command or claim is refused. */
export const executionErrorCodes = [
  'invalid_execution_input',
  'project_not_found',
  'task_not_found',
  'task_not_queued',
  'execution_already_requested',
  'trusted_local_not_enabled',
  'trusted_local_acceptance_stale',
  'project_not_trusted',
  'runtime_busy',
  'task_run_active',
  'command_expired',
  'run_not_active',
  'repository_changed',
  'worker_unavailable',
] as const;

export const executionErrorCodeSchema = z.enum(executionErrorCodes);

export type ExecutionErrorCode = z.infer<typeof executionErrorCodeSchema>;

export class ExecutionError extends Error {
  override name = 'ExecutionError';

  constructor(
    readonly code: ExecutionErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export type ConsentDecision =
  { ok: true } | { ok: false; code: ExecutionErrorCode; message: string };

/**
 * Decides from **persisted operator state only** whether a task of this project may be executed
 * in Trusted Local Mode. Task fields, request bodies and earlier successful runs never grant
 * consent. Strict Isolated Mode is never selected here: it stays fail-closed (no verified profile)
 * and there is no fallback between modes.
 */
export const evaluateTrustedLocalConsent = (
  consent: TrustedLocalConsent,
  project: ProjectTrustState,
): ConsentDecision => {
  if (!consent.enabled || consent.acceptedAt === null || consent.disclosureVersion === null) {
    return {
      ok: false,
      code: 'trusted_local_not_enabled',
      message: 'Trusted Local Mode is not enabled. Read and accept the disclosure in Settings.',
    };
  }
  if (consent.disclosureVersion !== trustedLocalDisclosure.version) {
    return {
      ok: false,
      code: 'trusted_local_acceptance_stale',
      message: 'The Trusted Local disclosure changed. Read and accept it again in Settings.',
    };
  }
  const missingRisk = trustedLocalDisclosure.acceptedRisks.find(
    (risk) => !consent.acceptedRisks.includes(risk),
  );
  if (missingRisk !== undefined) {
    return {
      ok: false,
      code: 'trusted_local_acceptance_stale',
      message: `The recorded acceptance does not include the risk "${missingRisk}". Accept the disclosure again.`,
    };
  }
  if (
    project.executionTrust !== 'trusted_local' ||
    project.trustedAt === null ||
    project.trustedCommonDir === null ||
    project.trustedCommonDir !== project.gitCommonDir
  ) {
    return {
      ok: false,
      code: 'project_not_trusted',
      message: 'This project is not trusted for local execution. Trust it on the project page.',
    };
  }
  return { ok: true };
};

/** Bounded text for persisted run summaries, error messages and event payloads. */
export const truncateText = (text: string, maxLength: number): string =>
  text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;

// Best-effort masking of common credential shapes in agent output before it is stored. This is
// not a guarantee: output is bounded and redacted, but an agent can print anything it can read.
const secretPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '***'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '***'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '***'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 ***'],
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd)[A-Za-z0-9_]*)(\s*[=:]\s*)["']?[^\s"']{6,}["']?/gi,
    '$1$2***',
  ],
  [/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1***@'],
];

/** Masks common secret shapes in text that is about to be persisted. */
export const redactSecrets = (text: string): string =>
  secretPatterns.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
