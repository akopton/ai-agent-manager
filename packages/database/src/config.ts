import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

export const runtimeEnvironmentVariables = {
  dataRoot: 'AI_AGENT_MANAGER_DATA_ROOT',
  databasePath: 'AI_AGENT_MANAGER_DATABASE_PATH',
  worktreeRoot: 'AI_AGENT_MANAGER_WORKTREE_ROOT',
} as const;

export type RuntimeEnvironment = Record<string, string | undefined>;

export type RuntimePaths = {
  /** Application data directory. */
  dataRoot: string;
  /** SQLite database file. */
  databasePath: string;
  /** Managed root for future per-task Git worktrees. Not created during resolution. */
  worktreeRoot: string;
};

export type ResolveRuntimePathsOptions = {
  environment?: RuntimeEnvironment;
  /** Defaults to the current user's home directory. */
  homeDirectory?: string;
};

export class RuntimeConfigError extends Error {
  override name = 'RuntimeConfigError';
}

const databaseFileName = 'database.sqlite';
const worktreeDirectoryName = 'worktrees';

const configuredPathSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .refine((value) => !value.includes('\0'), { message: 'must not contain null bytes' });

/** True when `ancestor` is `path` itself or one of its parent directories. */
const containsPath = (ancestor: string, path: string): boolean => {
  const difference = relative(ancestor, path);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
};

const resolveHomeDirectory = (homeDirectory: string): string => {
  if (!isAbsolute(homeDirectory)) {
    throw new RuntimeConfigError('The home directory could not be resolved to an absolute path.');
  }
  return resolve(homeDirectory);
};

const parseConfiguredPath = (
  name: string,
  value: string | undefined,
  homeDirectory: string,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = configuredPathSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeConfigError(`${name} ${parsed.error.issues[0]?.message ?? 'is invalid'}.`);
  }
  const expanded = parsed.data.startsWith('~/')
    ? join(homeDirectory, parsed.data.slice(2))
    : parsed.data;
  if (!isAbsolute(expanded)) {
    throw new RuntimeConfigError(`${name} must be an absolute path or start with "~/".`);
  }
  return resolve(expanded);
};

/** Managed directory roots must never be the home directory, the filesystem root, or above them. */
const assertManagedDirectory = (name: string, path: string, homeDirectory: string): void => {
  if (containsPath(path, homeDirectory)) {
    throw new RuntimeConfigError(
      `${name} must not be the home directory, the filesystem root, or one of their parents.`,
    );
  }
};

export const defaultDataRoot = (homeDirectory: string = homedir()): string =>
  join(resolveHomeDirectory(homeDirectory), 'Library', 'Application Support', 'ai-agent-manager');

export const resolveDataRoot = (
  environment: RuntimeEnvironment = process.env,
  homeDirectory: string = homedir(),
): string => {
  const home = resolveHomeDirectory(homeDirectory);
  const name = runtimeEnvironmentVariables.dataRoot;
  const configured = parseConfiguredPath(name, environment[name], home);
  if (configured === undefined) {
    return defaultDataRoot(home);
  }
  assertManagedDirectory(name, configured, home);
  return configured;
};

/**
 * Resolves the SQLite file: `AI_AGENT_MANAGER_DATABASE_PATH`, otherwise `database.sqlite` in the
 * data root. Performs no I/O.
 */
export const resolveDatabasePath = (
  environment: RuntimeEnvironment = process.env,
  homeDirectory: string = homedir(),
): string => {
  const home = resolveHomeDirectory(homeDirectory);
  const configured = parseConfiguredPath(
    runtimeEnvironmentVariables.databasePath,
    environment[runtimeEnvironmentVariables.databasePath],
    home,
  );
  return configured ?? join(resolveDataRoot(environment, home), databaseFileName);
};

export const resolveWorktreeRoot = (
  environment: RuntimeEnvironment = process.env,
  homeDirectory: string = homedir(),
): string => {
  const home = resolveHomeDirectory(homeDirectory);
  const name = runtimeEnvironmentVariables.worktreeRoot;
  const configured = parseConfiguredPath(name, environment[name], home);
  if (configured === undefined) {
    return join(resolveDataRoot(environment, home), worktreeDirectoryName);
  }
  assertManagedDirectory(name, configured, home);
  return configured;
};

/**
 * Resolves and validates every runtime path without touching the filesystem. Call this before any
 * side effect so invalid configuration fails fast.
 */
export const resolveRuntimePaths = ({
  environment = process.env,
  homeDirectory = homedir(),
}: ResolveRuntimePathsOptions = {}): RuntimePaths => {
  const dataRoot = resolveDataRoot(environment, homeDirectory);
  const databasePath = resolveDatabasePath(environment, homeDirectory);
  const worktreeRoot = resolveWorktreeRoot(environment, homeDirectory);

  // Agents write inside worktrees, so they must not be able to reach application data.
  if (containsPath(worktreeRoot, dataRoot)) {
    throw new RuntimeConfigError(
      `${runtimeEnvironmentVariables.worktreeRoot} must not be the data root or one of its parents.`,
    );
  }
  if (containsPath(worktreeRoot, databasePath)) {
    throw new RuntimeConfigError(
      `${runtimeEnvironmentVariables.databasePath} must not be inside the worktree root.`,
    );
  }
  return Object.freeze({ dataRoot, databasePath, worktreeRoot });
};
