export { createDatabase, type DatabaseConnection } from './client.js';
export {
  defaultDataRoot,
  resolveDataRoot,
  resolveDatabasePath,
  resolveRuntimePaths,
  resolveWorktreeRoot,
  RuntimeConfigError,
  runtimeEnvironmentVariables,
  type ResolveRuntimePathsOptions,
  type RuntimeEnvironment,
  type RuntimePaths,
} from './config.js';
export {
  ensureDirectory,
  ensureWorktreeRoot,
  initializeDataRoot,
  type DirectoryResult,
} from './directories.js';
export { applyMigrations } from './migrations.js';
