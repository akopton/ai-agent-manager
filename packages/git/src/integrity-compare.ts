import { createHash } from 'node:crypto';
import { captureGitIntegritySnapshot } from './integrity-capture.js';
import {
  gitIntegritySections,
  gitIntegritySnapshotSchema,
  type ConfigEntry,
  type ConfigFile,
  type GitIntegritySection,
  type GitIntegritySnapshot,
  type MetadataEntry,
  type Observation,
  type WorktreeRecord,
} from './integrity-schema.js';
import type { GitCommandOptions } from './schemas.js';

export type GitIntegrityFindingCode =
  // Violations: an observable, unexpected Git state change.
  | 'repository_identity_changed'
  | 'task_worktree_changed'
  | 'task_head_changed'
  | 'task_branch_moved'
  | 'base_commit_missing'
  | 'ref_created'
  | 'ref_deleted'
  | 'ref_moved'
  | 'main_checkout_head_changed'
  | 'main_checkout_status_changed'
  | 'other_worktree_head_changed'
  | 'worktree_added'
  | 'worktree_removed'
  | 'worktree_registry_changed'
  | 'config_changed'
  | 'hooks_path_changed'
  | 'remote_config_changed'
  | 'hooks_changed'
  | 'metadata_file_changed'
  // Inconclusive: the comparison cannot vouch for the state.
  | 'snapshot_invalid'
  | 'snapshot_mismatch'
  | 'baseline_not_verified'
  | 'inspection_incomplete';

/**
 * - `violation`: an observable Git state change outside normal working-tree edits in the task
 *   worktree. Blocks publishing until the operator reviews it.
 * - `inconclusive`: part of the state could not be observed or compared. Blocks publishing until
 *   reviewed; it is never read as clean.
 */
export type GitIntegrityDisposition = 'violation' | 'inconclusive';

export type RefCategory = 'branch' | 'remote_tracking' | 'tag' | 'other';

export type GitIntegrityFinding = {
  code: GitIntegrityFindingCode;
  disposition: GitIntegrityDisposition;
  section: GitIntegritySection | 'snapshot';
  /** Ref name, worktree path, `<file>:<config key>`, metadata file, or section. Never a value. */
  subject: string;
  change: 'added' | 'removed' | 'modified' | null;
  /** Commit IDs, states, or kinds; never config values or file contents. */
  before: string | null;
  after: string | null;
  /** For ref findings. */
  refCategory: RefCategory | null;
};

export type GitIntegrityStatus =
  /** No observable integrity violation. This does not prove that none occurred. */
  | 'clean'
  | 'violation'
  /** Nothing observable was found, but the inspection was incomplete or not comparable. */
  | 'inconclusive';

export type GitIntegrityPublication =
  /** May proceed to the normal human change review; never to automatic publishing. */
  | { decision: 'proceed_to_review' }
  | { decision: 'blocked'; reason: 'integrity_violation' | 'inspection_inconclusive' };

export type GitIntegrityComparison = {
  status: GitIntegrityStatus;
  publication: GitIntegrityPublication;
  /** Sorted: violations first, then by code and subject. At most `maxReportedFindings`. */
  findings: GitIntegrityFinding[];
  totalFindings: number;
  findingsTruncated: boolean;
  /** `digestGitIntegritySnapshot` of each side, or `null` when a snapshot was invalid. */
  beforeDigest: string | null;
  afterDigest: string | null;
  /** Reminder of what a comparison can show: before/after state, not transient actions. */
  coverage: 'observable_before_after_state';
};

export const maxReportedFindings = 500;

