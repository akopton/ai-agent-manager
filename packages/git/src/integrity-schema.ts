import { z } from 'zod';

/**
 * Contracts of the read-only Git integrity snapshot (SEC-02d). Snapshots are plain JSON data so a
 * worker can keep the pre-run baseline in memory or persist it with the run; they are validated
 * with these schemas again before every comparison.
 */

const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const pathSchema = z.string().min(1).max(4096);
/** A ref name, config key, or file name; bounded and never a config value. */
const subjectSchema = z.string().min(1).max(1024);
/** `dev` and `ino` as decimal strings (bigint values do not survive JSON). */
const fileIdentitySchema = z
  .object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) })
  .strict();

export type FileIdentity = z.infer<typeof fileIdentitySchema>;

export const integrityFailureReasons = [
  /** Git exited with an unexpected status or could not start. */
  'git_failed',
  /** A Git command exceeded its timeout. */
  'timeout',
  /** A Git command exceeded its output limit. */
  'output_limit',
  /** The observed state exceeded a snapshot limit (entries or bytes); it was not recorded. */
  'limit_exceeded',
  /** A file or directory could not be read. */
  'unreadable',
  /** Git reported malformed metadata (for example, a broken ref or an unparsable value). */
  'malformed',
  /** The overall inspection deadline passed before this section ran. */
  'deadline_exceeded',
  /** The repository or worktree is not the expected one, so it was not inspected further. */
  'identity_mismatch',
  /** A prerequisite (repository or task worktree verification) failed; nothing was inspected. */
  'not_verified',
  'unexpected',
] as const;

export type IntegrityFailureReason = (typeof integrityFailureReasons)[number];

const failureSchema = z
  .object({ reason: z.enum(integrityFailureReasons), message: z.string().max(500) })
  .strict();

export type IntegrityInspectionFailure = z.infer<typeof failureSchema>;

const observationSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('observed'), value }).strict(),
    z.object({ status: z.literal('failed'), failure: failureSchema }).strict(),
  ]);

/** A section of the snapshot: either fully observed or explicitly failed (never partial). */
export type Observation<T> =
  { status: 'observed'; value: T } | { status: 'failed'; failure: IntegrityInspectionFailure };

const repositorySectionSchema = z
  .object({
    root: pathSchema,
    commonDir: pathSchema,
    rootIdentity: fileIdentitySchema,
    commonDirIdentity: fileIdentitySchema,
  })
  .strict();

const taskWorktreeSectionSchema = z
  .object({
    path: pathSchema,
    identity: fileIdentitySchema.nullable(),
    /** `inspectTaskWorktree` state and sorted issues. */
    state: z.enum(['ready', 'absent', 'branch_only', 'inconsistent']),
    issues: z.array(z.string().max(64)).max(32),
    registered: z.boolean(),
    locked: z.boolean(),
    /** Branch name HEAD is attached to, or `null` when detached or unknown. */
    headBranch: subjectSchema.nullable(),
    headCommit: objectIdSchema.nullable(),
    /** Canonical per-worktree Git directory, when the worktree was verified. */
    gitDir: pathSchema.nullable(),
    /** Whether the expected base commit exists as a commit object. */
    baseCommitPresent: z.boolean(),
  })
  .strict();

const worktreeRecordSchema = z
  .object({
    path: pathSchema,
    role: z.enum(['main', 'task', 'other']),
    head: objectIdSchema.nullable(),
    /** Full ref name, or `null` when detached or bare. */
    branch: subjectSchema.nullable(),
    bare: z.boolean(),
    detached: z.boolean(),
    locked: z.boolean(),
    /** Digest of the lock reason; the reason text itself is not stored. */
    lockReasonDigest: digestSchema.nullable(),
    prunable: z.boolean(),
  })
  .strict();

export type WorktreeRecord = z.infer<typeof worktreeRecordSchema>;

const refRecordSchema = z
  .object({
    name: subjectSchema,
    target: objectIdSchema,
    /** Target of a symbolic ref (for example `refs/remotes/origin/HEAD`), otherwise `null`. */
    symref: subjectSchema.nullable(),
  })
  .strict();

export type RefRecord = z.infer<typeof refRecordSchema>;

export const configFiles = [
  /** `<common dir>/config`: shared by every worktree; holds remotes, hooksPath, filters. */
  'common_config',
  /** `<common dir>/config.worktree`: main worktree config with `extensions.worktreeConfig`. */
  'common_config_worktree',
  /** `<task git dir>/config.worktree`: task worktree config with `extensions.worktreeConfig`. */
  'task_config_worktree',
] as const;

export type ConfigFile = (typeof configFiles)[number];

const configEntrySchema = z
  .object({
    file: z.enum(configFiles),
    /** Config key as Git lists it, with URL credentials in subsections redacted. */
    key: subjectSchema,
    /** Number of values (multi-valued keys repeat). */
    count: z.number().int().positive(),
    /** SHA-256 over the ordered values. Values themselves are never stored. */
    valuesDigest: digestSchema,
  })
  .strict();

export type ConfigEntry = z.infer<typeof configEntrySchema>;

export const metadataEntryKinds = [
  'missing',
  'file',
  'symlink',
  'directory',
  'other',
  /** A parent directory resolves elsewhere (symlinked); the entry was not read. */
  'redirected',
] as const;

