import { randomUUID } from 'node:crypto';
import {
  assessTaskArchive,
  projectIdSchema,
  TaskError,
  WorkspaceCleanupError,
  type RequestWorkspaceCleanupInput,
  type Task,
} from '@ai-agent-manager/core';
import {
  archiveTask,
  assessTaskWorkspaceCleanup,
  findProjectById,
  findTaskById,
  findWorkspace,
  listTaskPublications,
  listTaskRuns,
  listTaskWorkspaceCleanups,
  listTaskWorkspaces,
  readTaskArchiveFacts,
  findWorkspaceCleanupByRequest,
  requestWorkspaceCleanup,
  restoreTask,
  type DatabaseConnection,
  type ProjectRecordWithTrust,
  type TaskRecord,
  type WorkspaceCleanupRecord,
  type WorkspaceRecord,
} from '@ai-agent-manager/database';
import { inspectWorktreeForCleanup, validateRepository } from '@ai-agent-manager/git';
import type {
  TaskArchiveOption,
  WorkspaceCleanupView,
  WorkspacePanel,
} from '@/lib/tasks/workspace';

// Managed workspace inventory, Remove local worktree and Archive/Restore (TM-02) for the web app.
// The web process only reads Git (through `inspectWorktreeForCleanup`: registration, lock, branch,
// HEAD, working tree and ignored files of the **recorded** worktree path) and writes database
// records. It never removes, unlocks, cleans or prunes anything: a confirmed removal is recorded as
// `requested`, and the worker re-verifies everything before it removes the worktree.

type Database = DatabaseConnection['db'];

const requireProjectTask = (
  db: Database,
  projectId: string,
  taskId: string,
): { project: ProjectRecordWithTrust; task: TaskRecord } => {
  const parsed = projectIdSchema.safeParse(projectId);
  const project = parsed.success ? findProjectById(db, parsed.data) : undefined;
  if (project === undefined) {
    throw new TaskError('project_not_found', 'The project does not exist.');
  }
  const task = findTaskById(db, taskId);
  if (task === undefined || task.projectId !== project.id) {
    throw new TaskError('task_not_found', 'The task does not exist.');
  }
  return { project, task };
};

const toCleanupView = (record: WorkspaceCleanupRecord): WorkspaceCleanupView => ({
  id: record.id,
  status: record.status,
  basis: record.basis,
  expectedCommit: record.expectedCommit,
  branchCommit: record.branchCommit,
  errorCode: record.errorCode,
  errorMessage: record.errorMessage,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  removedAt: record.removedAt,
});

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The workspace the latest run used, else the newest workspace record of the task. */
const currentWorkspace = (db: Database, task: TaskRecord): WorkspaceRecord | undefined => {
  const [latest] = listTaskRuns(db, task.id);
  const recorded =
    latest?.workspaceId === undefined || latest.workspaceId === null
      ? undefined
      : findWorkspace(db, latest.workspaceId);
  return recorded ?? listTaskWorkspaces(db, task.id)[0];
};

/** The commit Approve & Push moved the task branch to, if a publication of this workspace did. */
const branchCommitFromPublications = (
  db: Database,
  taskId: string,
  workspaceId: string,
): string | null =>
  listTaskPublications(db, taskId).find(
    (publication) =>
      publication.workspaceId === workspaceId &&
      publication.commitSha !== null &&
      (['committed', 'push_requested', 'pushing', 'pushed'].includes(publication.status) ||
        (publication.status === 'failed' && publication.failureStage === 'push')),
  )?.commitSha ?? null;

/** Registered repository identity, checked read-only before any worktree inspection. */
const repositoryMatches = async (project: ProjectRecordWithTrust): Promise<boolean> => {
  const validation = await validateRepository(project.localPath);
  return (
    validation.valid &&
    validation.repository.root === project.localPath &&
    validation.repository.commonDir === project.gitCommonDir
  );
};

/**
 * The managed workspace panel of a task: its recorded worktree, what Git reports about it now, and
 * whether Remove local worktree is available (with every reason when it is not). Read-only.
 */