const sameSubjectOrder = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** JSON with object keys sorted recursively, so equal data always serializes identically. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => sameSubjectOrder(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * Deterministic SHA-256 of a snapshot's observed state (everything except `capturedAt`). Two
 * snapshots with the same digest observed the same state. Suitable for binding an operator review
 * decision to the exact comparison it reviewed.
 */
export const digestGitIntegritySnapshot = (snapshot: GitIntegritySnapshot): string => {
  const state: Partial<GitIntegritySnapshot> = normalizeSnapshot(snapshot);
  delete state.capturedAt;
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
};

const sortedBy = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  [...items].sort((left, right) => sameSubjectOrder(key(left), key(right)));

const mapObserved = <T>(observation: Observation<T>, map: (value: T) => T): Observation<T> =>
  observation.status === 'observed'
    ? { status: 'observed', value: map(observation.value) }
    : observation;

/** Sorts every list by its comparison key, so array order never affects digests. */
const normalizeSnapshot = (snapshot: GitIntegritySnapshot): GitIntegritySnapshot => ({
  ...snapshot,
  taskWorktree: mapObserved(snapshot.taskWorktree, (value) => ({
    ...value,
    issues: sortedBy(value.issues, (issue) => issue),
  })),
  worktrees: mapObserved(snapshot.worktrees, (value) => sortedBy(value, (entry) => entry.path)),
  refs: mapObserved(snapshot.refs, (value) => sortedBy(value, (ref) => ref.name)),
  config: mapObserved(snapshot.config, (value) =>
    sortedBy(value, (entry) => `${entry.file}\0${entry.key}`),
  ),
  metadataFiles: mapObserved(snapshot.metadataFiles, (value) =>
    sortedBy(value, (entry) => `${entry.location}\0${entry.name}`),
  ),
  hooks: mapObserved(snapshot.hooks, (value) => ({
    ...value,
    entries: sortedBy(value.entries, (entry) => entry.name),
  })),
});

const refCategory = (name: string): RefCategory => {
  if (name.startsWith('refs/heads/')) return 'branch';
  if (name.startsWith('refs/remotes/')) return 'remote_tracking';
  if (name.startsWith('refs/tags/')) return 'tag';
  return 'other';
};

const configCode = (key: string): GitIntegrityFindingCode => {
  const lower = key.toLowerCase();
  if (lower === 'core.hookspath') return 'hooks_path_changed';
  if (
    lower.startsWith('remote.') ||
    lower.startsWith('url.') ||
    (lower.startsWith('branch.') && /\.(remote|pushremote|merge)$/.test(lower))
  ) {
    return 'remote_config_changed';
  }
  return 'config_changed';
};

const configFileOfMetadata = (entry: MetadataEntry): ConfigFile | null => {
  if (entry.location === 'common' && entry.name === 'config') return 'common_config';
  if (entry.location === 'common' && entry.name === 'config.worktree') {
    return 'common_config_worktree';
  }
  if (entry.location === 'task_admin' && entry.name === 'config.worktree') {
    return 'task_config_worktree';
  }
  return null;
};

type Emit = (
  finding: Omit<GitIntegrityFinding, 'refCategory'> & { refCategory?: RefCategory },
) => void;

/** Calls `onDiff` for every key whose value differs, with `undefined` for a missing side. */
const diffByKey = <T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string,
  same: (left: T, right: T) => boolean,
  onDiff: (subject: string, left: T | undefined, right: T | undefined) => void,
): void => {
  const left = new Map(before.map((item) => [key(item), item]));
  const right = new Map(after.map((item) => [key(item), item]));
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort(sameSubjectOrder);
  for (const subject of keys) {
    const l = left.get(subject);
    const r = right.get(subject);
    if (l !== undefined && r !== undefined && same(l, r)) continue;
    onDiff(subject, l, r);
  }
};

const changeOf = (before: unknown, after: unknown): GitIntegrityFinding['change'] =>
  before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';

const equalJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const compareObserved = (
  before: GitIntegritySnapshot,
  after: GitIntegritySnapshot,
  emit: Emit,
): void => {
  const both = <K extends GitIntegritySection>(
    section: K,
  ): [ObservedValue<K>, ObservedValue<K>] | null => {
    const left = before[section] as Observation<ObservedValue<K>>;
    const right = after[section] as Observation<ObservedValue<K>>;
    return left.status === 'observed' && right.status === 'observed'
      ? [left.value, right.value]
      : null;
  };

  const repository = both('repository');
  if (repository !== null) {
    const [left, right] = repository;
    const fields = [
      ['root', left.root, right.root],
      ['commonDir', left.commonDir, right.commonDir],
      ['rootIdentity', identityText(left.rootIdentity), identityText(right.rootIdentity)],
      [
        'commonDirIdentity',
        identityText(left.commonDirIdentity),
        identityText(right.commonDirIdentity),
      ],
    ] as const;
    for (const [subject, l, r] of fields) {
      if (l !== r) {
        emit({
          code: 'repository_identity_changed',
          disposition: 'violation',
          section: 'repository',
          subject,
          change: 'modified',
          before: l,
          after: r,
        });
      }
    }
  }

  const task = both('taskWorktree');
  if (task !== null) {
    const [left, right] = task;
    if (left.baseCommitPresent && !right.baseCommitPresent) {
      emit({
        code: 'base_commit_missing',
        disposition: 'violation',
        section: 'taskWorktree',
        subject: before.target.baseCommit,
        change: 'removed',
        before: 'present',
        after: 'missing',
      });
    }
    const identity = (value: typeof left) => [
      value.path,
      value.identity,
      value.state,
      value.issues,
      value.registered,
      value.locked,
      value.gitDir,
    ];
    if (!equalJson(identity(left), identity(right))) {
      emit({
        code: 'task_worktree_changed',
        disposition: 'violation',
        section: 'taskWorktree',
        subject: left.path,
        change: 'modified',
        before: left.state,
        after: right.state,
      });
    }
    // Commits on the attached branch are reported as `task_branch_moved` from the refs.
    if (
      left.headBranch !== right.headBranch ||
      (left.headBranch === null && left.headCommit !== right.headCommit)
    ) {
      emit({
        code: 'task_head_changed',
        disposition: 'violation',
        section: 'taskWorktree',
        subject: left.path,
        change: 'modified',
        before: left.headBranch ?? `detached at ${left.headCommit ?? 'unknown'}`,
        after: right.headBranch ?? `detached at ${right.headCommit ?? 'unknown'}`,
      });
    }
  }

  const refs = both('refs');
  if (refs !== null) {
    const taskRef = `refs/heads/${before.target.branch}`;
    diffByKey(
      refs[0],
      refs[1],
      (ref) => ref.name,
      (l, r) => l.target === r.target && l.symref === r.symref,
      (subject, l, r) => {
        const change = changeOf(l, r);
        const code: GitIntegrityFindingCode =
          subject === taskRef
            ? 'task_branch_moved'
            : change === 'added'
              ? 'ref_created'
              : change === 'removed'
                ? 'ref_deleted'
                : 'ref_moved';
        emit({
          code,
          disposition: 'violation',
          section: 'refs',
          subject,
          change,
          before: l === undefined ? null : (l.symref ?? l.target),
          after: r === undefined ? null : (r.symref ?? r.target),
          refCategory: refCategory(subject),
        });
      },
    );
  }

  const worktrees = both('worktrees');
  if (worktrees !== null) {
    diffByKey(
      worktrees[0],
      worktrees[1],
      (entry) => entry.path,
      (l, r) => equalJson(l, r),
      (subject, l, r) => {
        if (l === undefined || r === undefined) {
          emit({
            code: l === undefined ? 'worktree_added' : 'worktree_removed',
            disposition: 'violation',
            section: 'worktrees',
            subject,
            change: changeOf(l, r),
            before: l?.branch ?? l?.head ?? null,
            after: r?.branch ?? r?.head ?? null,
          });
          return;
        }
        const headChanged = l.head !== r.head || l.branch !== r.branch || l.detached !== r.detached;
        const registryChanged =
          l.role !== r.role ||
          l.bare !== r.bare ||
          l.locked !== r.locked ||
          l.lockReasonDigest !== r.lockReasonDigest ||
          l.prunable !== r.prunable;
        // The task worktree's HEAD is covered by `taskWorktree` and the task branch ref.
        if (headChanged && l.role !== 'task' && r.role !== 'task') {
          emit({
            code: l.role === 'main' ? 'main_checkout_head_changed' : 'other_worktree_head_changed',
            disposition: 'violation',
            section: 'worktrees',
            subject,
            change: 'modified',
            before: `${l.branch ?? 'detached'} ${l.head ?? 'unborn'}`,
            after: `${r.branch ?? 'detached'} ${r.head ?? 'unborn'}`,
          });
        }
        if (registryChanged) {
          emit({
            code: 'worktree_registry_changed',
            disposition: 'violation',
            section: 'worktrees',
            subject,
            change: 'modified',
            before: registryText(l),
            after: registryText(r),
          });
        }
      },
    );
  }

  const config = both('config');
  const configFilesWithFindings = new Set<ConfigFile>();
  if (config !== null) {
    diffByKey(
      config[0],
      config[1],
      (entry: ConfigEntry) => `${entry.file}:${entry.key}`,
      (l, r) => l.count === r.count && l.valuesDigest === r.valuesDigest,
      (subject, l, r) => {
        const entry = l ?? r;
        if (entry === undefined) return;
        configFilesWithFindings.add(entry.file);
        emit({
          code: configCode(entry.key),
          disposition: 'violation',
          section: 'config',
          subject,
          change: changeOf(l, r),
          before: l === undefined ? null : `${l.count} value(s)`,
          after: r === undefined ? null : `${r.count} value(s)`,
        });
      },
    );
  }

  const metadata = both('metadataFiles');
  if (metadata !== null) {
    diffByKey(
      metadata[0],
      metadata[1],
      (entry) => `${entry.location}:${entry.name}`,
      (l, r) => equalJson(l, r),
      (subject, l, r) => {
        const entry = l ?? r;
        if (entry === undefined) return;
        // A config file whose keys changed is already reported key by key.
        const file = configFileOfMetadata(entry);
        if (file !== null && configFilesWithFindings.has(file)) return;
        emit({
          code: 'metadata_file_changed',
          disposition: 'violation',
          section: 'metadataFiles',
          subject,
          change: changeOf(l, r),
          before: l?.kind ?? null,
          after: r?.kind ?? null,
        });
      },
    );
  }

  const hooks = both('hooks');
  if (hooks !== null) {
    const [left, right] = hooks;
    if (left.directory !== right.directory || left.directoryDigest !== right.directoryDigest) {
      emit({
        code: 'hooks_changed',
        disposition: 'violation',
        section: 'hooks',
        subject: 'hooks',
        change: 'modified',
        before: left.directory,
        after: right.directory,
      });
    }
    diffByKey(
      left.entries,
      right.entries,
      (entry) => `hooks/${entry.name}`,
      (l, r) => equalJson(l, r),
      (subject, l, r) =>
        emit({
          code: 'hooks_changed',
          disposition: 'violation',
          section: 'hooks',
          subject,
          change: changeOf(l, r),
          before: l?.kind ?? null,
          after: r?.kind ?? null,
        }),
    );
  }

  const status = both('mainCheckoutStatus');
  if (status !== null && !equalJson(status[0], status[1])) {
    emit({
      code: 'main_checkout_status_changed',
      disposition: 'violation',
      section: 'mainCheckoutStatus',
      subject: status[0].path,
      change: 'modified',
      before: `${status[0].entries} changed path(s)`,
      after: `${status[1].entries} changed path(s)`,
    });
  }
};