const metadataEntrySchema = z
  .object({
    /** `common`: the common Git dir; `task_admin`: the task worktree's Git dir; `task_worktree`. */
    location: z.enum(['common', 'task_admin', 'task_worktree']),
    name: subjectSchema,
    kind: z.enum(metadataEntryKinds),
    size: z.number().int().nonnegative().nullable(),
    executable: z.boolean(),
    /** SHA-256 of file content or symlink target text; `null` for other kinds. */
    digest: digestSchema.nullable(),
  })
  .strict();

export type MetadataEntry = z.infer<typeof metadataEntrySchema>;

const hooksSectionSchema = z
  .object({
    directory: z.enum(metadataEntryKinds),
    /** Digest of the symlink target when `hooks` itself is a symlink. */
    directoryDigest: digestSchema.nullable(),
    entries: z.array(metadataEntrySchema.omit({ location: true })).max(4096),
  })
  .strict();

const mainCheckoutStatusSectionSchema = z
  .object({
    path: pathSchema,
    /** Number of status records (changed, untracked, conflicted paths; untracked dirs collapsed). */
    entries: z.number().int().nonnegative(),
    /** SHA-256 of the raw `status --porcelain=v2 -z` output. */
    statusDigest: digestSchema,
  })
  .strict();

const boundedInt = (max: number) => z.number().int().positive().max(max);

/** Upper bounds and defaults of the snapshot limits. */
const limitBounds = {
  /** Refs recorded; more makes the `refs` section fail. Default 20 000. */
  maxRefs: [200_000, 20_000],
  /** Registered worktrees recorded. Default 256. */
  maxWorktrees: [4096, 256],
  /** Config entries per file. Default 4096. */
  maxConfigEntries: [65_536, 4096],
  /** Entries in the hooks directory. Default 256. */
  maxHookEntries: [4096, 256],
  /** Bytes read from one metadata file or hook. Default 1 MiB. */
  maxMetadataFileBytes: [16 * 1024 * 1024, 1024 * 1024],
  /** Total inspection time; later sections fail with `deadline_exceeded`. Default 60 s. */
  maxDurationMs: [600_000, 60_000],
} as const;

export const gitIntegrityLimitsSchema = z
  .object({
    maxRefs: boundedInt(limitBounds.maxRefs[0]).default(limitBounds.maxRefs[1]),
    maxWorktrees: boundedInt(limitBounds.maxWorktrees[0]).default(limitBounds.maxWorktrees[1]),
    maxConfigEntries: boundedInt(limitBounds.maxConfigEntries[0]).default(
      limitBounds.maxConfigEntries[1],
    ),
    maxHookEntries: boundedInt(limitBounds.maxHookEntries[0]).default(
      limitBounds.maxHookEntries[1],
    ),
    maxMetadataFileBytes: boundedInt(limitBounds.maxMetadataFileBytes[0]).default(
      limitBounds.maxMetadataFileBytes[1],
    ),
    maxDurationMs: boundedInt(limitBounds.maxDurationMs[0]).default(limitBounds.maxDurationMs[1]),
  })
  .strict();

/** Limits as recorded in a snapshot: every value present. */
const resolvedLimitsSchema = z
  .object({
    maxRefs: boundedInt(limitBounds.maxRefs[0]),
    maxWorktrees: boundedInt(limitBounds.maxWorktrees[0]),
    maxConfigEntries: boundedInt(limitBounds.maxConfigEntries[0]),
    maxHookEntries: boundedInt(limitBounds.maxHookEntries[0]),
    maxMetadataFileBytes: boundedInt(limitBounds.maxMetadataFileBytes[0]),
    maxDurationMs: boundedInt(limitBounds.maxDurationMs[0]),
  })
  .strict();

export type GitIntegrityLimits = z.input<typeof gitIntegrityLimitsSchema>;
export type ResolvedGitIntegrityLimits = z.infer<typeof resolvedLimitsSchema>;

const targetSchema = z
  .object({
    repositoryPath: pathSchema,
    worktreePath: pathSchema,
    branch: subjectSchema,
    baseCommit: objectIdSchema,
  })
  .strict();

export type GitIntegritySnapshotTarget = z.infer<typeof targetSchema>;

export const gitIntegritySections = [
  'repository',
  'taskWorktree',
  'worktrees',
  'refs',
  'config',
  'metadataFiles',
  'hooks',
  'mainCheckoutStatus',
] as const;

export type GitIntegritySection = (typeof gitIntegritySections)[number];

export const gitIntegritySnapshotSchema = z
  .object({
    version: z.literal(1),
    /** Informational; excluded from digests and comparison. */
    capturedAt: z.iso.datetime(),
    /** The target as requested; both snapshots of a comparison must have the same target. */
    target: targetSchema,
    limits: resolvedLimitsSchema,
    repository: observationSchema(repositorySectionSchema),
    taskWorktree: observationSchema(taskWorktreeSectionSchema),
    worktrees: observationSchema(z.array(worktreeRecordSchema).max(4096)),
    refs: observationSchema(z.array(refRecordSchema).max(200_000)),
    config: observationSchema(z.array(configEntrySchema).max(3 * 65_536)),
    metadataFiles: observationSchema(z.array(metadataEntrySchema).max(64)),
    hooks: observationSchema(hooksSectionSchema),
    mainCheckoutStatus: observationSchema(mainCheckoutStatusSectionSchema),
  })
  .strict();

export type GitIntegritySnapshot = z.infer<typeof gitIntegritySnapshotSchema>;
