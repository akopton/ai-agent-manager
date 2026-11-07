import {
  classifyRepositoryContent,
  classifyRepositoryPath,
  extractSearchTerms,
  isDocumentationPath,
  isRepositoryRelativePath,
  renderRepositoryCatalog,
  repositoryContextLimits,
  repositoryPathExclusionLabels,
  type RepositoryCatalog,
  type RepositoryContextRecord,
  type RepositoryExcerpt,
  type RepositoryPathExclusionReason,
  type RequestedRepositoryFile,
} from '@ai-agent-manager/core';
// The only Git entry point conversation code may use: read-only object reads of one commit.
import {
  listIgnoredTrackedPaths,
  listSourceTree,
  readSourceBlob,
  resolveSourceSnapshot,
  searchSource,
  SourceContextError,
  type SourceSnapshot,
  type SourceTreeEntry,
} from '@ai-agent-manager/git/source-context';

// C4 — retrieval for project-aware turns, in the worker. The application, never the model, reads
// the repository: it lists the tracked files of the checkout's HEAD commit, applies the default
// exclusion policy, lets the model choose from that catalog (planning phase, run by the turn
// service), validates every requested path against the catalog, and reads bounded excerpts from
// Git objects. Nothing here writes to the repository or Git metadata, runs repository scripts,
// creates a worktree, or reads a task worktree or the filesystem of the checkout.

const limits = repositoryContextLimits;

export type PreparedRepositoryContext = {
  snapshot: SourceSnapshot;
  previousCommit: string | null;
  /** Readable files by path. */
  eligible: Map<string, SourceTreeEntry>;
  /** Tracked entries refused by policy, by path. */
  excluded: Map<string, RepositoryPathExclusionReason>;
  catalog: RepositoryCatalog;
  catalogText: string;
  listedFiles: number;
  treeTotal: number;
};

/** What the excerpts are selected from: the model's validated request or the fallback. */
export type RepositoryContextPlan = {
  selection: RepositoryContextRecord['selection'];
  selectionNote: string | null;
  files: RequestedRepositoryFile[];
  searches: string[];
  ignored: string[];
};

export type RetrievedRepositoryContext = {
  record: RepositoryContextRecord;
  excerpts: RepositoryExcerpt[];
};

export type RepositoryContextFailure = {
  errorCode: 'repository_unavailable' | 'repository_context_failed';
  errorMessage: string;
};

/** Maps a read failure to a stored, actionable turn error. Never claims a partial analysis. */
export const describeRepositoryFailure = (error: unknown): RepositoryContextFailure => {
  if (error instanceof SourceContextError && error.code !== 'read_failed') {
    return {
      errorCode: 'repository_unavailable',
      errorMessage: `${error.message} Nothing was sent to the AI. Check the project's repository, or switch the conversation to General Chat.`,
    };
  }
  return {
    errorCode: 'repository_context_failed',
    errorMessage: `${error instanceof Error ? error.message : String(error)} Nothing was sent to the AI; retry, or switch the conversation to General Chat.`,
  };
};

const depthOf = (path: string): number => path.split('/').length;

const byDepthThenPath = (left: string, right: string): number =>
  depthOf(left) - depthOf(right) || (left < right ? -1 : left > right ? 1 : 0);

const directoryOverview = (paths: readonly string[]): { path: string; files: number }[] => {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const segments = path.split('/').slice(0, -1);
    for (let depth = 1; depth <= Math.min(3, segments.length); depth += 1) {
      const directory = segments.slice(0, depth).join('/');
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([path, files]) => ({ path, files }))
    .sort((left, right) => byDepthThenPath(left.path, right.path))
    .slice(0, 150);
};

/** Searches one term and keeps only readable files (excluded files never leave this module). */
const searchEligible = async (
  prepared: Pick<PreparedRepositoryContext, 'snapshot' | 'eligible'>,
  term: string,
): Promise<{ matches: Map<string, number[]>; truncated: boolean }> => {
  const result = await searchSource(prepared.snapshot, term, {
    maxMatchesPerFile: limits.maxSearchMatchesPerFile,
    maxOutputBytes: limits.maxSearchOutputBytes,
  });
  const matches = new Map(
    [...result.matches.entries()].filter(([path]) => prepared.eligible.has(path)),
  );
  return { matches, truncated: result.truncated };
};

/**
 * Re-validates the registered checkout, resolves HEAD, lists and classifies the tracked files and
 * builds the planning catalog (including files that match words of the message). Read-only.
 * Throws `SourceContextError` when the repository is unavailable or cannot be read.
 */
