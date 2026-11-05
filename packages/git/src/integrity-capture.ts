import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { GitCommandError, GitInputError, TaskWorktreeError } from './errors.js';
import {
  gitIntegrityLimitsSchema,
  type ConfigEntry,
  type ConfigFile,
  type FileIdentity,
  type GitIntegrityLimits,
  type GitIntegritySnapshot,
  type GitIntegritySnapshotTarget,
  type IntegrityFailureReason,
  type IntegrityInspectionFailure,
  type MetadataEntry,
  type Observation,
  type RefRecord,
  type ResolvedGitIntegrityLimits,
  type WorktreeRecord,
} from './integrity-schema.js';
import { readFilterOverrides, runGit } from './process.js';
import { redactRemoteUrl } from './refs.js';
import { validateRepository } from './repository.js';
import {
  parseAbsolutePath,
  parseBranchName,
  parseCommandOptions,
  type GitCommandOptions,
} from './schemas.js';
import { inspectTaskWorktree } from './task-worktree.js';
import { listWorktrees } from './worktree-list.js';

export type CaptureGitIntegrityOptions = GitCommandOptions & {
  /** Main working tree of the repository (as configured for the project). */
  repositoryPath: string;
  /** Managed task worktree. */
  worktreePath: string;
  branchName: string;
  /** Base commit recorded when the task worktree was created (full SHA). */
  baseCommit: string;
  limits?: GitIntegrityLimits;
  /**
   * Repository identity the caller already verified (for example the authorization's trusted
   * repository, or the baseline's). When the repository at `repositoryPath` resolves to a different
   * root or common Git directory, only the `repository` section is recorded; nothing else is run
   * against the unrelated repository.
   */
  expectedRepository?: {
    root: string;
    commonDir: string;
    /** When given, a directory replaced at the same path (different `dev`/`ino`) also mismatches. */
    rootIdentity?: FileIdentity;
    commonDirIdentity?: FileIdentity;
  };
};

const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Raised inside a section to fail it with a specific reason. */
class ObservationError extends Error {
  constructor(
    readonly reason: IntegrityFailureReason,
    message: string,
  ) {
    super(message);
  }
}

const gitFailureReasons: Record<GitCommandError['code'], IntegrityFailureReason> = {
  GIT_UNAVAILABLE: 'git_failed',
  GIT_FAILED: 'git_failed',
  GIT_TIMEOUT: 'timeout',
  GIT_OUTPUT_LIMIT: 'output_limit',
};

/**
 * Converts any error into a failure record. Messages never include stderr, file content, or config
 * values: only the Git subcommand, error codes, and our own text.
 */
const toFailure = (error: unknown): IntegrityInspectionFailure => {
  if (error instanceof ObservationError) {
    return { reason: error.reason, message: error.message.slice(0, 500) };
  }
  if (error instanceof GitCommandError) {
    const exit = error.exitCode === null ? '' : `, exit ${error.exitCode}`;
    return {
      reason: gitFailureReasons[error.code],
      message: `git ${error.args[0] ?? ''} failed (${error.code}${exit}).`,
    };
  }
  if (error instanceof TaskWorktreeError) {
    return { reason: 'not_verified', message: `Task worktree check failed (${error.code}).` };
  }
  if (error instanceof GitInputError) {
    return { reason: 'malformed', message: 'Git reported a value that failed validation.' };
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { reason: 'unreadable', message: `File system error ${error.code.slice(0, 32)}.` };
  }
  return { reason: 'unexpected', message: 'Unexpected inspection error.' };
};

const failed = <T>(reason: IntegrityFailureReason, message: string): Observation<T> => ({
  status: 'failed',
  failure: { reason, message },
});

const observe = async <T>(run: () => Promise<T>): Promise<Observation<T>> => {
  try {
    return { status: 'observed', value: await run() };
  } catch (error) {
    return { status: 'failed', failure: toFailure(error) };
  }
};

const sha256 = (...parts: Array<string | Buffer>): string => {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    // Length-prefixed, so different splits of the same bytes never collide.
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
};

const identityOf = (stats: BigIntStats): FileIdentity => ({
  dev: stats.dev.toString(),
  ino: stats.ino.toString(),
});

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

