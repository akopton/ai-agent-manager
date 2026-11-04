import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import { GitCommandError, GitInputError, TaskWorktreeError } from './errors.js';
import { readFilterOverrides, runGit, runGitChecked, type RunGitOptions } from './process.js';
import { parseCommandOptions, type GitCommandOptions } from './schemas.js';
import {
  listIgnoredPaths,
  parseStatusOutput,
  readStatusOutput,
  type WorkingTreeStatus,
} from './status.js';
import {
  inspectTaskWorktree,
  type RepositoryIdentity,
  type TaskWorktreeTarget,
} from './task-worktree.js';
import {
  countLines,
  decodeUtf8,
  formatNewFilePatch,
  isWithin,
  looksBinary,
  parseWorktreePath,
  readWorktreeEntry,
} from './worktree-files.js';

export type FileChangeType =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed' | 'conflicted';

export type FileKind = 'file' | 'executable' | 'symlink' | 'submodule' | 'directory' | 'other';

/** Why a file's diff is not (or could not be) shown. */
export type DiffOmissionReason =
  /** Larger than `maxFileBytes`; content was not read or diffed. */
  | 'too_large'
  | 'binary'
  /** Submodules, nested repositories, FIFOs, devices, and similar entries. */
  | 'unsupported_file_type'
  /** Content is not valid UTF-8; it is not shown rather than shown with replacement characters. */
  | 'unsupported_encoding'
  /** The patch exceeded `maxDiffBytes`; a truncated patch is never returned. */
  | 'diff_too_large'
  /** The inventory's overall read budget was used up; open the file diff individually. */
  | 'read_budget_exhausted'
  /** The path resolved outside the worktree or through a symlinked directory. */
  | 'outside_worktree';

export type ChangedFile = {
  /** Path relative to the worktree root (the old path for deletions). */
  path: string;
  /** Source path of a rename or copy. */
  previousPath: string | null;
  change: FileChangeType;
  /** `false` for untracked files, which are not known to Git yet. */
  tracked: boolean;
  /** The index differs from HEAD for this path. */
  staged: boolean;
  /** The working tree differs from the index for this path. */
  unstaged: boolean;
  /** Commits on the task branch after the base commit changed this path. */
  committed: boolean;
  /** Whether something exists at `path` in the working tree now. */
  existsInWorktree: boolean;
  kind: FileKind;
  previousKind: FileKind | null;
  /** `null` when unknown, for example for files over the size limit. */
  binary: boolean | null;
  /** Current size in bytes for regular files; `null` otherwise. */
  size: number | null;
  additions: number | null;
  deletions: number | null;
  /** Rename/copy similarity percentage. */
  similarity: number | null;
  /** Current symlink target (never followed). */
  symlinkTarget: string | null;
  /** Whether the symlink target lexically points outside the worktree. */
  symlinkEscapesWorktree: boolean | null;
  /** Set when the diff will not be shown; see `DiffOmissionReason`. */
  diffOmitted: DiffOmissionReason | null;
};

export type ChangeInspectionLimits = {
  /** Maximum files returned by `inspectTaskChanges`. Default 2000. */
  maxFiles?: number;
  /** Files larger than this are neither read nor diffed. Default 1 MiB. */
  maxFileBytes?: number;
  /** Maximum size of one file's patch. Default 1 MiB. */
  maxDiffBytes?: number;
  /** Untracked content read while building one inventory. Default 32 MiB. */
  maxTotalReadBytes?: number;
};

export type TaskChangesOptions = TaskWorktreeTarget & {
  /** Full commit SHA recorded when the task worktree was created. */
  baseCommit: string;
  limits?: ChangeInspectionLimits;
};

/**
 * - `stable`: the revision did not change between the start and the end of the inspection.
 * - `changed_during_inspection`: the worktree changed while it was inspected; inspect again.
 */
export type ReviewConsistency = 'stable' | 'changed_during_inspection';