export const prepareRepositoryContext = async ({
  repository,
  message,
}: {
  repository: { localPath: string; gitCommonDir: string; previousCommit: string | null };
  message: string;
}): Promise<PreparedRepositoryContext> => {
  const snapshot = await resolveSourceSnapshot(repository);
  const tree = await listSourceTree(snapshot, { maxEntries: limits.maxTreeEntries });
  const ignored = await listIgnoredTrackedPaths(snapshot);
  const eligible = new Map<string, SourceTreeEntry>();
  const excluded = new Map<string, RepositoryPathExclusionReason>();
  for (const entry of tree.files) {
    const reason =
      classifyRepositoryPath(entry.path) ??
      (ignored.has(entry.path) ? 'gitignored' : null) ??
      (entry.size > limits.maxFileBytes ? 'too_large' : null);
    if (reason === null) eligible.set(entry.path, entry);
    else excluded.set(entry.path, reason);
  }
  for (const path of tree.skipped) excluded.set(path, 'not_regular_file');

  const paths = [...eligible.keys()].sort(byDepthThenPath);
  // Files that match words of the question by name or content, most matches first.
  const scores = new Map<string, number>();
  const terms = extractSearchTerms(message, 3);
  for (const term of terms) {
    const lower = term.toLowerCase();
    for (const path of paths) {
      if (path.toLowerCase().includes(lower)) scores.set(path, (scores.get(path) ?? 0) + 5);
    }
    const { matches } = await searchEligible({ snapshot, eligible }, term);
    for (const [path, lines] of matches) scores.set(path, (scores.get(path) ?? 0) + lines.length);
  }
  const keywordMatches = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || byDepthThenPath(left[0], right[0]))
    .slice(0, limits.catalogKeywordFiles)
    .map(([path]) => path);

  const catalog: RepositoryCatalog = {
    commit: snapshot.commit,
    branch: snapshot.branch,
    trackedFiles: tree.total,
    eligibleFiles: eligible.size,
    excludedFiles: excluded.size,
    treeTruncated: tree.truncated,
    directories: directoryOverview(paths),
    documentation: paths.filter(isDocumentationPath).slice(0, 80),
    keywordMatches,
    files: paths,
  };
  const { text, listedFiles } = renderRepositoryCatalog(catalog);
  return {
    snapshot,
    previousCommit: repository.previousCommit,
    eligible,
    excluded,
    catalog,
    catalogText: text,
    listedFiles,
    treeTotal: tree.total,
  };
};

/**
 * The deterministic selection used when the model's file selection is unusable: paths named in
 * the message that exist in the catalog, and literal searches for identifiers and long words.
 */
