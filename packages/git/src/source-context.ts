import { GitCommandError } from './errors.js';
import { runGit, runGitChecked } from './process.js';
import { validateRepository } from './repository.js';

// C4 — read-only source access for project-aware conversations (`ARCHITECTURE.md` §15.4 "C4").
// Published as the restricted subpath `@ai-agent-manager/git/source-context`, the only Git entry
// point conversation code may import.
//
// Guarantees, by construction:
//
// - Only these Git subcommands run: `rev-parse` and `symbolic-ref` (queries; through
//   `validateRepository` and here), `ls-tree`, `cat-file blob`, `grep` on one commit, and
//   `ls-files` (to apply the checkout's ignore rules). None writes refs, the index, objects,
//   config or the working tree; `GIT_OPTIONAL_LOCKS=0`, no hooks, no fsmonitor, no lazy fetch and
//   a sanitized environment come from `runGit`.
// - Content is read from Git objects of one resolved commit, never from the filesystem: no path
//   is ever joined to the checkout, so traversal and symlink escapes are impossible, symlinks and
//   submodules are skipped, and uncommitted or untracked files and task worktrees are never seen.
// - Every command is bounded by a timeout and an output limit.
//
// The read policy (which tracked paths may be read) lives in `@ai-agent-manager/core`.

export type SourceContextErrorCode =
  /** The registered checkout is missing, not a repository, or a different repository. */
  | 'repository_unavailable'
  /** The checkout has no commit at HEAD (unborn branch). */
  | 'no_commit'
  /** A Git read failed, timed out or exceeded its output limit. */
  | 'read_failed';

export class SourceContextError extends Error {
  override name = 'SourceContextError';

  constructor(
    readonly code: SourceContextErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The commit a project-aware turn reads, with the checkout it was resolved from. */
export type SourceSnapshot = {
  /** Canonical root of the registered main checkout. */
  root: string;
  commonDir: string;
  /** Full object ID of the commit at HEAD. */
  commit: string;
  /** Short branch name, or `null` for a detached HEAD. */
  branch: string | null;
};

export type SourceTreeEntry = { path: string; oid: string; size: number };

export type SourceTree = {
  /** Regular files (modes 100644 and 100755), in Git's order. */
  files: SourceTreeEntry[];
  /** Symlinks, submodules and other non-regular entries; never read. */
  skipped: string[];
  /** All entries seen (regular and skipped). */
  total: number;
  /** The tree had more than `maxEntries` entries; the rest is not listed. */
  truncated: boolean;
};

const objectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const readTimeoutMs = 20_000;

const wrap = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SourceContextError) throw error;
    const detail =
      error instanceof GitCommandError
        ? error.code === 'GIT_OUTPUT_LIMIT'
          ? 'the output limit was exceeded'
          : error.code === 'GIT_TIMEOUT'
            ? 'it timed out'
            : error.message
        : error instanceof Error
          ? error.message
          : String(error);
    throw new SourceContextError(
      'read_failed',
      `Reading the repository failed (${operation}): ${detail}`,
      {
        cause: error,
      },
    );
  }
};

/**
 * Re-validates the registered checkout (canonical root and common Git directory must equal the
 * stored identity; a linked worktree is refused) and resolves its HEAD commit. Read-only. Fails
 * closed with `repository_unavailable` or `no_commit`.
 */
export const resolveSourceSnapshot = async (expected: {
  localPath: string;
  gitCommonDir: string;
}): Promise<SourceSnapshot> => {
  const repository = await verifySourceRepository(expected);
  const options = { cwd: repository.root, timeoutMs: readTimeoutMs, maxOutputBytes: 64 * 1024 };
  const head = await runGit(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'],
    options,
  );
  const commit = head.stdout.trim();
  if (head.exitCode !== 0 || !objectIdPattern.test(commit)) {
    throw new SourceContextError(
      'no_commit',
      'The project checkout has no commit at HEAD yet, so there is no committed source to read.',
    );
  }
  const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], options);
  const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() || null : null;
  return { root: repository.root, commonDir: repository.commonDir, commit, branch };
};