export type TaskChanges = {
  repository: RepositoryIdentity;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  /** Whether the base commit is an ancestor of HEAD (false after a rebase or reset). */
  baseIsAncestor: boolean;
  files: ChangedFile[];
  /** Number of changed files before applying `maxFiles`. */
  totalFiles: number;
  filesTruncated: boolean;
  /** Sums over the returned files whose counts are known. */
  totals: { additions: number; deletions: number };
  /** Git-ignored paths (directories collapsed). Paths only: content is never read. */
  ignoredPaths: string[];
  ignoredPathsTruncated: boolean;
  /**
   * Change-detection token over HEAD, index metadata, status output, and the metadata of every
   * changed path. Equal revisions mean no change was detected; compare before approving.
   */
  revision: string;
  consistency: ReviewConsistency;
};

export type TaskFileDiffOptions = TaskChangesOptions & {
  /** Current path (or, for a rename, either path) of a file listed by `inspectTaskChanges`. */
  path: string;
};

export type TaskFileDiff = {
  file: ChangedFile;
  /** Complete unified diff, or `null` when omitted. Never truncated. */
  patch: string | null;
  omitted: DiffOmissionReason | null;
  revision: string;
  consistency: ReviewConsistency;
};

const limitsSchema = z.object({
  maxFiles: z.number().int().positive().default(2000),
  maxFileBytes: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  maxDiffBytes: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  maxTotalReadBytes: z
    .number()
    .int()
    .nonnegative()
    .default(32 * 1024 * 1024),
});

type Limits = z.output<typeof limitsSchema>;

const commitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const zeroSha = /^0+$/;

/**
 * Options shared by every diff invocation. Repository config cannot change the output format or
 * make Git run programs: external diff drivers and textconv are disabled, colors, prefixes,
 * context, relative paths, and rename detection are explicit, and pathspecs are literal.
 */
const diffArguments = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-relative',
  '--find-renames',
  '--ignore-submodules=dirty',
];

type Context = {
  repository: RepositoryIdentity;
  root: string;
  branch: string;
  headCommit: string;
  baseCommit: string;
  limits: Limits;
  options: GitCommandOptions;
  diffOptions: RunGitOptions;
};

const parseLimits = (limits: ChangeInspectionLimits = {}): Limits => {
  const parsed = limitsSchema.safeParse(limits);
  if (!parsed.success) {
    throw new GitInputError(
      `Invalid change inspection limits: ${parsed.error.issues[0]?.message}.`,
    );
  }
  return parsed.data;
};

const kindFromMode = (mode: string): FileKind | null => {
  if (mode === '100644') return 'file';
  if (mode === '100755') return 'executable';
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'submodule';
  if (mode === '040000') return 'directory';
  if (zeroSha.test(mode)) return null;
  return 'other';
};