export const fallbackRepositoryPlan = (
  prepared: Pick<PreparedRepositoryContext, 'eligible'>,
  message: string,
  reason: string,
): RepositoryContextPlan => {
  const named = [...new Set(message.match(/[\w.-]+(?:\/[\w.-]+)+/g) ?? [])]
    .map((path) => path.replace(/^\.\//, ''))
    .filter((path) => prepared.eligible.has(path))
    .slice(0, limits.maxRequestedFiles)
    .map((path) => ({ path }));
  return {
    selection: 'fallback',
    selectionNote: reason,
    files: named,
    searches: extractSearchTerms(message),
    ignored: [],
  };
};

type ReadFile =
  { ok: true; lines: string[] } | { ok: false; reason: RepositoryPathExclusionReason };

/** Splits text into lines without the final empty line of a trailing newline. */
const toLines = (text: string): string[] => {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
};

/** Cuts a range to the per-source character limit at a line boundary. */
const boundedRange = (
  lines: readonly string[],
  start: number,
  end: number,
): { end: number; content: string } => {
  let characters = 0;
  let last = start - 1;
  for (let line = start; line <= end; line += 1) {
    const length = (lines[line - 1] ?? '').length + 1;
    if (characters + length > limits.maxCharactersPerSource && last >= start) break;
    characters += length;
    last = line;
  }
  return { end: last, content: lines.slice(start - 1, last).join('\n') };
};

/** Merges match lines into windows of context lines, in file order. */
const searchWindows = (matches: readonly number[], total: number): [number, number][] => {
  const windows: [number, number][] = [];
  for (const line of [...matches].sort((left, right) => left - right)) {
    const start = Math.max(1, line - limits.searchContextLines);
    const end = Math.min(total, line + limits.searchContextLines);
    const previous = windows.at(-1);
    if (previous !== undefined && start <= previous[1] + 1)
      previous[1] = Math.max(previous[1], end);
    else windows.push([start, end]);
  }
  return windows;
};

/**
 * Validates a plan against the catalog and reads bounded excerpts. Requested paths must be exact,
 * readable catalog entries; anything else is refused and recorded. Requested files come first,
 * then search matches, until the context budget is used. Returns the record (no content) and the
 * excerpts for the prompt. Throws `SourceContextError` only when Git itself fails.
 */
export const retrieveRepositoryContext = async (
  prepared: PreparedRepositoryContext,
  plan: RepositoryContextPlan,
): Promise<RetrievedRepositoryContext> => {
  const cache = new Map<string, ReadFile>();
  const read = async (path: string): Promise<ReadFile> => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    const entry = prepared.eligible.get(path);
    let result: ReadFile;
    if (entry === undefined) {
      result = { ok: false, reason: prepared.excluded.get(path) ?? 'not_found' };
    } else {
      const bytes = await readSourceBlob(prepared.snapshot, entry, limits.maxFileBytes);
      let text: string | null;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = null;
      }
      const reason = classifyRepositoryContent(text, bytes);
      result =
        reason === null && text !== null
          ? { ok: true, lines: toLines(text) }
          : { ok: false, reason: reason ?? 'not_text' };
    }
    cache.set(path, result);
    return result;
  };

  const excerpts: RepositoryExcerpt[] = [];
  const rejected: RepositoryContextRecord['rejected'] = [];
  const omitted: RepositoryContextRecord['omitted'] = [];
  let used = 0;
  let limited = plan.ignored.length > 0;
  const reject = (path: string, reason: string) => {
    limited = true;
    if (rejected.length < limits.maxRecordedRejections) rejected.push({ path, reason });
  };
  const omit = (path: string, reason: string) => {
    limited = true;
    if (
      omitted.length < limits.maxRecordedRejections &&
      !omitted.some((item) => item.path === path)
    ) {
      omitted.push({ path, reason });
    }
  };
  const overlaps = (path: string, start: number, end: number) =>
    excerpts.some(
      (excerpt) => excerpt.path === path && excerpt.startLine <= end && start <= excerpt.endLine,
    );
  const add = (
    path: string,
    lines: readonly string[],
    start: number,
    end: number,
    origin: RepositoryExcerpt['origin'],
  ): boolean => {
    const bounded = boundedRange(lines, start, end);
    if (used + bounded.content.length > limits.maxContextCharacters) {
      omit(path, 'context size limit reached');
      return false;
    }
    used += bounded.content.length;
    const partial = start !== 1 || bounded.end !== lines.length;
    if (bounded.end < end) limited = true;
    excerpts.push({
      path,
      startLine: start,
      endLine: bounded.end,
      totalLines: lines.length,
      characters: bounded.content.length,
      origin,
      documentation: isDocumentationPath(path),
      partial,
      content: bounded.content,
    });
    return true;
  };

  for (const request of plan.files) {
    if (!isRepositoryRelativePath(request.path)) {
      reject(request.path.slice(0, 200), repositoryPathExclusionLabels.invalid_path);
      continue;
    }
    const file = await read(request.path);
    if (!file.ok) {
      reject(request.path, repositoryPathExclusionLabels[file.reason]);
      continue;
    }
    const total = file.lines.length;
    const start = Math.max(1, request.startLine ?? 1);
    if (total === 0) {
      reject(request.path, 'the file is empty');
      continue;
    }
    if (start > total) {
      reject(request.path, `line ${start} is beyond the end of the file (${total} lines)`);
      continue;
    }
    const wanted = Math.min(total, request.endLine ?? total);
    if (wanted < start) {
      reject(request.path, `invalid line range ${start}-${request.endLine ?? ''}`);
      continue;
    }
    const end = Math.min(wanted, start + limits.maxLinesPerFile - 1);
    if (end < wanted) limited = true;
    if (overlaps(request.path, start, end)) continue;
    add(
      request.path,
      file.lines,
      start,
      end,
      plan.selection === 'fallback' ? 'fallback' : 'requested',
    );
  }

  const searches: RepositoryContextRecord['searches'] = [];
  const hits = new Map<string, number[]>();
  for (const term of plan.searches) {
    const result = await searchEligible(prepared, term);
    searches.push({ term, matchedFiles: result.matches.size, truncated: result.truncated });
    if (result.truncated) limited = true;
    for (const [path, lines] of result.matches) {
      hits.set(path, [...(hits.get(path) ?? []), ...lines]);
    }
  }
  const ranked = [...hits.entries()].sort(
    (left, right) => right[1].length - left[1].length || byDepthThenPath(left[0], right[0]),
  );
  let searchFiles = 0;
  for (const [path, matches] of ranked) {
    if (searchFiles >= limits.maxSearchFiles) {
      omit(path, 'more matching files than the search limit');
      continue;
    }
    const file = await read(path);
    if (!file.ok) continue;
    let added = false;
    for (const [start, end] of searchWindows(matches, file.lines.length)) {
      if (overlaps(path, start, end)) continue;
      added =
        add(path, file.lines, start, end, plan.selection === 'fallback' ? 'fallback' : 'search') ||
        added;
    }
    if (added) searchFiles += 1;
  }

  const record: RepositoryContextRecord = {
    version: 1,
    commit: prepared.snapshot.commit,
    branch: prepared.snapshot.branch,
    previousCommit: prepared.previousCommit,
    selection: plan.selection,
    selectionNote: plan.selectionNote,
    catalog: {
      trackedFiles: prepared.treeTotal,
      eligibleFiles: prepared.eligible.size,
      excludedFiles: prepared.excluded.size,
      listedFiles: prepared.listedFiles,
      treeTruncated: prepared.catalog.treeTruncated,
    },
    searches,
    sources: excerpts.map((excerpt) => ({
      path: excerpt.path,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      totalLines: excerpt.totalLines,
      characters: excerpt.characters,
      origin: excerpt.origin,
      documentation: excerpt.documentation,
      partial: excerpt.partial,
    })),
    rejected,
    omitted,
    ignoredRequests: plan.ignored.slice(0, limits.maxRecordedRejections),
    characters: used,
    limited: limited || prepared.catalog.treeTruncated,
    unverifiedReferences: [],
  };
  return { record, excerpts };
};
