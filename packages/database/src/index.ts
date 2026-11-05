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
  deleteProject,
  findProjectById,
  findProjectByRepository,
  insertProject,
  listProjects,
  ProjectConflictError,
  ProjectHasDependentsError,
  updateProject,
  type NewProjectRecord,
  type ProjectDependent,
  type ProjectRecord,
  type ProjectSettingsUpdate,
} from './projects.js';
export { projects, schema, tasks } from './schema.js';
export {
  countTasksByProjectAndStatus,
  createTask,
  findTaskById,
  listProjectTasks,
  transitionTask,
  updateTask,
  type ProjectTaskStatusCount,
  type TaskRecord,
} from './tasks.js';