export const getTaskWorkspacePanel = async (
  db: Database,
  projectId: string,
  taskId: string,
): Promise<WorkspacePanel> => {
  const { project, task } = requireProjectTask(db, projectId, taskId);
  const history = listTaskWorkspaceCleanups(db, task.id);
  const workspace = currentWorkspace(db, task);
  const unavailable = (reasons: string[]) => ({
    available: false,
    expectedCommit: null,
    basis: null,
    reasons,
  });
  if (workspace === undefined) {
    return {
      state: 'none',
      workspace: null,
      git: null,
      cleanup: unavailable(['This task has no worktree.']),
      current: null,
      history: [],
    };
  }
  const workspaceHistory = history.filter((row) => row.workspaceId === workspace.id);
  const [current] = workspaceHistory;
  const view = {
    workspace: {
      id: workspace.id,
      path: workspace.path,
      branch: workspace.branch,
      baseBranch: workspace.baseBranch,
      baseSha: workspace.baseSha,
      createdAt: workspace.createdAt,
    },
    current: current === undefined ? null : toCleanupView(current),
    history: workspaceHistory.map(toCleanupView),
  };
  if (current?.status === 'removed') {
    // Nothing to inspect: the directory is gone by our own recorded action.
    return {
      ...view,
      state: 'removed',
      git: null,
      cleanup: unavailable(['The local worktree was already removed.']),
    };
  }

  const assessment = assessTaskWorkspaceCleanup(db, task, workspace);
  // Where the task branch should be now, so the identity line is meaningful even when removal is
  // unavailable: a pending removal's commit, else the eligible commit, else a commit Approve & Push
  // put on the branch, else the base commit.
  const expectedCommit =
    (current !== undefined && current.status !== 'failed' ? current.expectedCommit : null) ??
    (assessment.ok ? assessment.expectedCommit : null) ??
    branchCommitFromPublications(db, task.id, workspace.id) ??
    workspace.baseSha;
  if (!(await repositoryMatches(project))) {
    return {
      ...view,
      state: 'unavailable',
      git: null,
      cleanup: unavailable([
        ...(assessment.ok ? [] : [assessment.message]),
        'The repository at the registered path is missing or is a different repository.',
      ]),
    };
  }
  const inspection = await inspectWorktreeForCleanup({
    repository: project,
    taskId: task.id,
    workspace,
    // The recorded root; the worker additionally requires it to be its configured root.
    worktreeRoot: workspace.worktreeRoot,
    expectedCommit,
  });
  const reasons = [
    ...(assessment.ok ? [] : [assessment.message]),
    // Git-level blockers only matter (and only make sense) once the records allow removal.
    ...(assessment.ok ? inspection.blockers.map((reason) => `${capitalize(reason)}.`) : []),
  ];
  return {
    ...view,
    state:
      inspection.presence === 'present'
        ? 'retained'
        : inspection.presence === 'missing'
          ? 'missing'
          : inspection.presence,
    git: {
      registered: inspection.registered,
      pathExists: inspection.pathExists,
      locked: inspection.locked,
      managedLock: inspection.managedLock,
      branchCommit: inspection.branchCommit,
      headCommit: inspection.headCommit,
      identityVerified: inspection.identity.ok,
      identityReason: inspection.identity.ok ? null : inspection.identity.reason,
      workingTree: inspection.workingTree,
      ignoredCount: inspection.ignoredCount,
    },
    cleanup:
      reasons.length === 0 && assessment.ok
        ? {
            available: true,
            expectedCommit: assessment.expectedCommit,
            basis: assessment.basis,
            reasons: [],
          }
        : unavailable(reasons),
  };
};

export type WorkspaceServiceOptions = { now?: () => number; createId?: () => string };

/**
 * Records a confirmed Remove local worktree request after re-checking the task's records and the
 * worktree's Git state read-only. Nothing is removed here; the worker executes the request after
 * verifying everything again. A repeated `requestId` returns the existing request.
 */
