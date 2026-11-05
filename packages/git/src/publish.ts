import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  inspectTaskChanges,
  readTaskChangesRevision,
  type ChangedFile,
  type FileChangeType,
  type TaskChanges,
  type TaskChangesOptions,
} from './changes.js';
import { GitCommandError } from './errors.js';
import { runGit, runGitChecked, type RunGitOptions } from './process.js';
import { redactRemoteUrl } from './refs.js';
import { parseBranchName, type GitCommandOptions } from './schemas.js';
import { inspectTaskWorktree, type TaskWorktreeTarget } from './task-worktree.js';
import { readWorktreeEntry } from './worktree-files.js';

// Approve & Push (M6-03): the review snapshot that an approval is bound to, and the only Git
// mutations of the publish flow. Every function here is called by the trusted publish component
// (snapshot capture also by the web process when an approval is recorded); none is reachable from
// agent execution.
//
// Publication model (`SPEC.md` §10, `ARCHITECTURE.md` §9):
// - The snapshot lists every change between the recorded base commit and the working tree, with a
//   SHA-256 of each file's exact bytes. Its canonical JSON is hashed into `snapshotHash`.
// - Committing re-captures the snapshot and requires the same hash, stages exactly its entries into
//   a private temporary index (never `git add -A`, never the worktree's index), verifies the
//   resulting tree against the snapshot, writes a commit with the base commit as its only parent
//   and moves the task branch with a compare-and-swap from the base commit. No hook runs, no file
//   in the worktree is written, and no other ref is touched.
// - Pushing sends that commit to `refs/heads/<task branch>` on the configured remote, without force.
//   A non-fast-forward update is rejected by Git; an identical remote ref is reported up to date,
//   so a retried push never duplicates the commit.

export const reviewSnapshotVersion = 1;

/** Largest single file staged by Approve & Push. */
export const defaultMaxPublishFileBytes = 64 * 1024 * 1024;
/** Largest total content staged by one Approve & Push. */
export const defaultMaxPublishTotalBytes = 512 * 1024 * 1024;

const commitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const pathSchema = z.string().min(1).max(4096);

const publishFileModes = ['100644', '100755', '120000'] as const;

export type PublishFileMode = (typeof publishFileModes)[number];

export const reviewSnapshotEntrySchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('write'),
    path: pathSchema,
    mode: z.enum(publishFileModes),
    size: z.number().int().nonnegative(),
    sha256: sha256Schema,
  }),
  z.strictObject({ action: z.literal('delete'), path: pathSchema }),
]);

export type ReviewSnapshotEntry = z.infer<typeof reviewSnapshotEntrySchema>;

const fileChangeTypes = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type_changed',
  'conflicted',
] as const satisfies readonly FileChangeType[];

export const reviewSnapshotFileSchema = z.strictObject({
  path: pathSchema,
  previousPath: pathSchema.nullable(),
  change: z.enum(fileChangeTypes),
  tracked: z.boolean(),
});

export type ReviewSnapshotFile = z.infer<typeof reviewSnapshotFileSchema>;

/**
 * The immutable description of an approved change set. `files` is the reviewed inventory as shown;
 * `entries` is what will be staged: one write (exact bytes and mode) or delete per path.
 */
export const reviewSnapshotSchema = z.strictObject({
  version: z.literal(reviewSnapshotVersion),
  repositoryRoot: z.string().min(1),
  commonDir: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  baseCommit: commitShaSchema,
  headCommit: commitShaSchema,
  files: z.array(reviewSnapshotFileSchema),
  entries: z.array(reviewSnapshotEntrySchema),
});

export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;

/** Why a change set cannot be approved as it is. */
export const publicationBlockerCodes = [
  /** The worktree has no changes relative to the base commit. */
  'no_changes',
  /** The inventory hit its file limit, so not every change was shown. */
  'files_truncated',
  /** The worktree changed while it was inspected or hashed. */
  'changed_during_inspection',
  /** The task branch has commits after the base commit (or was moved); the review covers files only. */
  'unexpected_commits',
  /** A conflicted path. */
  'conflicted_file',
  /** A submodule, nested repository, directory, FIFO, device or a path through a symlinked directory. */
  'unsupported_file',
  /** A file is larger than the per-file publish limit. */
  'file_too_large',
  /** The change set is larger than the total publish limit. */
  'snapshot_too_large',
] as const;