/**
 * Checks that the registered path is still the registered repository's main checkout (canonical
 * root and common Git directory unchanged, not a linked worktree). Read-only; `rev-parse` only.
 */
export const verifySourceRepository = async (expected: {
  localPath: string;
  gitCommonDir: string;
}): Promise<{ root: string; commonDir: string }> => {
  let validation;
  try {
    validation = await validateRepository(expected.localPath, { timeoutMs: readTimeoutMs });
  } catch (error) {
    throw new SourceContextError(
      'repository_unavailable',
      `The project repository could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!validation.valid) {
    throw new SourceContextError(
      'repository_unavailable',
      `The project repository is not available at its registered path: ${validation.message}`,
    );
  }
  const { repository } = validation;
  if (
    repository.root !== expected.localPath ||
    repository.commonDir !== expected.gitCommonDir ||
    repository.isLinkedWorktree
  ) {
    throw new SourceContextError(
      'repository_unavailable',
      'The repository at the registered path is a different repository than the one registered for this project.',
    );
  }
  return { root: repository.root, commonDir: repository.commonDir };
};

/** Parses `git ls-tree -r -z -l --full-tree` output. */
const parseTree = (output: Buffer, maxEntries: number): SourceTree => {
  const files: SourceTreeEntry[] = [];
  const skipped: string[] = [];
  let total = 0;
  let truncated = false;
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end === -1) break;
    const record = output.subarray(start, end).toString('utf8');
    start = end + 1;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, oid, size] = record.slice(0, tab).split(/ +/);
    const path = record.slice(tab + 1);
    if (path === '' || mode === undefined || oid === undefined) continue;
    total += 1;
    if (files.length + skipped.length >= maxEntries) {
      truncated = true;
      continue;
    }
    const bytes = Number(size);
    if (
      type === 'blob' &&
      (mode === '100644' || mode === '100755') &&
      objectIdPattern.test(oid) &&
      Number.isSafeInteger(bytes)
    ) {
      files.push({ path, oid, size: bytes });
    } else {
      skipped.push(path);
    }
  }
  return { files, skipped, total, truncated };
};

/** Lists the tracked entries of the snapshot's commit. Reads Git objects only. */
export const listSourceTree = (
  snapshot: SourceSnapshot,
  { maxEntries }: { maxEntries: number },
): Promise<SourceTree> =>
  wrap('ls-tree', async () => {
    const result = await runGit(['ls-tree', '-r', '-z', '-l', '--full-tree', snapshot.commit], {
      cwd: snapshot.root,
      timeoutMs: readTimeoutMs,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new SourceContextError('read_failed', `git ls-tree failed: ${result.stderr.trim()}`);
    }
    return parseTree(result.stdoutBytes, maxEntries);
  });

/**
 * Tracked paths that match the checkout's ignore rules (`.gitignore`, `.git/info/exclude`,
 * `core.excludesFile`), for example force-added files. Read-only; reads the checkout's index and
 * ignore files but writes nothing.
 */
export const listIgnoredTrackedPaths = (snapshot: SourceSnapshot): Promise<Set<string>> =>
  wrap('ls-files', async () => {
    const output = await runGitChecked(
      ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'],
      { cwd: snapshot.root, timeoutMs: readTimeoutMs, maxOutputBytes: 32 * 1024 * 1024 },
    );
    return new Set(output.split('\0').filter((path) => path !== ''));
  });

/**
 * Reads one blob of the tree. The entry must come from `listSourceTree` of the same snapshot;
 * entries larger than `maxBytes` are refused before Git runs. Never applies filters or textconv.
 */
export const readSourceBlob = (
  snapshot: SourceSnapshot,
  entry: SourceTreeEntry,
  maxBytes: number,
): Promise<Buffer> =>
  wrap('cat-file', async () => {
    if (!objectIdPattern.test(entry.oid)) {
      throw new SourceContextError('read_failed', 'Invalid object ID.');
    }
    if (entry.size > maxBytes) {
      throw new SourceContextError('read_failed', `${entry.path} is larger than the read limit.`);
    }
    const result = await runGit(['cat-file', 'blob', entry.oid], {
      cwd: snapshot.root,
      timeoutMs: readTimeoutMs,
      maxOutputBytes: maxBytes + 1024,
    });
    if (result.exitCode !== 0) {
      throw new SourceContextError('read_failed', `git cat-file failed: ${result.stderr.trim()}`);
    }
    return result.stdoutBytes;
  });

export type SourceSearchResult = {
  /** Matching line numbers per path, in Git's order. */
  matches: Map<string, number[]>;
  /** The output limit was reached; more files may match. */
  truncated: boolean;
};

// Configuration that would change `git grep`'s output format or matching is forced off.
const grepConfig: ReadonlyArray<readonly [string, string]> = [
  ['grep.lineNumber', 'true'],
  ['grep.column', 'false'],
  ['grep.fullName', 'false'],
  ['grep.patternType', 'fixed'],
  ['grep.extendedRegexp', 'false'],
  ['grep.fallbackToNoIndex', 'false'],
  ['core.quotePath', 'false'],
];

/**
 * Searches the snapshot's commit for one literal, case-insensitive term (`git grep -F -i` on the
 * commit object, binary files skipped, no textconv). Returns at most `maxMatchesPerFile` line
 * numbers per file. Exclusion of paths is the caller's job (by policy); matching lines are not
 * returned, only their numbers.
 */
export const searchSource = (
  snapshot: SourceSnapshot,
  term: string,
  { maxMatchesPerFile, maxOutputBytes }: { maxMatchesPerFile: number; maxOutputBytes: number },
): Promise<SourceSearchResult> =>
  wrap('grep', async () => {
    if (term === '' || term.includes('\0') || term.includes('\n')) {
      throw new SourceContextError('read_failed', 'Invalid search term.');
    }
    let result;
    try {
      result = await runGit(
        [
          'grep',
          '-z',
          '-n',
          '-I',
          '-F',
          '-i',
          '--no-color',
          '--no-textconv',
          `--max-count=${maxMatchesPerFile}`,
          '-e',
          term,
          snapshot.commit,
          '--',
        ],
        { cwd: snapshot.root, timeoutMs: readTimeoutMs, maxOutputBytes, config: grepConfig },
      );
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 'GIT_OUTPUT_LIMIT') {
        return { matches: new Map(), truncated: true };
      }
      throw error;
    }
    // Exit code 1 means "no match".
    if (result.exitCode === 1) return { matches: new Map(), truncated: false };
    if (result.exitCode !== 0) {
      throw new SourceContextError('read_failed', `git grep failed: ${result.stderr.trim()}`);
    }
    const prefix = `${snapshot.commit}:`;
    const matches = new Map<string, number[]>();
    // Each match: `<commit>:<path>\0<line>\0<text>\n`; text may contain anything but a newline.
    const output = result.stdoutBytes;
    let start = 0;
    while (start < output.length) {
      const first = output.indexOf(0, start);
      if (first === -1) break;
      const second = output.indexOf(0, first + 1);
      if (second === -1) break;
      const newline = output.indexOf(0x0a, second + 1);
      const name = output.subarray(start, first).toString('utf8');
      const line = Number(output.subarray(first + 1, second).toString('utf8'));
      start = newline === -1 ? output.length : newline + 1;
      if (!name.startsWith(prefix) || !Number.isSafeInteger(line) || line < 1) continue;
      const path = name.slice(prefix.length);
      matches.set(path, [...(matches.get(path) ?? []), line]);
    }
    return { matches, truncated: false };
  });
