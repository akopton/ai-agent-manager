import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import {
  projectIdSchema,
  type Project,
  type ProjectRegistrationErrorCode,
  type RegisterProjectRequest,
} from '@ai-agent-manager/core';
import {
  findProjectById,
  findProjectByRepository,
  insertProject,
  listProjects as listProjectRecords,
  ProjectConflictError,
  type DatabaseConnection,
  type ProjectRecord,
} from '@ai-agent-manager/database';
import {
  GitCommandError,
  inspectRepository,
  type GitRemote,
  type RepositoryInspection,
  type WorkingTreeStatus,
} from '@ai-agent-manager/git';
import type {
  ProjectDetails,
  RemoteView,
  RepositoryPreview,
  RepositoryState,
  WorkingTreeSummary,
} from '@/lib/projects/contracts';

// Project registration composes read-only Git inspection with the project table. Nothing here
// writes to the repository: inspection runs only read-only Git queries (see packages/git).

type Database = DatabaseConnection['db'];

export type ProjectServiceErrorCode = ProjectRegistrationErrorCode | 'repository_inspection_failed';

export class ProjectServiceError extends Error {
  override name = 'ProjectServiceError';

  constructor(
    readonly code: ProjectServiceErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type ValidInspection = Extract<RepositoryInspection, { valid: true }>;
type InvalidInspection = Extract<RepositoryInspection, { valid: false }>;

const absolutePathExample = '~/repos/my-project';

/** Expands a leading `~` to the current user's home directory; any other path must be absolute. */
const resolveInputPath = (input: string): string => {
  const expanded =
    input === '~' ? homedir() : input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
  if (!isAbsolute(expanded)) {
    throw new ProjectServiceError(
      'invalid_path',
      `Enter an absolute path, for example ${absolutePathExample}.`,
    );
  }
  return expanded;
};

const invalidRepositoryError = (inspection: InvalidInspection): ProjectServiceError => {
  switch (inspection.reason) {
    case 'invalid_path':
      return new ProjectServiceError(
        'invalid_path',
        `Enter an absolute path, for example ${absolutePathExample}.`,
      );
    case 'not_found':
      return new ProjectServiceError(
        'path_not_found',
        'Nothing exists at this path. Check the spelling and try again.',
      );
    case 'not_directory':
      return new ProjectServiceError(
        'not_a_directory',
        'The path points to a file. Enter the repository folder instead.',
      );
    case 'not_git_repository':
      return new ProjectServiceError(
        'not_git_repository',
        'This folder is not a Git repository. Choose the folder that contains the repository’s .git directory.',
      );
    case 'bare_repository':
      return new ProjectServiceError(
        'bare_repository',
        'This is a bare repository without a working tree. Register a regular clone instead.',
      );
    case 'inside_git_directory':
      return new ProjectServiceError(
        'inside_git_directory',
        'The path is inside Git metadata (.git). Choose the repository’s working folder instead.',
      );
    case 'not_repository_root':
      return new ProjectServiceError(
        'not_repository_root',
        'The path is inside a Git repository but is not its root folder. Register the repository root instead.',
        inspection.root === undefined ? undefined : { root: inspection.root },
      );
    case 'unsafe_ownership':
      return new ProjectServiceError(
        'unsafe_ownership',
        'Git refused to open this repository because it is owned by another user. Register a repository owned by your account.',
      );
  }
};

const hasErrorCode = (error: unknown, codes: readonly string[]): boolean =>
  error instanceof Error && 'code' in error && codes.includes(String(error.code));

/** Runs read-only inspection and converts expected failures into actionable service errors. */
const inspect = async (path: string): Promise<RepositoryInspection> => {
  try {
    return await inspectRepository(path);
  } catch (error) {
    if (hasErrorCode(error, ['EACCES', 'EPERM'])) {
      throw new ProjectServiceError(
        'path_not_accessible',
        'The application does not have permission to read this path. Check the folder permissions and try again.',
      );
    }
    if (error instanceof GitCommandError) {
      throw new ProjectServiceError(
        'repository_inspection_failed',
        error.code === 'GIT_UNAVAILABLE'
          ? 'Git could not be started. Make sure Git 2.36 or newer is installed and available on PATH.'
          : 'Git could not inspect the repository. Check that it is not corrupted and try again.',
        { gitErrorCode: error.code },
      );
    }
    throw error;
  }
};

/** Inspects a user-supplied path and checks that it can be registered as a project. */
const inspectEligibleRepository = async (input: string): Promise<ValidInspection> => {
  const inspection = await inspect(resolveInputPath(input));
  if (!inspection.valid) {
    throw invalidRepositoryError(inspection);
  }
  if (inspection.repository.isLinkedWorktree) {
    throw new ProjectServiceError(
      'linked_worktree',
      'This folder is a linked Git worktree. Register the repository’s main checkout instead.',
    );
  }
  if (inspection.branches.length === 0) {
    throw new ProjectServiceError(
      'no_local_branches',
      'The repository has no local branches yet. Create an initial commit, then add the project again.',
    );
  }
  return inspection;
};

const summarizeWorkingTree = (status: WorkingTreeStatus): WorkingTreeSummary => ({
  isClean: status.isClean,
  staged: status.staged.length,
  unstaged: status.unstaged.length,
  untracked: status.untracked.length,
  conflicted: status.conflicted.length,
});

const toRemoteView = ({ name, fetchUrls }: GitRemote): RemoteView => ({
  name,
  fetchUrl: fetchUrls[0] ?? null,
});

const suggestBaseBranch = ({ head, branches }: ValidInspection): string => {
  const names = branches.map(({ name }) => name);
  if (head.kind !== 'detached' && names.includes(head.branch)) {
    return head.branch;
  }
  return ['main', 'master'].find((name) => names.includes(name)) ?? names[0] ?? '';
};

const suggestRemoteName = ({ remotes }: ValidInspection): string | null =>
  remotes.find(({ name }) => name === 'origin')?.name ?? remotes[0]?.name ?? null;

const repositoryIdentity = ({ repository }: ValidInspection) => ({
  localPath: repository.root,
  gitCommonDir: repository.commonDir,
});

const toProject = (record: ProjectRecord): Project => ({ ...record });

export const listProjects = (db: Database): Project[] => listProjectRecords(db).map(toProject);

/**
 * Validates a path and describes the repository that would be registered. Read-only for both the
 * repository and the database. An already registered repository is reported, not rejected.
 */
export const previewProject = async (db: Database, path: string): Promise<RepositoryPreview> => {
  const inspection = await inspectEligibleRepository(path);
  const existing = findProjectByRepository(db, repositoryIdentity(inspection));
  return {
    path: inspection.repository.root,
    gitCommonDir: inspection.repository.commonDir,
    suggestedName: basename(inspection.repository.root),
    head: inspection.head,
    branches: inspection.branches.map(({ name }) => name),
    remotes: inspection.remotes.map(toRemoteView),
    suggestedBaseBranch: suggestBaseBranch(inspection),
    suggestedRemoteName: suggestRemoteName(inspection),
    workingTree: summarizeWorkingTree(inspection.workingTree),
    existingProject: existing === undefined ? null : { id: existing.id, name: existing.name },
  };
};

const duplicateError = (existing: ProjectRecord): ProjectServiceError =>
  new ProjectServiceError(
    'project_already_registered',
    `This repository is already registered as “${existing.name}”.`,
    { projectId: existing.id, projectName: existing.name },
  );

export type RegisterProjectOptions = {
  now?: () => number;
  createId?: () => string;
};

/**
 * Registers a repository. The path is inspected again rather than trusting an earlier preview, and
 * only the canonical root and common Git directory are stored. The repository is never modified.
 */
export const registerProject = async (
  db: Database,
  request: RegisterProjectRequest,
  { now = Date.now, createId = randomUUID }: RegisterProjectOptions = {},
): Promise<Project> => {
  const inspection = await inspectEligibleRepository(request.path);
  if (!inspection.branches.some(({ name }) => name === request.defaultBaseBranch)) {
    throw new ProjectServiceError(
      'base_branch_not_found',
      `The branch “${request.defaultBaseBranch}” does not exist locally in this repository. Choose an existing branch.`,
    );
  }
  if (
    request.remoteName !== null &&
    !inspection.remotes.some(({ name }) => name === request.remoteName)
  ) {
    throw new ProjectServiceError(
      'remote_not_found',
      `The remote “${request.remoteName}” is not configured in this repository. Choose an existing remote or no remote.`,
    );
  }

  const identity = repositoryIdentity(inspection);
  const existing = findProjectByRepository(db, identity);
  if (existing !== undefined) {
    throw duplicateError(existing);
  }

  const timestamp = now();
  try {
    return toProject(
      insertProject(db, {
        id: createId(),
        name: request.name,
        ...identity,
        remoteName: request.remoteName,
        defaultBaseBranch: request.defaultBaseBranch,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
  } catch (error) {
    // Another request registered the same repository between the check and the insert.
    const concurrent =
      error instanceof ProjectConflictError && findProjectByRepository(db, identity);
    if (concurrent) {
      throw duplicateError(concurrent);
    }
    throw error;
  }
};

/** Inspects the stored canonical path (never a browser-supplied one) for the details view. */
const inspectRegisteredRepository = async (record: ProjectRecord): Promise<RepositoryState> => {
  let inspection: RepositoryInspection;
  try {
    inspection = await inspect(record.localPath);
  } catch (error) {
    if (error instanceof ProjectServiceError) {
      return error.code === 'path_not_accessible'
        ? { status: 'unavailable', code: error.code, message: error.message }
        : { status: 'inspection_failed', message: error.message };
    }
    throw error;
  }

  if (!inspection.valid) {
    const error = invalidRepositoryError(inspection);
    return {
      status: 'unavailable',
      code: error.code,
      message: `The repository is no longer available at its registered path. ${error.message}`,
    };
  }
  if (
    inspection.repository.root !== record.localPath ||
    inspection.repository.commonDir !== record.gitCommonDir
  ) {
    return {
      status: 'identity_changed',
      message:
        'A different Git repository now exists at the registered path. Repository information is hidden until this is resolved.',
    };
  }
  return {
    status: 'available',
    head: inspection.head,
    branches: inspection.branches.map(({ name }) => name),
    remotes: inspection.remotes.map(toRemoteView),
    workingTree: summarizeWorkingTree(inspection.workingTree),
    baseBranchExists: inspection.branches.some(({ name }) => name === record.defaultBaseBranch),
    remoteExists:
      record.remoteName !== null &&
      inspection.remotes.some(({ name }) => name === record.remoteName),
  };
};

/** Returns the project with live, read-only repository information, or `undefined` if unknown. */
export const getProjectDetails = async (
  db: Database,
  id: string,
): Promise<ProjectDetails | undefined> => {
  const parsedId = projectIdSchema.safeParse(id);
  if (!parsedId.success) {
    return undefined;
  }
  const record = findProjectById(db, parsedId.data);
  if (record === undefined) {
    return undefined;
  }
  return { project: toProject(record), repository: await inspectRegisteredRepository(record) };
};