export type PublicationBlockerCode = (typeof publicationBlockerCodes)[number];

export type PublicationBlocker = { code: PublicationBlockerCode; path?: string };

export type ReviewSnapshotLimits = {
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

export type CaptureReviewSnapshotOptions = TaskChangesOptions & {
  publishLimits?: ReviewSnapshotLimits;
};

export type ReviewSnapshotCapture =
  | {
      status: 'ready';
      snapshot: ReviewSnapshot;
      snapshotHash: string;
      /** The change-inventory revision before and after hashing (equal). */
      revision: string;
      changes: TaskChanges;
    }
  | {
      status: 'blocked';
      blockers: PublicationBlocker[];
      revision: string;
      changes: TaskChanges;
    };

/** Expected publish failures. Messages never contain file content or credentials. */
export const publishErrorCodes = [
  'snapshot_blocked',
  /** The worktree no longer matches the approved snapshot. */
  'snapshot_changed',
  /** The worktree is not a verified task worktree on the expected branch. */
  'worktree_not_verified',
  /** The task branch is not where the operation expects it (moved, committed to, or reset). */
  'branch_moved',
  /** The staged tree does not equal the snapshot. Nothing was committed. */
  'staged_tree_mismatch',
  /** `git diff --check` reported whitespace errors or conflict markers. Nothing was committed. */
  'diff_check_failed',
  /** Git has no author/committer identity configured. Nothing was committed. */
  'git_identity_missing',
  'commit_failed',
  'remote_not_found',
  /** The remote's URL or push URL changed since the approval. */
  'remote_changed',
  /** The remote is configured as a mirror; an explicit single-branch push is not possible. */
  'remote_unsupported',
  /** The remote has a different commit on the task branch that is not an ancestor. */
  'push_rejected_non_fast_forward',
  'push_rejected',
  'push_authentication_failed',
  'push_remote_unavailable',
  'push_timeout',
  'push_failed',
] as const;

export type PublishErrorCode = (typeof publishErrorCodes)[number];

export class PublishError extends Error {
  override name = 'PublishError';

  constructor(
    readonly code: PublishErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

const unsupportedKinds = new Set(['submodule', 'directory', 'other']);

const sha256 = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');

/** SHA-256 of the snapshot's canonical JSON (fixed key order, entries sorted by path). */
export const hashReviewSnapshot = (snapshot: ReviewSnapshot): string =>
  sha256(Buffer.from(JSON.stringify(reviewSnapshotSchema.parse(snapshot)), 'utf8'));

const comparePaths = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const fileBlockers = (file: ChangedFile): PublicationBlocker[] => {
  if (file.change === 'conflicted') return [{ code: 'conflicted_file', path: file.path }];
  if (
    unsupportedKinds.has(file.kind) ||
    (file.previousKind !== null && unsupportedKinds.has(file.previousKind)) ||
    file.diffOmitted === 'outside_worktree' ||
    file.diffOmitted === 'unsupported_file_type'
  ) {
    return [{ code: 'unsupported_file', path: file.path }];
  }
  return [];
};

type ReadContent = { mode: PublishFileMode; content: Buffer } | PublicationBlocker | null;

/** Reads the exact bytes Git would store for a worktree entry; never follows symlinks. */
const readPublishContent = async (
  root: string,
  path: string,
  maxFileBytes: number,
): Promise<ReadContent> => {
  const entry = await readWorktreeEntry(root, path, maxFileBytes);
  switch (entry.kind) {
    case 'missing':
      return null;
    case 'symlink':
      return { mode: '120000', content: Buffer.from(entry.target, 'utf8') };
    case 'file':
      if (entry.content === null) return { code: 'file_too_large', path };
      return { mode: entry.executable ? '100755' : '100644', content: entry.content };
    default:
      return { code: 'unsupported_file', path };
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const parseSnapshotLimits = (limits: ReviewSnapshotLimits = {}) => ({
  maxFileBytes: limits.maxFileBytes ?? defaultMaxPublishFileBytes,
  maxTotalBytes: limits.maxTotalBytes ?? defaultMaxPublishTotalBytes,
});

/**
 * Captures the review snapshot of a verified task worktree: the change inventory plus the exact
 * bytes (SHA-256) and mode of every changed path. Read-only. Returns `blocked` with reasons when
 * the change set cannot be published as reviewed (no changes, commits on the task branch,
 * conflicts, unsupported entries, limits, or changes while it was read).
 */
export const captureReviewSnapshot = async ({
  publishLimits,
  ...options
}: CaptureReviewSnapshotOptions): Promise<ReviewSnapshotCapture> => {
  const limits = parseSnapshotLimits(publishLimits);
  const changes = await inspectTaskChanges(options);
  const blockers: PublicationBlocker[] = [];
  if (changes.consistency !== 'stable') blockers.push({ code: 'changed_during_inspection' });
  if (changes.headCommit !== changes.baseCommit) blockers.push({ code: 'unexpected_commits' });
  if (changes.filesTruncated) blockers.push({ code: 'files_truncated' });
  if (changes.totalFiles === 0) blockers.push({ code: 'no_changes' });
  for (const file of changes.files) blockers.push(...fileBlockers(file));
  if (blockers.length > 0) {
    return { status: 'blocked', blockers, revision: changes.revision, changes };
  }

  const root = changes.worktreePath;
  const entries = new Map<string, ReviewSnapshotEntry>();
  let total = 0;
  for (const file of changes.files) {
    if (
      file.previousPath !== null &&
      file.change === 'renamed' &&
      !(await pathExists(join(root, file.previousPath)))
    ) {
      entries.set(file.previousPath, { action: 'delete', path: file.previousPath });
    }
    const read = await readPublishContent(root, file.path, limits.maxFileBytes);
    if (read === null) {
      entries.set(file.path, { action: 'delete', path: file.path });
      continue;
    }
    if ('code' in read) {
      blockers.push(read);
      continue;
    }
    total += read.content.length;
    entries.set(file.path, {
      action: 'write',
      path: file.path,
      mode: read.mode,
      size: read.content.length,
      sha256: sha256(read.content),
    });
  }
  if (total > limits.maxTotalBytes) blockers.push({ code: 'snapshot_too_large' });
  const after = await readTaskChangesRevision(options);
  if (after !== changes.revision) blockers.push({ code: 'changed_during_inspection' });
  if (blockers.length > 0) {
    return { status: 'blocked', blockers, revision: after, changes };
  }

  const snapshot: ReviewSnapshot = {
    version: reviewSnapshotVersion,
    repositoryRoot: changes.repository.root,
    commonDir: changes.repository.commonDir,
    worktreePath: root,
    branch: changes.branch,
    baseCommit: changes.baseCommit,
    headCommit: changes.headCommit,
    files: changes.files
      .map((file) => ({
        path: file.path,
        previousPath: file.previousPath,
        change: file.change,
        tracked: file.tracked,
      }))
      .sort(comparePaths),
    entries: [...entries.values()].sort(comparePaths),
  };
  return {
    status: 'ready',
    snapshot,
    snapshotHash: hashReviewSnapshot(snapshot),
    revision: changes.revision,
    changes,
  };
};

// ---------------------------------------------------------------------------------------------
// Commit

export type CommitReviewSnapshotOptions = TaskWorktreeTarget & {
  baseCommit: string;
  /** The approved snapshot and its stored hash. */
  snapshot: ReviewSnapshot;
  snapshotHash: string;
  /** Full commit message, generated by the trusted publish component. */
  message: string;
  /**
   * Called after the commit object exists and before the branch moves, so the caller can persist
   * the SHA first (crash recovery can then tell whether the branch update happened).
   */
  onCommitObject?: (commit: { commitSha: string; treeSha: string }) => void | Promise<void>;
  publishLimits?: ReviewSnapshotLimits;
};

export type CommittedSnapshot = {
  commitSha: string;
  treeSha: string;
  /** Whether the worktree's index was updated to the new commit (files are never touched). */
  indexSynced: boolean;
};

/** Verifies the task worktree and returns its canonical path and branch commit. */
const verifyWorktree = async (
  target: TaskWorktreeTarget,
  options: GitCommandOptions,
): Promise<{ root: string; branchCommit: string | null; headCommit: string | null }> => {
  const inspection = await inspectTaskWorktree({ ...target, ...options });
  if (inspection.state !== 'ready' || inspection.head?.kind !== 'branch') {
    throw new PublishError(
      'worktree_not_verified',
      'The task worktree could not be verified as this task’s worktree on its branch.',
      { state: inspection.state, issues: inspection.issues },
    );
  }
  return {
    root: inspection.path,
    branchCommit: inspection.branchCommit,
    headCommit: inspection.head.commit,
  };
};

type TreeRecord = { mode: string; oid: string; status: string };

/** Parses `git diff-tree -r -z --raw --no-renames` output into path → new mode/oid/status. */
const parseRawDiff = (output: string): Map<string, TreeRecord> => {
  const records = new Map<string, TreeRecord>();
  const fields = output.split('\0');
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index] ?? '';
    const path = fields[index + 1] ?? '';
    if (!header.startsWith(':')) break;
    const [, newMode = '', , newOid = '', status = ''] = header.slice(1).split(' ');
    records.set(path, { mode: newMode, oid: newOid, status });
  }
  return records;
};

const identityMissing = (stderr: string): boolean =>
  /Author identity unknown|Committer identity unknown|Please tell me who you are|empty ident name|unable to auto-detect email address|no (?:email|name) was given/i.test(
    stderr,
  );

/**
 * Commits exactly the approved snapshot on the task branch of a verified task worktree.
 *
 * Requires the worktree to be verified, HEAD and the task branch at `baseCommit`, and a freshly
 * captured snapshot with the approved hash. Content is read again (no symlinks followed), checked
 * against the snapshot's SHA-256 and written as blobs; staging uses a private temporary index. The
 * resulting tree must differ from the base tree in exactly the snapshot's paths, with the expected
 * modes and blobs, and must pass `git diff --check`. The branch is moved with a compare-and-swap
 * from `baseCommit`, so a concurrent change of the branch fails instead of being overwritten.
 * Finally the worktree's own index is set to the new commit; working tree files are not touched.
 */
export const commitReviewSnapshot = async ({
  repositoryPath,
  worktreePath,
  branchName,
  baseCommit,
  snapshot,
  snapshotHash,
  message,
  onCommitObject,
  publishLimits,
  ...commandOptions
}: CommitReviewSnapshotOptions): Promise<CommittedSnapshot> => {
  const options: GitCommandOptions = {
    timeoutMs: commandOptions.timeoutMs ?? 60_000,
    maxOutputBytes: commandOptions.maxOutputBytes,
  };
  const branch = parseBranchName(branchName);
  if (!commitShaSchema.safeParse(baseCommit).success) {
    throw new PublishError('branch_moved', 'The base commit is not a full commit SHA.');
  }
  if (message.trim() === '' || message.includes('\0')) {
    throw new PublishError('commit_failed', 'The commit message is empty or invalid.');
  }
  const limits = parseSnapshotLimits(publishLimits);

  const target = { repositoryPath, worktreePath, branchName: branch };
  const before = await verifyWorktree(target, options);
  if (before.headCommit !== baseCommit || before.branchCommit !== baseCommit) {
    throw new PublishError(
      'branch_moved',
      'The task branch no longer points at the reviewed base commit; nothing was committed.',
    );
  }

  const capture = await captureReviewSnapshot({
    ...target,
    baseCommit,
    publishLimits,
    ...options,
  });
  if (capture.status === 'blocked') {
    throw new PublishError(
      'snapshot_blocked',
      'The worktree can no longer be published as reviewed; nothing was committed.',
      { blockers: capture.blockers.slice(0, 20) },
    );
  }
  if (capture.snapshotHash !== snapshotHash || hashReviewSnapshot(snapshot) !== snapshotHash) {
    throw new PublishError(
      'snapshot_changed',
      'The worktree changed after the approval; nothing was committed. Review the changes again.',
    );
  }

  const root = before.root;
  const git = (args: readonly string[], extra: Partial<RunGitOptions> = {}) =>
    runGit(args, { ...options, cwd: root, ...extra });
  const gitChecked = (args: readonly string[], extra: Partial<RunGitOptions> = {}) =>
    runGitChecked(args, { ...options, cwd: root, ...extra });

  const temporary = await mkdtemp(join(tmpdir(), 'ai-agent-manager-publish-'));
  const indexFile = join(temporary, 'index');
  let commitSha: string;
  let treeSha: string;
  try {
    await gitChecked(['read-tree', baseCommit], { indexFile });
    const zeroOid = '0'.repeat(baseCommit.length);
    const records: string[] = [];
    const blobs = new Map<string, string>();
    for (const entry of snapshot.entries) {
      if (entry.action === 'delete') {
        if (await pathExists(join(root, entry.path))) {
          throw new PublishError('snapshot_changed', 'A deleted path exists again.', {
            path: entry.path,
          });
        }
        records.push(`0 ${zeroOid}\t${entry.path}\0`);
        continue;
      }
      const read = await readPublishContent(root, entry.path, limits.maxFileBytes);
      if (
        read === null ||
        'code' in read ||
        read.mode !== entry.mode ||
        read.content.length !== entry.size ||
        sha256(read.content) !== entry.sha256
      ) {
        throw new PublishError(
          'snapshot_changed',
          'A file changed after the approval; nothing was committed.',
          { path: entry.path },
        );
      }
      const oid = (
        await gitChecked(['hash-object', '-w', '--no-filters', '--stdin'], {
          input: read.content,
        })
      ).trim();
      blobs.set(entry.path, oid);
      records.push(`${entry.mode} ${oid}\t${entry.path}\0`);
    }
    await gitChecked(['update-index', '-z', '--index-info'], {
      indexFile,
      input: Buffer.from(records.join(''), 'utf8'),
    });
    treeSha = (await gitChecked(['write-tree'], { indexFile })).trim();

    // The new tree must differ from the base tree in exactly the snapshot's paths.
    const diff = parseRawDiff(
      await gitChecked([
        'diff-tree',
        '-r',
        '-z',
        '--raw',
        '--no-abbrev',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        baseCommit,
        treeSha,
      ]),
    );
    const expected = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
    const mismatched = [...new Set([...diff.keys(), ...expected.keys()])].filter((path) => {
      const record = diff.get(path);
      const entry = expected.get(path);
      if (record === undefined || entry === undefined) return true;
      if (entry.action === 'delete') return record.status !== 'D';
      return record.status === 'D' || record.mode !== entry.mode || record.oid !== blobs.get(path);
    });
    if (mismatched.length > 0) {
      throw new PublishError(
        'staged_tree_mismatch',
        'The staged tree does not match the approved snapshot; nothing was committed.',
        { paths: mismatched.slice(0, 20) },
      );
    }

    const check = await git([
      'diff-tree',
      '--check',
      '-r',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      baseCommit,
      treeSha,
    ]);
    if (check.exitCode !== 0) {
      throw new PublishError(
        'diff_check_failed',
        '`git diff --check` reported whitespace errors or conflict markers in the approved changes; nothing was committed.',
        { report: check.stdout.slice(0, 2_000) },
      );
    }

    // The operator's configured identity is used as is; Git must not guess one from the host.
    const committed = await git(['commit-tree', treeSha, '-p', baseCommit, '-F', '-'], {
      input: Buffer.from(message.endsWith('\n') ? message : `${message}\n`, 'utf8'),
      config: [['user.useConfigOnly', 'true']],
    });
    if (committed.exitCode !== 0) {
      throw identityMissing(committed.stderr)
        ? new PublishError(
            'git_identity_missing',
            'Git has no author identity (user.name and user.email) for this repository; nothing was committed. Configure it with git config and retry.',
          )
        : new PublishError('commit_failed', 'Git could not create the commit.', {
            stderr: committed.stderr.slice(0, 500),
          });
    }
    commitSha = committed.stdout.trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  await onCommitObject?.({ commitSha, treeSha });

  // Compare-and-swap: only moves the branch if it still points at the base commit.
  const moved = await git([
    'update-ref',
    '-m',
    'AI Agent Manager: Approve & Push',
    `refs/heads/${branch}`,
    commitSha,
    baseCommit,
  ]);
  if (moved.exitCode !== 0) {
    throw new PublishError(
      'branch_moved',
      'The task branch moved while the commit was created; it was not updated.',
    );
  }

  // The worktree's index still describes the base commit; point it at the new commit without
  // touching working tree files. A failure leaves the commit in place and is reported.
  const synced = await git(['read-tree', commitSha]).catch(() => null);
  return { commitSha, treeSha, indexSynced: synced?.exitCode === 0 };
};

// ---------------------------------------------------------------------------------------------
// Remote and push

export type PublishRemote = {
  name: string;
  /** The URL Git pushes to (push URL when configured), with HTTP(S) credentials redacted. */
  displayUrl: string;
  /** SHA-256 over the configured URLs and push URLs; changes when either is edited. */
  urlDigest: string;
  mirror: boolean;
};

const remoteNamePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

const readValues = async (cwd: string, key: string, options: GitCommandOptions) => {
  const result = await runGit(['config', '--get-all', key], { ...options, cwd });
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) {
    throw new GitCommandError(`git config failed: ${result.stderr.trim()}`, {
      code: 'GIT_FAILED',
      args: ['config'],
      exitCode: result.exitCode,
      signal: null,
      stderr: result.stderr,
    });
  }
  return result.stdout.split('\n').filter((line) => line !== '');
};

/**
 * Reads a configured remote for publishing, or `null` when it does not exist. URLs are data: they
 * are never executed, and only the redacted display form and a digest leave this function.
 */
export const readPublishRemote = async (
  root: string,
  name: string,
  options: GitCommandOptions = {},
): Promise<PublishRemote | null> => {
  if (!remoteNamePattern.test(name) || name.includes('..')) return null;
  const remotes = (await runGitChecked(['remote'], { ...options, cwd: root }))
    .split('\n')
    .filter((line) => line !== '');
  if (!remotes.includes(name)) return null;
  const [urls, pushUrls, mirror] = await Promise.all([
    readValues(root, `remote.${name}.url`, options),
    readValues(root, `remote.${name}.pushurl`, options),
    readValues(root, `remote.${name}.mirror`, options),
  ]);
  const target = pushUrls[0] ?? urls[0];
  if (target === undefined) return null;
  return {
    name,
    displayUrl: redactRemoteUrl(target),
    urlDigest: sha256(Buffer.from(JSON.stringify({ name, urls, pushUrls }), 'utf8')),
    mirror: mirror.some((value) => /^(?:true|yes|on|1)$/i.test(value)),
  };
};

export type PushTaskBranchOptions = TaskWorktreeTarget & {
  /** The approved commit; the task branch must point at it. */
  commitSha: string;
  remoteName: string;
  /** `PublishRemote.urlDigest` recorded with the approval. */
  expectedRemoteDigest: string;
};

export type PushedTaskBranch = {
  remoteName: string;
  /** `refs/heads/<task branch>` on the remote. */
  remoteRef: string;
  commitSha: string;
  outcome: 'created' | 'fast_forward' | 'up_to_date';
};

const redactOutput = (text: string): string =>
  text
    .replace(/((?:https?|ftps?):\/\/)[^/\s@]*@/gi, '$1***@')
    .trim()
    .slice(0, 1_000);

const classifyPushFailure = (stderr: string): PublishErrorCode => {
  if (
    /Authentication failed|Permission denied|could not read (?:Username|Password)|terminal prompts disabled|returned error: 40[13]|access denied/i.test(
      stderr,
    )
  ) {
    return 'push_authentication_failed';
  }
  if (
    /Could not resolve host|Connection refused|Connection timed out|Operation timed out|unable to access|does not appear to be a git repository|Could not read from remote repository|No such file or directory|Network is unreachable/i.test(
      stderr,
    )
  ) {
    return 'push_remote_unavailable';
  }
  return 'push_failed';
};

const pushFailureMessages: Partial<Record<PublishErrorCode, string>> = {
  push_rejected_non_fast_forward:
    'The remote rejected the push: its task branch has commits that are not in the approved commit (non-fast-forward). Nothing was forced.',
  push_rejected: 'The remote rejected the push.',
  push_authentication_failed:
    'The push failed because Git could not authenticate with the remote. Check your Git credentials and retry the push.',
  push_remote_unavailable:
    'The push failed because the remote could not be reached. Check the remote and your network, then retry the push.',
  push_timeout: 'The push did not finish in time. Retry the push.',
  push_failed: 'The push failed.',
};

/**
 * Pushes the approved commit to `refs/heads/<task branch>` on the configured remote: no force, no
 * hooks, no tags, no other refs. The worktree must be verified with the task branch at
 * `commitSha`, and the remote's URLs must be unchanged since the approval. A non-fast-forward
 * update is rejected; an identical remote ref is `up_to_date`, so retrying never creates a second
 * commit. Success is taken only from Git's per-ref porcelain status for this exact ref.
 */
export const pushTaskBranch = async ({
  repositoryPath,
  worktreePath,
  branchName,
  commitSha,
  remoteName,
  expectedRemoteDigest,
  ...commandOptions
}: PushTaskBranchOptions): Promise<PushedTaskBranch> => {
  const options: GitCommandOptions = {
    timeoutMs: commandOptions.timeoutMs ?? 120_000,
    maxOutputBytes: commandOptions.maxOutputBytes ?? 1024 * 1024,
  };
  const branch = parseBranchName(branchName);
  if (!commitShaSchema.safeParse(commitSha).success) {
    throw new PublishError('branch_moved', 'The commit to push is not a full commit SHA.');
  }
  const { root, branchCommit } = await verifyWorktree(
    { repositoryPath, worktreePath, branchName: branch },
    options,
  );
  if (branchCommit !== commitSha) {
    throw new PublishError(
      'branch_moved',
      'The task branch no longer points at the approved commit; nothing was pushed.',
    );
  }
  const remote = await readPublishRemote(root, remoteName, options);
  if (remote === null) {
    throw new PublishError('remote_not_found', `The remote "${remoteName}" is not configured.`);
  }
  if (remote.urlDigest !== expectedRemoteDigest) {
    throw new PublishError(
      'remote_changed',
      `The URL of the remote "${remoteName}" changed after the approval; nothing was pushed.`,
    );
  }
  if (remote.mirror) {
    throw new PublishError(
      'remote_unsupported',
      `The remote "${remoteName}" is configured as a mirror; nothing was pushed.`,
    );
  }

  const remoteRef = `refs/heads/${branch}`;
  let result;
  try {
    result = await runGit(
      [
        'push',
        '--porcelain',
        '--no-verify',
        '--no-follow-tags',
        '--no-recurse-submodules',
        remote.name,
        `${commitSha}:${remoteRef}`,
      ],
      { ...options, cwd: root, config: [['push.gpgSign', 'false']] },
    );
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 'GIT_TIMEOUT') {
      throw new PublishError('push_timeout', pushFailureMessages.push_timeout ?? 'Timed out.');
    }
    throw error;
  }

  const line = result.stdout
    .split('\n')
    .find((candidate) => candidate.split('\t')[1]?.endsWith(`:${remoteRef}`) === true);
  const flag = line?.[0];
  const summary = line?.split('\t')[2] ?? '';
  if (result.exitCode === 0 && (flag === '*' || flag === ' ' || flag === '=')) {
    return {
      remoteName: remote.name,
      remoteRef,
      commitSha,
      outcome: flag === '*' ? 'created' : flag === '=' ? 'up_to_date' : 'fast_forward',
    };
  }
  const code: PublishErrorCode =
    flag === '!'
      ? /non-fast-forward|fetch first|stale info/i.test(summary)
        ? 'push_rejected_non_fast_forward'
        : 'push_rejected'
      : classifyPushFailure(result.stderr);
  throw new PublishError(code, pushFailureMessages[code] ?? 'The push failed.', {
    summary: redactOutput(summary),
    stderr: redactOutput(result.stderr),
  });
};

/**
 * Where the task branch points now, for crash recovery of an interrupted publish. Read-only;
 * `null` when the branch does not exist.
 */
export const readTaskBranchCommit = async (
  target: TaskWorktreeTarget,
  options: GitCommandOptions = {},
): Promise<string | null> => {
  const inspection = await inspectTaskWorktree({ ...target, ...options });
  return inspection.branchCommit;
};
