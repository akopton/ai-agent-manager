import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimePaths } from '@ai-agent-manager/database';

/** Raised when a harness path is unsafe; the harness then creates or removes nothing. */
export class DiagnosticsPathError extends Error {
  override name = 'DiagnosticsPathError';
}

/** True when `child` is `parent` itself or inside it. */
export const isWithin = (parent: string, child: string): boolean => {
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
};

export const overlaps = (first: string, second: string): boolean =>
  isWithin(first, second) || isWithin(second, first);

/** A location the harness must never create fixtures in, contain, or delete. */
export type ProtectedRoot = { label: string; path: string };

/** The AI Agent Manager source checkout containing this package (never a test target). */
export const sourceRepositoryRoot = (): string =>
  fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

const canonicalOrSelf = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/**
 * Roots fixtures must not overlap: the application's real data and worktree roots (resolved from
 * the same configuration the worker uses), the AI Agent Manager source checkout, and the home
 * directory itself. Resolution failures are fatal: the harness fails closed.
 */
export const defaultProtectedRoots = async (
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProtectedRoot[]> => {
  const runtimePaths = resolveRuntimePaths({ environment });
  const roots: ProtectedRoot[] = [
    { label: 'application data root', path: runtimePaths.dataRoot },
    { label: 'application worktree root', path: runtimePaths.worktreeRoot },
    { label: 'application database directory', path: dirname(runtimePaths.databasePath) },
    { label: 'AI Agent Manager source repository', path: sourceRepositoryRoot() },
  ];
  const canonical = await Promise.all(
    roots.map(async (root) => ({ ...root, path: await canonicalOrSelf(root.path) })),
  );
  return canonical;
};

/**
 * Throws unless `path` (a canonical directory the harness wants to create or delete) is safe:
 * not overlapping any protected root, not the home directory or one of its parents, and not inside
 * an existing Git repository or worktree (checked by looking for `.git` entries upwards).
 */
export const assertSafeHarnessLocation = async (
  path: string,
  protectedRoots: readonly ProtectedRoot[],
): Promise<void> => {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new DiagnosticsPathError(`${path} must be an absolute path.`);
  }
  for (const root of protectedRoots) {
    if (overlaps(root.path, path)) {
      throw new DiagnosticsPathError(`${path} overlaps the ${root.label} (${root.path}).`);
    }
  }
  const home = await canonicalOrSelf(homedir());
  if (isWithin(path, home)) {
    throw new DiagnosticsPathError(`${path} is the home directory or one of its parents.`);
  }
  for (let current = dirname(path); ; current = dirname(current)) {
    const marker = await lstat(join(current, '.git')).catch(() => null);
    if (marker !== null) {
      throw new DiagnosticsPathError(
        `${path} is inside a Git repository or worktree (${current}).`,
      );
    }
    if (dirname(current) === current) {
      break;
    }
  }
};