/** Keeps subjects bounded: long names are shortened and suffixed with their digest. */
const boundedSubject = (value: string): string =>
  value.length <= 512 ? value : `${value.slice(0, 440)}…${sha256(value)}`;

/** Config keys may contain URLs in subsections (`url.<url>.insteadOf`); hide user info. */
const redactConfigKey = (key: string): string =>
  boundedSubject(redactRemoteUrl(key).replace(/(:\/\/)[^/@\s]*@/g, '$1***@'));

/**
 * Reads one metadata entry without following symlinks: the parent directory must resolve to itself,
 * the final component is `lstat`ed and opened with `O_NOFOLLOW | O_NONBLOCK`, and the opened file
 * must be the one `lstat` saw. Larger files than `maxBytes` fail the section.
 */
const readMetadataEntry = async (
  path: string,
  maxBytes: number,
): Promise<Omit<MetadataEntry, 'location' | 'name'>> => {
  const empty = { size: null, executable: false, digest: null };
  try {
    if ((await realpath(dirname(path))) !== dirname(path)) {
      return { kind: 'redirected', ...empty };
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) {
      return { kind: 'missing', ...empty };
    }
    throw error;
  }
  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) {
      return { kind: 'missing', ...empty };
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const target = await readlink(path, { encoding: 'buffer' });
    return { kind: 'symlink', size: target.length, executable: false, digest: sha256(target) };
  }
  if (stats.isDirectory()) {
    return { kind: 'directory', ...empty };
  }
  if (!stats.isFile()) {
    return { kind: 'other', ...empty };
  }
  if (stats.size > BigInt(maxBytes)) {
    throw new ObservationError(
      'limit_exceeded',
      `${basename(path)} is larger than ${maxBytes} bytes.`,
    );
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.ino !== stats.ino || opened.dev !== stats.dev) {
      throw new ObservationError('unreadable', `${basename(path)} changed while it was read.`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) {
      throw new ObservationError(
        'limit_exceeded',
        `${basename(path)} is larger than ${maxBytes} bytes.`,
      );
    }
    return {
      kind: 'file',
      size: length,
      executable: (Number(opened.mode) & 0o111) !== 0,
      digest: sha256(buffer.subarray(0, length)),
    };
  } finally {
    await handle.close();
  }
};

/** Parses `git config --null --list` output into per-key value digests. */
const parseConfigList = (file: ConfigFile, output: string, maxEntries: number): ConfigEntry[] => {
  const values = new Map<string, string[]>();
  let count = 0;
  for (const record of output.split('\0')) {
    if (record === '') continue;
    count += 1;
    if (count > maxEntries) {
      throw new ObservationError('limit_exceeded', `More than ${maxEntries} config entries.`);
    }
    const separator = record.indexOf('\n');
    const key = separator === -1 ? record : record.slice(0, separator);
    // A key without `=` is an implicit boolean; mark it so it differs from an empty value.
    const value = separator === -1 ? '\0implicit' : `=${record.slice(separator + 1)}`;
    if (key === '') {
      throw new ObservationError('malformed', 'Git listed a config entry without a key.');
    }
    const list = values.get(key) ?? [];
    list.push(value);
    values.set(key, list);
  }
  const entries = new Map<string, ConfigEntry>();
  for (const [key, list] of values) {
    const subject = redactConfigKey(key);
    const previous = entries.get(subject);
    // Distinct keys that redact to the same subject are merged, keeping both values in the digest.
    const merged = previous === undefined ? list : [previous.valuesDigest, ...list];
    entries.set(subject, {
      file,
      key: subject,
      count: (previous?.count ?? 0) + list.length,
      valuesDigest: sha256(...merged),
    });
  }
  return [...entries.values()];
};

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Captures a read-only, bounded inventory of the Git state around a task worktree (SEC-02d).
 *
 * - Read-only: only `rev-parse`, `for-each-ref`, `worktree list`, `config --file --list`, `status`
 *   (optional locks off, filters and fsmonitor neutralized, hooks disabled) and `lstat`/`read` of a
 *   fixed set of metadata files. It never writes, repairs, fetches, or refreshes the index.
 * - Never throws for inspection problems: a section that cannot be observed completely and safely
 *   is recorded as `failed`, which makes any comparison `inconclusive`. Only invalid arguments throw
 *   `GitInputError`.
 * - Does not record file contents of the working trees, config values, or credentials: config
 *   values, hook contents, and metadata files are reduced to SHA-256 digests.
 */
