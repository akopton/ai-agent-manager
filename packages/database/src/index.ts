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
export {
  findProjectById,
  findProjectByRepository,
  insertProject,
  listProjects,
  ProjectConflictError,
  type NewProjectRecord,
  type ProjectRecord,
} from './projects.js';
export { projects, schema } from './schema.js';