export const requestTaskWorkspaceCleanup = async (
  db: Database,
  projectId: string,
  taskId: string,
  input: RequestWorkspaceCleanupInput,
  { now = Date.now, createId = randomUUID }: WorkspaceServiceOptions = {},
): Promise<WorkspaceCleanupView> => {
  const { project, task } = requireProjectTask(db, projectId, taskId);
  const repeated = findWorkspaceCleanupByRequest(db, input.requestId);
  if (repeated !== undefined) {
    if (repeated.taskId !== task.id || repeated.workspaceId !== input.workspaceId) {
      throw new WorkspaceCleanupError(
        'invalid_cleanup_input',
        'This request ID was already used for another worktree.',
      );
    }
    return toCleanupView(repeated);
  }
  const workspace = findWorkspace(db, input.workspaceId);
  if (workspace === undefined || workspace.taskId !== task.id) {
    throw new WorkspaceCleanupError(
      'workspace_not_found',
      'The worktree record does not exist for this task.',
    );
  }
  const assessment = assessTaskWorkspaceCleanup(db, task, workspace);
  if (!assessment.ok) {
    throw assessment.code === 'cleanup_in_progress'
      ? new WorkspaceCleanupError(
          'cleanup_already_requested',
          'Removal of this worktree was already requested. Reload the page.',
        )
      : new WorkspaceCleanupError('cleanup_not_available', assessment.message, {
          reason: assessment.code,
        });
  }
  if (assessment.expectedCommit !== input.expectedCommit) {
    throw new WorkspaceCleanupError(
      'cleanup_state_changed',
      'The task’s published or base commit is not the one you saw. Reload the page.',
    );
  }
  if (!(await repositoryMatches(project))) {
    throw new WorkspaceCleanupError(
      'worktree_not_removable',
      'The repository at the registered path is missing or is a different repository. Nothing was removed.',
    );
  }
  const inspection = await inspectWorktreeForCleanup({
    repository: project,
    taskId: task.id,
    workspace,
    worktreeRoot: workspace.worktreeRoot,
    expectedCommit: assessment.expectedCommit,
  });
  if (inspection.blockers.length > 0) {
    throw new WorkspaceCleanupError(
      'worktree_not_removable',
      `The worktree cannot be removed safely: ${inspection.blockers.join('; ')}. Nothing was removed.`,
      { blockers: inspection.blockers },
    );
  }
  const { cleanup } = requestWorkspaceCleanup(db, {
    id: createId(),
    taskId: task.id,
    input,
    now: now(),
  });
  return toCleanupView(cleanup);
};

/** Whether the task can be archived (or is archived), from its records. Read-only. */
export const getTaskArchiveOption = (
  db: Database,
  task: Pick<Task, 'id' | 'status' | 'archivedAt'>,
): TaskArchiveOption => {
  if (task.archivedAt !== null) return { archived: true, available: false, reason: null };
  const assessment = assessTaskArchive(readTaskArchiveFacts(db, task));
  return {
    archived: false,
    available: assessment.ok,
    reason: assessment.ok ? null : assessment.reason,
  };
};

/** Archive options for board tasks, keyed by task ID. */
export const getBoardArchiveOptions = (
  db: Database,
  tasks: readonly Pick<Task, 'id' | 'status' | 'archivedAt'>[],
): Record<string, TaskArchiveOption> =>
  Object.fromEntries(tasks.map((task) => [task.id, getTaskArchiveOption(db, task)]));

/** Archives a task of this project. Changes only its visibility. */
export const archiveProjectTask = (
  db: Database,
  projectId: string,
  taskId: string,
  { now = Date.now }: Pick<WorkspaceServiceOptions, 'now'> = {},
): Task => {
  const { task } = requireProjectTask(db, projectId, taskId);
  return { ...archiveTask(db, { taskId: task.id, now: now() }) };
};

/** Restores an archived task of this project to the board with its original status. */
export const restoreProjectTask = (db: Database, projectId: string, taskId: string): Task => {
  const { task } = requireProjectTask(db, projectId, taskId);
  return { ...restoreTask(db, { taskId: task.id }) };
};