type ObservedValue<K extends GitIntegritySection> =
  GitIntegritySnapshot[K] extends Observation<infer T> ? T : never;

const identityText = (identity: { dev: string; ino: string }): string =>
  `${identity.dev}:${identity.ino}`;

const registryText = (entry: WorktreeRecord): string =>
  [
    entry.role,
    entry.locked ? 'locked' : 'unlocked',
    entry.prunable ? 'prunable' : null,
    entry.bare ? 'bare' : null,
  ]
    .filter((part) => part !== null)
    .join(' ');

const dispositionOrder = (finding: GitIntegrityFinding): number =>
  finding.disposition === 'violation' ? 0 : 1;

const finish = (
  findings: GitIntegrityFinding[],
  beforeDigest: string | null,
  afterDigest: string | null,
): GitIntegrityComparison => {
  const sorted = [...findings].sort(
    (left, right) =>
      dispositionOrder(left) - dispositionOrder(right) ||
      sameSubjectOrder(left.code, right.code) ||
      sameSubjectOrder(left.subject, right.subject),
  );
  const hasViolation = sorted.some((finding) => finding.disposition === 'violation');
  const status: GitIntegrityStatus = hasViolation
    ? 'violation'
    : sorted.length > 0
      ? 'inconclusive'
      : 'clean';
  return {
    status,
    publication:
      status === 'clean'
        ? { decision: 'proceed_to_review' }
        : {
            decision: 'blocked',
            reason: status === 'violation' ? 'integrity_violation' : 'inspection_inconclusive',
          },
    findings: sorted.slice(0, maxReportedFindings),
    totalFindings: sorted.length,
    findingsTruncated: sorted.length > maxReportedFindings,
    beforeDigest,
    afterDigest,
    coverage: 'observable_before_after_state',
  };
};

const snapshotFinding = (
  code: 'snapshot_invalid' | 'snapshot_mismatch',
  subject: string,
): GitIntegrityFinding => ({
  code,
  disposition: 'inconclusive',
  section: 'snapshot',
  subject,
  change: null,
  before: null,
  after: null,
  refCategory: null,
});

