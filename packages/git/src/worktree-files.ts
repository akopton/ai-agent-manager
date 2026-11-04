import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { GitInputError } from './errors.js';

/** True when `child` is `parent` itself or inside it. */
export const isWithin = (parent: string, child: string): boolean => {
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
};

/**
 * Validates a worktree-relative path as Git reports it: relative, normalized, no `.`/`..`
 * segments, no NUL. Throws `GitInputError` otherwise.
 */
export const parseWorktreePath = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\0') ||
    isAbsolute(value) ||
    value.endsWith('/') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    normalize(value) !== value.split('/').join(sep)
  ) {
    throw new GitInputError(`Invalid worktree path: ${JSON.stringify(value)}.`);
  }
  return value;
};

export type WorktreeEntryRead =
  | { kind: 'missing' }
  /** A parent directory resolves outside the worktree or through a symlink; nothing was read. */
  | { kind: 'outside_worktree' }
  | { kind: 'symlink'; target: string }
  | { kind: 'other' }
  | {
      kind: 'file';
      size: number;
      executable: boolean;
      /** At most `maxBytes` bytes, or `null` when the file is larger and was not read. */
      content: Buffer | null;
    };

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

/**
 * Reads an entry of a verified worktree without following symlinks and without leaving it.
 *
 * - Every parent directory must resolve, unchanged, to a location inside `root` (no symlinked
 *   directory components); this is checked before and after reading.
 * - The final component is opened with `O_NOFOLLOW | O_NONBLOCK`, so a symlink swapped in is not
 *   followed and FIFOs or devices do not block; only regular files are read.
 * - Files larger than `maxBytes` are not read at all.
 */
export const readWorktreeEntry = async (
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<WorktreeEntryRead> => {
  const path = join(root, parseWorktreePath(relativePath));
  const parent = dirname(path);
  const parentInside = async (): Promise<boolean | null> => {
    try {
      const resolved = await realpath(parent);
      return resolved === parent && isWithin(root, resolved);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return null;
      throw error;
    }
  };

  const before = await parentInside();
  if (before === null) return { kind: 'missing' };
  if (!before) return { kind: 'outside_worktree' };

  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { kind: 'missing' };
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return { kind: 'symlink', target: await readlink(path) };
  }
  if (!stats.isFile()) {
    return { kind: 'other' };
  }
  const executable = (stats.mode & 0o111) !== 0;
  if (stats.size > maxBytes) {
    return { kind: 'file', size: stats.size, executable, content: null };
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { kind: 'missing' };
    // ELOOP: the entry became a symlink after lstat.
    if (hasCode(error, 'ELOOP')) return { kind: 'other' };
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stats.ino || opened.dev !== stats.dev) {
      return { kind: 'other' };
    }
    if (opened.size > maxBytes) {
      return { kind: 'file', size: opened.size, executable, content: null };
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) {
      return { kind: 'file', size: length, executable, content: null };
    }
    if ((await parentInside()) !== true) {
      return { kind: 'outside_worktree' };
    }
    return { kind: 'file', size: length, executable, content: buffer.subarray(0, length) };
  } finally {
    await handle.close();
  }
};

/** Git's heuristic: content with a NUL byte in the first 8000 bytes is binary. */
export const looksBinary = (content: Buffer): boolean => content.subarray(0, 8000).includes(0);

/** Decodes UTF-8 strictly; returns `null` for invalid sequences instead of replacing them. */
export const decodeUtf8 = (content: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
};

/** Number of lines as Git counts them (a final line without a newline still counts). */
export const countLines = (content: Buffer): number => {
  if (content.length === 0) return 0;
  let lines = 0;
  for (const byte of content) {
    if (byte === 0x0a) lines += 1;
  }
  return content[content.length - 1] === 0x0a ? lines : lines + 1;
};

const escapes: Record<number, string> = {
  0x07: '\\a',
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0b: '\\v',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
};

/** Quotes a path like Git with `core.quotePath=true` (C-style, octal for non-ASCII bytes). */
export const quoteGitPath = (path: string): string => {
  const bytes = Buffer.from(path, 'utf8');
  if (!bytes.some((byte) => byte < 0x20 || byte >= 0x7f || byte === 0x22 || byte === 0x5c)) {
    return path;
  }
  let quoted = '"';
  for (const byte of bytes) {
    const escape = escapes[byte];
    if (escape !== undefined) quoted += escape;
    else if (byte < 0x20 || byte >= 0x7f) quoted += `\\${byte.toString(8).padStart(3, '0')}`;
    else quoted += String.fromCharCode(byte);
  }
  return `${quoted}"`;
};

/**
 * Formats a new-file patch the way `git diff` would for an added file, without staging it.
 * `text` is the decoded file content or symlink target.
 */
export const formatNewFilePatch = (path: string, mode: string, text: string): string => {
  const header = [
    `diff --git ${quoteGitPath(`a/${path}`)} ${quoteGitPath(`b/${path}`)}`,
    `new file mode ${mode}`,
  ];
  if (text === '') {
    return `${header.join('\n')}\n`;
  }
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  const range = lines.length === 1 ? '+1' : `+1,${lines.length}`;
  const body = [
    ...header,
    '--- /dev/null',
    `+++ ${quoteGitPath(`b/${path}`)}`,
    `@@ -0,0 ${range} @@`,
    ...lines.map((line) => `+${line}`),
  ];
  if (!endsWithNewline) {
    body.push('\\ No newline at end of file');
  }
  return `${body.join('\n')}\n`;
};
