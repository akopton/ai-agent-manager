import { mkdirSync, statSync } from 'node:fs';
import type { RuntimePaths } from './config.js';

export type DirectoryResult = { path: string; created: boolean };

/**
 * Creates a private directory (and missing parents) if needed. Never removes, empties, or changes
 * the permissions of an existing directory. Fails if a non-directory occupies the path.
 */
export const ensureDirectory = (path: string): DirectoryResult => {
  const firstCreated = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!statSync(path).isDirectory()) {
    throw new Error(`Expected a directory at ${path}.`);
  }
  return { path, created: firstCreated !== undefined };
};

/** Explicitly creates the application data root. Nothing is created on import. */
export const initializeDataRoot = (paths: Pick<RuntimePaths, 'dataRoot'>): DirectoryResult =>
  ensureDirectory(paths.dataRoot);

/** Creates the managed worktree root. Call only when a worktree is about to be created. */
export const ensureWorktreeRoot = (paths: Pick<RuntimePaths, 'worktreeRoot'>): DirectoryResult =>
  ensureDirectory(paths.worktreeRoot);