export const captureGitIntegritySnapshot = async ({
  repositoryPath,
  worktreePath,
  branchName,
  baseCommit,
  limits: limitInput = {},
  expectedRepository,
  ...commandInput
}: CaptureGitIntegrityOptions): Promise<GitIntegritySnapshot> => {
  const target: GitIntegritySnapshotTarget = {
    repositoryPath: parseAbsolutePath(repositoryPath, 'Repository path'),
    worktreePath: parseAbsolutePath(worktreePath, 'Worktree path'),
    branch: parseBranchName(branchName),
    baseCommit: typeof baseCommit === 'string' ? baseCommit : '',
  };
  if (!objectIdPattern.test(target.baseCommit)) {
    throw new GitInputError('The base commit must be a full lowercase commit SHA.');
  }
  const parsedLimits = gitIntegrityLimitsSchema.safeParse(limitInput);
  if (!parsedLimits.success) {
    throw new GitInputError(`Invalid integrity limits: ${parsedLimits.error.issues[0]?.message}.`);
  }
  const limits: ResolvedGitIntegrityLimits = parsedLimits.data;
  const command = parseCommandOptions(commandInput);
  const capturedAt = new Date().toISOString();
  const deadline = Date.now() + limits.maxDurationMs;

  /** Per-command options bounded by the remaining inspection time. */
  const commandOptions = (): Required<GitCommandOptions> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ObservationError('deadline_exceeded', 'The inspection deadline passed.');
    }
    return {
      timeoutMs: Math.max(1, Math.min(command.timeoutMs, Math.ceil(remaining))),
      maxOutputBytes: command.maxOutputBytes,
    };
  };

  const runChecked = async (
    args: string[],
    cwd: string,
    config: Array<readonly [string, string]> = [],
  ) => {
    const result = await runGit(args, { ...commandOptions(), cwd, config });
    if (result.exitCode !== 0) {
      throw new GitCommandError(`git ${args[0]} failed.`, {
        code: 'GIT_FAILED',
        args,
        exitCode: result.exitCode,
        signal: null,
        stderr: result.stderr,
      });
    }
    return result;
  };

  // 1. Repository identity. Everything else depends on it.
  const repository = await observe(async () => {
    const validation = await validateRepository(target.repositoryPath, commandOptions());
    if (!validation.valid) {
      throw new ObservationError('identity_mismatch', `Not a repository: ${validation.reason}.`);
    }
    const { root, commonDir, isLinkedWorktree, isRoot } = validation.repository;
    if (isLinkedWorktree || !isRoot) {
      throw new ObservationError(
        'identity_mismatch',
        'The repository path is not the root of a main working tree.',
      );
    }
    const [rootStats, commonStats] = await Promise.all([
      lstat(root, { bigint: true }),
      lstat(commonDir, { bigint: true }),
    ]);
    return {
      root,
      commonDir,
      rootIdentity: identityOf(rootStats),
      commonDirIdentity: identityOf(commonStats),
    };
  });

  const blockedBy = (reason: IntegrityFailureReason, message: string) => ({
    taskWorktree: failed<never>(reason, message),
    worktrees: failed<never>(reason, message),
    refs: failed<never>(reason, message),
    config: failed<never>(reason, message),
    metadataFiles: failed<never>(reason, message),
    hooks: failed<never>(reason, message),
    mainCheckoutStatus: failed<never>(reason, message),
  });

  const base = { version: 1 as const, capturedAt, target, limits, repository };
  if (repository.status === 'failed') {
    return { ...base, ...blockedBy('not_verified', 'The repository could not be verified.') };
  }
  const { root, commonDir, rootIdentity, commonDirIdentity } = repository.value;
  const sameIdentity = (expected: FileIdentity | undefined, actual: FileIdentity): boolean =>
    expected === undefined || (expected.dev === actual.dev && expected.ino === actual.ino);
  if (
    expectedRepository !== undefined &&
    (expectedRepository.root !== root ||
      expectedRepository.commonDir !== commonDir ||
      !sameIdentity(expectedRepository.rootIdentity, rootIdentity) ||
      !sameIdentity(expectedRepository.commonDirIdentity, commonDirIdentity))
  ) {
    return {
      ...base,
      ...blockedBy(
        'identity_mismatch',
        'The repository path resolves to a different repository; it was not inspected.',
      ),
    };
  }

  // 2. Task worktree verification (ownership from Git's records) and its Git directory.
  const taskWorktree = await observe(async () => {
    const inspection = await inspectTaskWorktree({
      repositoryPath: root,
      worktreePath: target.worktreePath,
      branchName: target.branch,
      ...commandOptions(),
    });
    let gitDir: string | null = null;
    let identity: FileIdentity | null = null;
    if (inspection.pathExists) {
      const stats = await lstat(inspection.path, { bigint: true });
      identity = identityOf(stats);
    }
    // `head` is only set when the path is a linked worktree of this repository.
    if (inspection.head !== null) {
      const validation = await validateRepository(inspection.path, commandOptions());
      if (
        validation.valid &&
        validation.repository.commonDir === commonDir &&
        dirname(validation.repository.gitDir) === join(commonDir, 'worktrees')
      ) {
        gitDir = validation.repository.gitDir;
      }
    }
    const baseProbe = await runGit(
      ['rev-parse', '--verify', '--quiet', `${target.baseCommit}^{commit}`],
      { ...commandOptions(), cwd: root },
    );
    if (baseProbe.exitCode !== 0 && baseProbe.exitCode !== 1) {
      throw new GitCommandError('git rev-parse failed.', {
        code: 'GIT_FAILED',
        args: ['rev-parse'],
        exitCode: baseProbe.exitCode,
        signal: null,
        stderr: baseProbe.stderr,
      });
    }
    const head = inspection.head;
    return {
      path: inspection.path,
      identity,
      state: inspection.state,
      issues: [...inspection.issues].sort(compareStrings),
      registered: inspection.registered,
      locked: inspection.locked,
      headBranch: head === null || head.kind === 'detached' ? null : boundedSubject(head.branch),
      headCommit: head?.commit ?? null,
      gitDir,
      baseCommitPresent: baseProbe.exitCode === 0 && baseProbe.stdout.trim() === target.baseCommit,
    };
  });
  const taskPath =
    taskWorktree.status === 'observed' ? taskWorktree.value.path : target.worktreePath;
  const taskGitDir = taskWorktree.status === 'observed' ? taskWorktree.value.gitDir : null;

  // 3. Worktree registry, including every worktree's HEAD and branch.
  const worktrees = await observe(async () => {
    const entries = await listWorktrees(root, commandOptions());
    if (entries.length > limits.maxWorktrees) {
      throw new ObservationError('limit_exceeded', `More than ${limits.maxWorktrees} worktrees.`);
    }
    if (entries[0]?.path !== root) {
      throw new ObservationError('identity_mismatch', 'The main worktree is not the repository.');
    }
    return entries
      .map((entry, index): WorktreeRecord => {
        if (entry.path === '' || (entry.head !== null && !objectIdPattern.test(entry.head))) {
          throw new ObservationError('malformed', 'Git listed a malformed worktree entry.');
        }
        return {
          path: boundedSubject(entry.path),
          role: index === 0 ? 'main' : entry.path === taskPath ? 'task' : 'other',
          head: entry.head,
          branch: entry.branch === null ? null : boundedSubject(entry.branch),
          bare: entry.bare,
          detached: entry.detached,
          locked: entry.locked,
          lockReasonDigest: entry.lockReason === null ? null : sha256(entry.lockReason),
          prunable: entry.prunable,
        };
      })
      .sort((left, right) => compareStrings(left.path, right.path));
  });

  // 4. Every ref of the repository (branches, remote-tracking refs, tags, notes, stash, ...).
  const refs = await observe(async () => {
    const result = await runChecked(
      [
        'for-each-ref',
        `--count=${limits.maxRefs + 1}`,
        '--format=%(refname)%00%(objectname)%00%(symref)',
      ],
      root,
    );
    // Git skips broken refs with a warning; a silently shorter list must not look clean.
    if (result.stderr.trim() !== '') {
      throw new ObservationError('malformed', 'Git reported broken or unreadable refs.');
    }
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    if (lines.length > limits.maxRefs) {
      throw new ObservationError('limit_exceeded', `More than ${limits.maxRefs} refs.`);
    }
    return lines
      .map((line): RefRecord => {
        const [name = '', objectName = '', symref = ''] = line.split('\0');
        if (!name.startsWith('refs/') || !objectIdPattern.test(objectName)) {
          throw new ObservationError('malformed', 'Git listed a malformed ref.');
        }
        return {
          name: boundedSubject(name),
          target: objectName,
          symref: symref === '' ? null : boundedSubject(symref),
        };
      })
      .sort((left, right) => compareStrings(left.name, right.name));
  });

  // 5. Repository config files, key by key (values only as digests). Includes are not followed.
  const configPaths: Array<[ConfigFile, string | null]> = [
    ['common_config', join(commonDir, 'config')],
    ['common_config_worktree', join(commonDir, 'config.worktree')],
    ['task_config_worktree', taskGitDir === null ? null : join(taskGitDir, 'config.worktree')],
  ];
  // The task worktree's own config is read only when its Git directory was verified.
  const config = await observe(async () => {
    const entries: ConfigEntry[] = [];
    for (const [file, path] of configPaths) {
      if (path === null) continue;
      const stats = await lstat(path).catch((error: unknown) => {
        if (hasCode(error, 'ENOENT')) return null;
        throw error;
      });
      // Missing: no entries. Symlinks and other kinds are reported through `metadataFiles`.
      if (stats === null || !stats.isFile()) continue;
      const result = await runChecked(
        ['config', '--file', path, '--no-includes', '--null', '--list'],
        root,
      );
      entries.push(...parseConfigList(file, result.stdout, limits.maxConfigEntries));
    }
    return entries.sort(
      (left, right) => compareStrings(left.file, right.file) || compareStrings(left.key, right.key),
    );
  });

  // 6. Fixed metadata files that redirect or reconfigure the repository.
  // Task admin files are read only when the task worktree's Git directory was verified.
  const metadataFiles = await observe(async () => {
    const files: ReadonlyArray<readonly [MetadataEntry['location'], string, string]> = [
      ['common', 'config', commonDir],
      ['common', 'config.worktree', commonDir],
      ['common', 'info/attributes', commonDir],
      ['common', 'objects/info/alternates', commonDir],
      ...(taskGitDir === null
        ? []
        : ([
            ['task_admin', 'commondir', taskGitDir],
            ['task_admin', 'gitdir', taskGitDir],
            ['task_admin', 'config.worktree', taskGitDir],
          ] as const)),
      ['task_worktree', '.git', taskPath],
    ];
    const entries: MetadataEntry[] = [];
    for (const [location, name, directory] of files) {
      commandOptions(); // deadline check
      entries.push({
        location,
        name,
        ...(await readMetadataEntry(join(directory, name), limits.maxMetadataFileBytes)),
      });
    }
    return entries;
  });

  // 7. The common hooks directory (a configured `core.hooksPath` is recorded through config).
  const hooks = await observe(async () => {
    const directoryPath = join(commonDir, 'hooks');
    const directory = await readMetadataEntry(directoryPath, limits.maxMetadataFileBytes);
    if (directory.kind !== 'directory') {
      return { directory: directory.kind, directoryDigest: directory.digest, entries: [] };
    }
    const names = await readdir(directoryPath);
    if (names.length > limits.maxHookEntries) {
      throw new ObservationError('limit_exceeded', `More than ${limits.maxHookEntries} hooks.`);
    }
    const entries = [];
    for (const name of names.sort(compareStrings)) {
      commandOptions(); // deadline check
      entries.push({
        name: boundedSubject(name),
        ...(await readMetadataEntry(join(directoryPath, name), limits.maxMetadataFileBytes)),
      });
    }
    return { directory: 'directory' as const, directoryDigest: null, entries };
  });

  // 8. Main checkout status digest (which paths are dirty; not their content).
  const mainCheckoutStatus = await observe(async () => {
    const filters = await readFilterOverrides(root, commandOptions());
    const result = await runChecked(
      [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=normal',
        '--ignore-submodules=dirty',
        '--no-renames',
      ],
      root,
      filters,
    );
    return {
      path: root,
      entries: result.stdout.split('\0').filter((record) => record !== '').length,
      statusDigest: sha256(result.stdoutBytes),
    };
  });

  return {
    ...base,
    taskWorktree,
    worktrees,
    refs,
    config,
    metadataFiles,
    hooks,
    mainCheckoutStatus,
  };
};