const changeFromStatus = (status: string): FileChangeType => {
  switch (status[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type_changed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
};

/** Verifies the worktree with the M1-02 policy and validates the recorded base commit. */
const prepare = async ({
  repositoryPath,
  worktreePath,
  branchName,
  baseCommit,
  limits,
  ...commandOptions
}: TaskChangesOptions): Promise<Context> => {
  const options: GitCommandOptions = {
    timeoutMs: commandOptions.timeoutMs,
    maxOutputBytes: commandOptions.maxOutputBytes,
  };
  parseCommandOptions(options);
  const parsedLimits = parseLimits(limits);
  if (!commitShaSchema.safeParse(baseCommit).success) {
    throw new GitInputError('The base commit must be a full lowercase commit SHA.');
  }

  const inspection = await inspectTaskWorktree({
    ...options,
    repositoryPath,
    worktreePath,
    branchName,
  });
  if (inspection.state !== 'ready' || inspection.head?.kind !== 'branch') {
    throw new TaskWorktreeError(
      'NOT_VERIFIED',
      `The worktree could not be verified as an AI Agent Manager task worktree (${inspection.state}${
        inspection.issues.length > 0 ? `: ${inspection.issues.join(', ')}` : ''
      }).`,
      { inspection },
    );
  }
  const root = inspection.path;

  const resolved = await runGit(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseCommit}^{commit}`],
    { ...options, cwd: root },
  );
  if (resolved.exitCode !== 0 || resolved.stdout.trim() !== baseCommit) {
    throw new TaskWorktreeError(
      'BASE_COMMIT_NOT_FOUND',
      `Base commit ${baseCommit} does not exist in this repository or is not a commit.`,
    );
  }

  return {
    repository: inspection.repository,
    root,
    branch: inspection.branch,
    headCommit: inspection.head.commit,
    baseCommit,
    limits: parsedLimits,
    options,
    diffOptions: {
      ...options,
      cwd: root,
      config: [
        // Files above the per-file limit are treated as binary, so Git never diffs them.
        ['core.bigFileThreshold', String(parsedLimits.maxFileBytes)],
        ['core.quotePath', 'true'],
        ...(await readFilterOverrides(root, options)),
      ],
    },
  };
};

/**
 * Change-detection token. Combines the base and HEAD commits, the raw status output, the index
 * file's metadata, and `lstat` metadata (including ctime, which user code cannot set) of every
 * path that status lists. Committed-only changes are covered by the HEAD commit.
 */
const computeRevision = async (context: Context): Promise<string> => {
  const [head, statusOutput, indexPath] = await Promise.all([
    runGitChecked(['rev-parse', '--verify', 'HEAD'], { ...context.options, cwd: context.root }),
    readStatusOutput(context.root, context.options),
    runGitChecked(['rev-parse', '--path-format=absolute', '--git-path', 'index'], {
      ...context.options,
      cwd: context.root,
    }),
  ]);
  const status = parseStatusOutput(statusOutput);
  const paths = [
    ...new Set([...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted]),
  ].sort();
  const describe = async (path: string): Promise<string> => {
    try {
      const stats = await lstat(path, { bigint: true });
      return [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
    } catch {
      return 'missing';
    }
  };
  const metadata = await Promise.all(paths.map((path) => describe(join(context.root, path))));
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify([
      context.baseCommit,
      head.trim(),
      statusOutput,
      await describe(indexPath.replace(/\n$/, '')),
      paths,
      metadata,
    ]),
  );
  return hash.digest('hex');
};

/** Paths changed by commits between the base commit and HEAD (tree-to-tree, no renames). */
const readCommittedPaths = async (context: Context): Promise<Set<string>> => {
  const output = await runGitChecked(
    [
      'diff-tree',
      '-r',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=dirty',
      context.baseCommit,
      context.headCommit,
    ],
    context.diffOptions,
  );
  return new Set(output.split('\0').filter((path) => path !== ''));
};

type TrackedRecord = {
  path: string;
  previousPath: string | null;
  change: FileChangeType;
  oldMode: string;
  newMode: string;
  oldBlob: string;
  similarity: number | null;
  numstat: { additions: number | null; deletions: number | null } | null;
};

/**
 * Parses `git diff-index --raw --numstat -z <base>`: raw records
 * (`:modes shas status\0path\0[path\0]`) followed by numstat records (`added\tdeleted\tpath\0` or
 * `added\tdeleted\t\0old\0new\0`).
 *
 * Plumbing is used deliberately: porcelain `git diff` refreshes and rewrites the index even with
 * `GIT_OPTIONAL_LOCKS=0`. Without a refresh, `diff-index` also reports files whose stat data
 * changed but whose content did not; those have no numstat record and are dropped.
 */
const readTrackedRecords = async (context: Context): Promise<TrackedRecord[]> => {
  const output = await runGitChecked(
    [
      '--literal-pathspecs',
      'diff-index',
      '--raw',
      '--numstat',
      '-z',
      '--no-abbrev',
      ...diffArguments,
      context.baseCommit,
    ],
    context.diffOptions,
  );
  const fields = output.split('\0');
  const records = new Map<string, TrackedRecord>();
  let index = 0;
  while (index < fields.length) {
    const field = fields[index] ?? '';
    index += 1;
    if (field === '') continue;
    if (field.startsWith(':')) {
      const [oldMode = '', newMode = '', oldBlob = '', , status = ''] = field.slice(1).split(' ');
      const twoPaths = status.startsWith('R') || status.startsWith('C');
      const first = fields[index] ?? '';
      const second = twoPaths ? (fields[index + 1] ?? '') : null;
      index += twoPaths ? 2 : 1;
      const path = second ?? first;
      const score = Number.parseInt(status.slice(1), 10);
      records.set(path, {
        path,
        previousPath: twoPaths ? first : null,
        change: changeFromStatus(status),
        oldMode,
        newMode,
        oldBlob,
        similarity: twoPaths && Number.isFinite(score) ? score : null,
        numstat: null,
      });
      continue;
    }
    const [added = '', deleted = '', inlinePath = ''] = field.split('\t');
    let path = inlinePath;
    if (inlinePath === '') {
      path = fields[index + 1] ?? '';
      index += 2;
    }
    const record = records.get(path);
    if (record !== undefined) {
      record.numstat = {
        additions: added === '-' ? null : Number(added),
        deletions: deleted === '-' ? null : Number(deleted),
      };
    }
  }
  return [...records.values()].filter(
    (record) =>
      !(
        record.change === 'modified' &&
        record.numstat === null &&
        record.oldMode === record.newMode
      ),
  );
};

const symlinkEscapes = (root: string, path: string, target: string): boolean => {
  const resolved = isAbsolute(target) ? normalize(target) : join(root, dirname(path), target);
  return !isWithin(root, resolved);
};

const blobSize = async (context: Context, blob: string): Promise<number | null> => {
  if (zeroSha.test(blob)) return null;
  const result = await runGit(['cat-file', '-s', blob], { ...context.options, cwd: context.root });
  return result.exitCode === 0 ? Number(result.stdout.trim()) : null;
};

/** Paths whose `diff` attribute is unset (`-diff` or `binary`): Git shows them as binary. */
const readBinaryAttributes = async (context: Context, paths: string[]): Promise<Set<string>> => {
  const binary = new Set<string>();
  for (let start = 0; start < paths.length; start += 500) {
    const output = await runGitChecked(
      ['check-attr', '-z', 'diff', '--', ...paths.slice(start, start + 500)],
      { ...context.options, cwd: context.root },
    );
    const fields = output.split('\0');
    for (let index = 0; index + 2 < fields.length; index += 3) {
      if (fields[index + 2] === 'unset') binary.add(fields[index] ?? '');
    }
  }
  return binary;
};

const baseFile = (
  path: string,
): Omit<ChangedFile, 'change' | 'tracked' | 'kind' | 'previousKind'> => ({
  path,
  previousPath: null,
  staged: false,
  unstaged: false,
  committed: false,
  existsInWorktree: false,
  binary: null,
  size: null,
  additions: null,
  deletions: null,
  similarity: null,
  symlinkTarget: null,
  symlinkEscapesWorktree: null,
  diffOmitted: null,
});

/** Describes a tracked change from Git's records plus current worktree metadata. */
const describeTracked = async (
  context: Context,
  record: TrackedRecord,
  status: WorkingTreeStatus,
  committed: Set<string>,
): Promise<ChangedFile> => {
  const touches = (paths: string[]) =>
    paths.includes(record.path) ||
    (record.previousPath !== null && paths.includes(record.previousPath));
  const conflicted = status.conflicted.includes(record.path);
  const kind = kindFromMode(record.newMode);
  const file: ChangedFile = {
    ...baseFile(record.path),
    previousPath: record.previousPath,
    change: conflicted ? 'conflicted' : record.change,
    tracked: true,
    staged: touches(status.staged),
    unstaged: touches(status.unstaged),
    committed: committed.has(record.path) || committed.has(record.previousPath ?? ''),
    kind: kind ?? kindFromMode(record.oldMode) ?? 'other',
    previousKind: kindFromMode(record.oldMode),
    similarity: record.similarity,
    additions: record.numstat?.additions ?? null,
    deletions: record.numstat?.deletions ?? null,
  };

  const current = await readWorktreeEntry(context.root, record.path, 0);
  file.existsInWorktree = current.kind !== 'missing';
  if (current.kind === 'file') {
    file.size = current.size;
  } else if (current.kind === 'symlink') {
    file.symlinkTarget = current.target;
    file.symlinkEscapesWorktree = symlinkEscapes(context.root, record.path, current.target);
  }

  if (file.kind === 'submodule' || file.previousKind === 'submodule') {
    file.diffOmitted = 'unsupported_file_type';
    return file;
  }
  if (record.numstat !== null && file.additions === null) {
    // Git reported binary content: genuinely binary, or above the size limit on either side.
    const previousSize = await blobSize(context, record.oldBlob);
    const tooLarge =
      (file.size ?? 0) > context.limits.maxFileBytes ||
      (previousSize ?? 0) > context.limits.maxFileBytes;
    file.binary = tooLarge ? null : true;
    file.diffOmitted = tooLarge ? 'too_large' : 'binary';
    return file;
  }
  file.binary = record.numstat === null ? null : false;
  return file;
};

/** Describes an untracked path by reading it safely within the read budget. */
const describeUntracked = async (
  context: Context,
  path: string,
  binaryByAttribute: Set<string>,
  budget: { remaining: number },
): Promise<ChangedFile | null> => {
  const file: ChangedFile = {
    ...baseFile(path),
    change: 'added',
    tracked: false,
    unstaged: true,
    kind: 'file',
    previousKind: null,
    existsInWorktree: true,
    deletions: 0,
  };
  // Git reports nested repositories as untracked directories with a trailing slash.
  if (path.endsWith('/')) {
    return { ...file, kind: 'directory', deletions: null, diffOmitted: 'unsupported_file_type' };
  }
  const readLimit = Math.min(context.limits.maxFileBytes, budget.remaining);
  const entry = await readWorktreeEntry(context.root, path, readLimit);
  switch (entry.kind) {
    case 'missing':
      return null;
    case 'outside_worktree':
      return { ...file, kind: 'other', diffOmitted: 'outside_worktree' };
    case 'other':
      return { ...file, kind: 'other', diffOmitted: 'unsupported_file_type' };
    case 'symlink':
      return {
        ...file,
        kind: 'symlink',
        binary: false,
        additions: 1,
        symlinkTarget: entry.target,
        symlinkEscapesWorktree: symlinkEscapes(context.root, path, entry.target),
      };
    case 'file':
      break;
  }
  file.kind = entry.executable ? 'executable' : 'file';
  file.size = entry.size;
  if (entry.content === null) {
    const tooLarge = entry.size > context.limits.maxFileBytes;
    file.diffOmitted = tooLarge ? 'too_large' : 'read_budget_exhausted';
    file.deletions = tooLarge ? 0 : null;
    return file;
  }
  budget.remaining -= entry.content.length;
  if (binaryByAttribute.has(path) || looksBinary(entry.content)) {
    return { ...file, binary: true, diffOmitted: 'binary' };
  }
  file.binary = false;
  file.additions = countLines(entry.content);
  if (decodeUtf8(entry.content) === null) {
    file.diffOmitted = 'unsupported_encoding';
  }
  return file;
};

type Inventory = { files: ChangedFile[]; totalFiles: number };

/**
 * Builds the change inventory. Tracked changes come from one `git diff <base>` (base tree versus
 * working tree), untracked files from `git status`. A path both deleted from the index and present
 * as an untracked file is reported once, as the tracked deletion.
 */
const buildInventory = async (
  context: Context,
  select: (paths: { path: string; previousPath: string | null }[]) => Set<string>,
): Promise<Inventory> => {
  const [records, statusOutput, committed] = await Promise.all([
    readTrackedRecords(context),
    readStatusOutput(context.root, context.options),
    readCommittedPaths(context),
  ]);
  const status = parseStatusOutput(statusOutput);
  const recordsByPath = new Map(records.map((record) => [record.path, record]));
  const untracked = status.untracked.filter((path) => !recordsByPath.has(path));

  const candidates = [
    ...records.map((record) => ({ path: record.path, previousPath: record.previousPath })),
    ...untracked.map((path) => ({ path, previousPath: null })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const selected = select(candidates);

  const binaryByAttribute = await readBinaryAttributes(
    context,
    untracked.filter((path) => selected.has(path) && !path.endsWith('/')),
  );
  const budget = { remaining: context.limits.maxTotalReadBytes };
  const files: ChangedFile[] = [];
  for (const candidate of candidates) {
    if (!selected.has(candidate.path)) continue;
    const record = recordsByPath.get(candidate.path);
    const file =
      record !== undefined
        ? await describeTracked(context, record, status, committed)
        : await describeUntracked(context, candidate.path, binaryByAttribute, budget);
    if (file === null) continue;
    if (record !== undefined && status.untracked.includes(record.path)) {
      file.existsInWorktree = true;
    }
    files.push(file);
  }
  return { files, totalFiles: candidates.length };
};

/**
 * Inventories every change in a verified task worktree relative to the recorded base commit:
 * commits made on the task branch, staged and unstaged changes, and untracked files. Each path
 * appears once and describes the difference between the base commit and the current working tree.
 * Read-only and best-effort: see `consistency` and `revision`.
 */
export const inspectTaskChanges = async (options: TaskChangesOptions): Promise<TaskChanges> => {
  const context = await prepare(options);
  const before = await computeRevision(context);

  const [inventory, ignored, ancestry] = await Promise.all([
    buildInventory(
      context,
      (paths) => new Set(paths.slice(0, context.limits.maxFiles).map(({ path }) => path)),
    ),
    listIgnoredPaths(context.root, context.options),
    runGit(['merge-base', '--is-ancestor', context.baseCommit, context.headCommit], {
      ...context.options,
      cwd: context.root,
    }),
  ]);
  if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) {
    throw new GitCommandError(`git merge-base failed: ${ancestry.stderr.trim()}`, {
      code: 'GIT_FAILED',
      args: ['merge-base'],
      exitCode: ancestry.exitCode,
      signal: null,
      stderr: ancestry.stderr,
    });
  }

  const after = await computeRevision(context);
  const totals = { additions: 0, deletions: 0 };
  for (const file of inventory.files) {
    totals.additions += file.additions ?? 0;
    totals.deletions += file.deletions ?? 0;
  }
  return {
    repository: context.repository,
    worktreePath: context.root,
    branch: context.branch,
    baseCommit: context.baseCommit,
    headCommit: context.headCommit,
    baseIsAncestor: ancestry.exitCode === 0,
    files: inventory.files,
    totalFiles: inventory.totalFiles,
    filesTruncated: inventory.totalFiles > inventory.files.length,
    totals,
    ignoredPaths: ignored.slice(0, context.limits.maxFiles),
    ignoredPathsTruncated: ignored.length > context.limits.maxFiles,
    revision: after,
    consistency: before === after ? 'stable' : 'changed_during_inspection',
  };
};

const trackedPatch = async (
  context: Context,
  file: ChangedFile,
): Promise<{ patch: string | null; omitted: DiffOmissionReason | null }> => {
  const paths = file.previousPath === null ? [file.path] : [file.previousPath, file.path];
  let result;
  try {
    result = await runGit(
      [
        '--literal-pathspecs',
        'diff-index',
        '--patch',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--unified=3',
        ...diffArguments,
        context.baseCommit,
        '--',
        ...paths,
      ],
      { ...context.diffOptions, maxOutputBytes: context.limits.maxDiffBytes },
    );
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 'GIT_OUTPUT_LIMIT') {
      return { patch: null, omitted: 'diff_too_large' };
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    throw new GitCommandError(`git diff failed: ${result.stderr.trim()}`, {
      code: 'GIT_FAILED',
      args: ['diff'],
      exitCode: result.exitCode,
      signal: null,
      stderr: result.stderr,
    });
  }
  const patch = decodeUtf8(result.stdoutBytes);
  if (patch === null) {
    return { patch: null, omitted: 'unsupported_encoding' };
  }
  if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(patch)) {
    return { patch: null, omitted: 'binary' };
  }
  return { patch, omitted: null };
};

const untrackedPatch = async (
  context: Context,
  file: ChangedFile,
): Promise<{ patch: string | null; omitted: DiffOmissionReason | null }> => {
  const entry = await readWorktreeEntry(context.root, file.path, context.limits.maxFileBytes);
  let mode: string;
  let text: string | null;
  if (entry.kind === 'symlink') {
    mode = '120000';
    text = entry.target;
  } else if (entry.kind === 'file' && entry.content !== null) {
    if (looksBinary(entry.content) || file.binary === true) {
      return { patch: null, omitted: 'binary' };
    }
    mode = entry.executable ? '100755' : '100644';
    text = decodeUtf8(entry.content);
  } else if (entry.kind === 'file') {
    return { patch: null, omitted: 'too_large' };
  } else if (entry.kind === 'outside_worktree') {
    return { patch: null, omitted: 'outside_worktree' };
  } else {
    return { patch: null, omitted: 'unsupported_file_type' };
  }
  if (text === null) {
    return { patch: null, omitted: 'unsupported_encoding' };
  }
  const patch = formatNewFilePatch(file.path, mode, text);
  if (Buffer.byteLength(patch, 'utf8') > context.limits.maxDiffBytes) {
    return { patch: null, omitted: 'diff_too_large' };
  }
  return { patch, omitted: null };
};

/**
 * Returns the unified diff of one changed file between the recorded base commit and the current
 * working tree. Only paths listed by the change inventory are accepted, so arbitrary files cannot
 * be read. Untracked files get a new-file patch generated from their content without staging.
 */
export const getTaskFileDiff = async ({
  path,
  ...options
}: TaskFileDiffOptions): Promise<TaskFileDiff> => {
  const requested = parseWorktreePath(path.endsWith('/') ? path.slice(0, -1) : path);
  const context = await prepare(options);
  const before = await computeRevision(context);
  const { files } = await buildInventory(
    context,
    (paths) =>
      new Set(
        paths
          .filter(
            (candidate) =>
              candidate.path === requested ||
              candidate.path === `${requested}/` ||
              candidate.previousPath === requested,
          )
          .map((candidate) => candidate.path),
      ),
  );
  const file = files[0];
  if (file === undefined) {
    throw new GitInputError(`${JSON.stringify(path)} is not among the task's changed files.`);
  }

  const { patch, omitted } =
    file.diffOmitted !== null && file.diffOmitted !== 'read_budget_exhausted'
      ? { patch: null, omitted: file.diffOmitted }
      : file.tracked
        ? await trackedPatch(context, file)
        : await untrackedPatch(context, file);
  const after = await computeRevision(context);
  return {
    file,
    patch,
    omitted,
    revision: after,
    consistency: before === after ? 'stable' : 'changed_during_inspection',
  };
};