/**
 * Compares a pre-run baseline with a post-run snapshot of the same target. Pure and deterministic:
 * the result depends only on the observed state, not on array order or `capturedAt`.
 *
 * Both inputs are validated against the snapshot schema first (they may have been persisted). Any
 * failed section, invalid or mismatched snapshot, or unverified baseline makes the result at least
 * `inconclusive`; any observable change outside normal task-worktree file edits makes it
 * `violation`. Working-tree content of the task worktree (tracked, untracked, staged files) is not
 * part of the snapshot and never produces a finding.
 */
export const compareGitIntegritySnapshots = (
  before: GitIntegritySnapshot,
  after: GitIntegritySnapshot,
): GitIntegrityComparison => {
  const parsedBefore = gitIntegritySnapshotSchema.safeParse(before);
  const parsedAfter = gitIntegritySnapshotSchema.safeParse(after);
  if (!parsedBefore.success || !parsedAfter.success) {
    return finish(
      [
        ...(parsedBefore.success ? [] : [snapshotFinding('snapshot_invalid', 'before')]),
        ...(parsedAfter.success ? [] : [snapshotFinding('snapshot_invalid', 'after')]),
      ],
      parsedBefore.success ? digestGitIntegritySnapshot(parsedBefore.data) : null,
      parsedAfter.success ? digestGitIntegritySnapshot(parsedAfter.data) : null,
    );
  }
  const left = parsedBefore.data;
  const right = parsedAfter.data;
  const beforeDigest = digestGitIntegritySnapshot(left);
  const afterDigest = digestGitIntegritySnapshot(right);
  if (!equalJson(left.target, right.target)) {
    return finish([snapshotFinding('snapshot_mismatch', 'target')], beforeDigest, afterDigest);
  }
  if (Date.parse(right.capturedAt) < Date.parse(left.capturedAt)) {
    return finish([snapshotFinding('snapshot_mismatch', 'capturedAt')], beforeDigest, afterDigest);
  }

  const findings: GitIntegrityFinding[] = [];
  const emit: Emit = (finding) => findings.push({ refCategory: null, ...finding });

  for (const section of gitIntegritySections) {
    for (const [side, snapshot] of [
      ['before', left],
      ['after', right],
    ] as const) {
      const observation = snapshot[section];
      if (observation.status === 'failed') {
        emit({
          code: 'inspection_incomplete',
          disposition: 'inconclusive',
          section,
          subject: `${side}:${section}`,
          change: null,
          before: side === 'before' ? observation.failure.reason : null,
          after: side === 'after' ? observation.failure.reason : null,
        });
      }
    }
  }

  // A baseline can only vouch for a verified task worktree whose base commit exists.
  if (left.taskWorktree.status === 'observed') {
    const baseline = left.taskWorktree.value;
    if (baseline.state !== 'ready' || baseline.gitDir === null || !baseline.baseCommitPresent) {
      emit({
        code: 'baseline_not_verified',
        disposition: 'inconclusive',
        section: 'taskWorktree',
        subject: baseline.path,
        change: null,
        before: baseline.baseCommitPresent ? baseline.state : 'base commit missing',
        after: null,
      });
    }
  }

  compareObserved(left, right, emit);
  return finish(findings, beforeDigest, afterDigest);
};

export type VerifyGitIntegrityResult = {
  /** The post-run snapshot, or `null` when the baseline was invalid and nothing was captured. */
  after: GitIntegritySnapshot | null;
  comparison: GitIntegrityComparison;
};

/**
 * Captures the post-run snapshot for the baseline's target (with the baseline's limits and
 * repository identity, so a replaced repository is not inspected) and compares it.
 */
export const verifyGitIntegrity = async (
  baseline: GitIntegritySnapshot,
  options: GitCommandOptions = {},
): Promise<VerifyGitIntegrityResult> => {
  const parsed = gitIntegritySnapshotSchema.safeParse(baseline);
  if (!parsed.success) {
    return {
      after: null,
      comparison: finish([snapshotFinding('snapshot_invalid', 'before')], null, null),
    };
  }
  const { target, limits, repository } = parsed.data;
  const after = await captureGitIntegritySnapshot({
    ...options,
    repositoryPath: target.repositoryPath,
    worktreePath: target.worktreePath,
    branchName: target.branch,
    baseCommit: target.baseCommit,
    limits,
    ...(repository.status === 'observed'
      ? {
          expectedRepository: {
            root: repository.value.root,
            commonDir: repository.value.commonDir,
            rootIdentity: repository.value.rootIdentity,
            commonDirIdentity: repository.value.commonDirIdentity,
          },
        }
      : {}),
  });
  return { after, comparison: compareGitIntegritySnapshots(parsed.data, after) };
};
