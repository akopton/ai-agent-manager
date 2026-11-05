import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import {
  ExecutionError,
  isActiveTaskRunStatus,
  projectIdSchema,
  ReviewActionError,
  type RequestChangesInput,
  type TaskRunStatus,
} from '@ai-agent-manager/core';
import {
  findProjectById,
  findTaskById,
  findWorkspace,
  listTaskRuns,
  requestTaskChanges,
  type DatabaseConnection,
  type ProjectRecordWithTrust,
  type TaskRecord,
  type TaskRunRecord,
  type WorkspaceRecord,
} from '@ai-agent-manager/database';
import {
  defaultTaskBranchName,
  getTaskFileDiff,
  GitCommandError,
  GitInputError,
  inspectTaskChanges,
  TaskWorktreeError,
  validateRepository,
  type TaskChangesOptions,
} from '@ai-agent-manager/git';
import type { TaskRunView } from '@/lib/execution/contracts';
import type {
  FileDiffView,
  RequestChangesResponse,
  ReviewBlockReason,
  ReviewChanges,
  TaskReviewView,
} from '@/lib/review/contracts';
import { ReviewError } from '@/lib/review/errors';
import { listReviewDecisionViews, toRunView } from '@/lib/server/execution';
import { getPublicationPanel } from '@/lib/server/publication-view';

// Review Changes (M6-01, first slice) and Request Changes (M6-02). Inspection only reads: the database, the
// registered repository's identity and the task worktree, through the hardened inspection
// utilities of `packages/git` (plumbing commands, no index refresh, no external diff drivers or
// textconv, inventory-only file access). Nothing stages, commits, resets, cleans, pushes, locks or
// writes, and no agent is started. Every filesystem location comes from the database records of
// the task's latest run, never from the request: a browser-supplied path is only ever matched
// against the change inventory of the verified worktree. `requestChangesForTask` writes only a
// database record (the feedback and the named `request_changes` transition); it starts no agent.

type Database = DatabaseConnection['db'];

const fullShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type ReviewContext = {
  project: ProjectRecordWithTrust;
  task: TaskRecord;
  run: TaskRunRecord | null;
  workspace: WorkspaceRecord | null;
  /** Every run of the task, newest attempt first. */
  runs: TaskRunRecord[];
};

/** Resolves the task within its project, then its latest run and that run's workspace. */
const loadContext = (db: Database, projectId: string, taskId: string): ReviewContext => {
  const parsedProject = projectIdSchema.safeParse(projectId);
  const project = parsedProject.success ? findProjectById(db, parsedProject.data) : undefined;
  if (project === undefined) {
    throw new ExecutionError('project_not_found', 'The project does not exist.');
  }
  const task = findTaskById(db, taskId);
  if (task === undefined || task.projectId !== project.id) {
    throw new ExecutionError('task_not_found', 'The task does not exist.');
  }
  const runs = listTaskRuns(db, task.id);
  const [run] = runs;
  const workspace =
    run?.workspaceId === undefined || run.workspaceId === null
      ? undefined
      : findWorkspace(db, run.workspaceId);
  return { project, task, run: run ?? null, workspace: workspace ?? null, runs };
};

type ReviewTarget = ReviewContext & { run: TaskRunRecord; workspace: WorkspaceRecord };

/** The latest run must be finished and must have recorded a workspace. */
const requireTarget = (context: ReviewContext): ReviewTarget => {
  const { run, workspace } = context;
  if (run === null) {
    throw new ReviewError('review_unavailable', 'This task has not run yet.', {
      reason: 'no_run',
    });
  }
  if (isActiveTaskRunStatus(run.status)) {
    throw new ReviewError(
      'review_unavailable',
      'The agent is still running. Changes can be reviewed after the run ends.',
      { reason: 'run_active' },
    );
  }
  if (workspace === null) {
    throw new ReviewError(
      'review_unavailable',
      'The latest run ended before a task worktree was created, so there are no changes to review.',
      { reason: 'no_workspace' },
    );
  }
  return { ...context, run, workspace };
};

const isStrictlyWithin = (parent: string, child: string): boolean =>
  child.startsWith(`${parent}/`) &&
  !child
    .slice(parent.length + 1)
    .split('/')
    .includes('..');

/**
 * Checks the stored workspace record against the task, the registered project and the managed
 * worktree layout (`<worktree root>/<repository key>/<task id>`) before anything is read.
 */
const verifyStoredIdentity = async ({ project, task, workspace }: ReviewTarget): Promise<void> => {
  const mismatches: string[] = [];
  if (workspace.taskId !== task.id) mismatches.push('task');
  if (
    workspace.repositoryRoot !== project.localPath ||
    workspace.gitCommonDir !== project.gitCommonDir
  ) {
    mismatches.push('repository');
  }
  let expectedBranch: string | null = null;
  try {
    expectedBranch = defaultTaskBranchName(task.id);
  } catch {
    expectedBranch = null;
  }
  if (expectedBranch === null || workspace.branch !== expectedBranch) mismatches.push('branch');
  if (!fullShaPattern.test(workspace.baseSha)) mismatches.push('base_commit');

  const { path } = workspace;
  if (
    !isAbsolute(path) ||
    !isAbsolute(workspace.worktreeRoot) ||
    basename(path) !== task.id ||
    path === project.localPath ||
    isStrictlyWithin(project.localPath, path)
  ) {
    mismatches.push('path');
  } else {
    let root: string | null = null;
    try {
      root = await realpath(workspace.worktreeRoot);
    } catch {
      root = null;
    }
    if (root === null) {
      throw new ReviewError(
        'workspace_not_verified',
        'The managed worktree root no longer exists. Nothing was read.',
      );
    }
    if (dirname(dirname(path)) !== root) mismatches.push('path');
  }

  if (mismatches.length > 0) {
    throw new ReviewError(
      'workspace_identity_mismatch',
      'The recorded workspace does not belong to this task and project. Nothing was read.',
      { mismatches },
    );
  }
};

/** The repository at the registered path must still be the registered repository. */
const verifyLiveRepository = async ({ project }: ReviewTarget): Promise<void> => {
  const validation = await validateRepository(project.localPath);
  if (
    !validation.valid ||
    validation.repository.root !== project.localPath ||
    validation.repository.commonDir !== project.gitCommonDir
  ) {
    throw new ReviewError(
      'workspace_not_verified',
      'The repository at the registered path is missing or is a different repository. Nothing was read.',
    );
  }
};

const inspectionOptions = ({ project, workspace }: ReviewTarget): TaskChangesOptions => ({
  repositoryPath: project.localPath,
  worktreePath: workspace.path,
  branchName: workspace.branch,
  baseCommit: workspace.baseSha,
});

const hasErrorCode = (error: unknown, codes: string[]): boolean =>
  error instanceof Error && 'code' in error && codes.includes(String(error.code));

const notVerifiedMessage = (error: TaskWorktreeError): ReviewError => {
  const state = error.inspection?.state ?? 'unknown';
  const issues = error.inspection?.issues ?? [];
  return new ReviewError(
    'workspace_not_verified',
    state === 'absent' || state === 'branch_only'
      ? 'The task worktree is missing or was moved. Nothing was read or repaired.'
      : 'The task worktree could not be verified as this task’s worktree (it may have been moved, unlocked, switched to another branch or replaced). Nothing was read or repaired.',
    { state, issues },
  );
};

/** Maps inspection failures to safe, path-free review errors; unexpected errors propagate. */
export const toReviewError = (error: unknown): unknown => {
  if (error instanceof ReviewError) return error;
  if (error instanceof TaskWorktreeError) {
    switch (error.code) {
      case 'NOT_VERIFIED':
        return notVerifiedMessage(error);
      case 'BASE_COMMIT_NOT_FOUND':
        return new ReviewError(
          'base_commit_missing',
          'The recorded base commit no longer exists in the repository, so the changes cannot be computed.',
        );
      default:
        return new ReviewError(
          'workspace_not_verified',
          'The registered repository or the task worktree could not be verified. Nothing was read.',
          { code: error.code },
        );
    }
  }
  if (hasErrorCode(error, ['EACCES', 'EPERM'])) {
    return new ReviewError(
      'workspace_inaccessible',
      'The task worktree exists but could not be read (permission denied).',
    );
  }
  if (error instanceof GitCommandError) {
    console.error('Review inspection failed.', error.code);
    return new ReviewError(
      'review_inspection_failed',
      error.code === 'GIT_TIMEOUT'
        ? 'Inspecting the worktree took too long.'
        : 'Git could not inspect the task worktree. See the server log.',
      { code: error.code },
    );
  }
  return error;
};

/** Live identity reported by the inspection must equal the stored records. */
const assertInspectedIdentity = (
  target: ReviewTarget,
  inspected: { repository: { root: string; commonDir: string }; worktreePath: string },
): void => {
  if (
    inspected.repository.root !== target.project.localPath ||
    inspected.repository.commonDir !== target.project.gitCommonDir ||
    inspected.worktreePath !== target.workspace.path
  ) {
    throw new ReviewError(
      'workspace_identity_mismatch',
      'The inspected worktree does not match the recorded workspace. Its changes are not shown.',
    );
  }
};

const readChanges = async (target: ReviewTarget): Promise<ReviewChanges> => {
  await verifyStoredIdentity(target);
  await verifyLiveRepository(target);
  const changes = await inspectTaskChanges(inspectionOptions(target));
  assertInspectedIdentity(target, changes);
  return {
    state: 'available',
    headCommit: changes.headCommit,
    baseIsAncestor: changes.baseIsAncestor,
    files: changes.files,
    totalFiles: changes.totalFiles,
    filesTruncated: changes.filesTruncated,
    totals: changes.totals,
    ignoredCount: changes.ignoredPaths.length,
    ignoredTruncated: changes.ignoredPathsTruncated,
    consistency: changes.consistency,
    revision: changes.revision,
  };
};

const blockReasons = (
  task: TaskRecord,
  run: TaskRunView | null,
  changes: ReviewChanges,
): ReviewBlockReason[] => {
  if (run === null) return ['no_run'];
  const reasons: ReviewBlockReason[] = [];
  const status: TaskRunStatus = run.status;
  if (run.active) reasons.push('run_active');
  else if (status !== 'completed') reasons.push('run_not_completed');
  if (run.gitIntegrity.status === 'violation') reasons.push('integrity_violation');
  if (run.gitIntegrity.status === 'inconclusive') reasons.push('integrity_inconclusive');
  if (run.gitIntegrity.status === 'not_run' && !run.active) reasons.push('integrity_not_run');
  if (task.status !== 'review') reasons.push('task_not_in_review');
  if (changes.state === 'unavailable') reasons.push('changes_unavailable');
  else if (changes.consistency === 'changed_during_inspection') {
    reasons.push('changed_during_inspection');
  }
  return reasons;
};

/**
 * The review page model: task identity, the latest run with its execution and Git integrity
 * outcome, the recorded workspace, eligibility for the normal review path, and the change
 * inventory of the verified worktree (or a safe reason why it is not shown).
 */
export const getTaskReview = async (
  db: Database,
  projectId: string,
  taskId: string,
): Promise<TaskReviewView> => {
  const context = loadContext(db, projectId, taskId);
  const run = context.run === null ? null : toRunView(context.run);

  let changes: ReviewChanges;
  try {
    changes = await readChanges(requireTarget(context));
  } catch (error) {
    const mapped = toReviewError(error);
    if (!(mapped instanceof ReviewError)) throw mapped;
    changes = { state: 'unavailable', code: mapped.code, message: mapped.message };
  }

  const reasons = blockReasons(context.task, run, changes);
  const { workspace } = context;
  const publication = await getPublicationPanel(db, {
    ...context,
    changes,
    eligible: reasons.length === 0,
  });
  return {
    task: {
      id: context.task.id,
      projectId: context.project.id,
      projectName: context.project.name,
      title: context.task.title,
      status: context.task.status,
    },
    run,
    workspace:
      workspace === null
        ? null
        : {
            path: workspace.path,
            branch: workspace.branch,
            baseBranch: workspace.baseBranch,
            baseSha: workspace.baseSha,
            createdAt: workspace.createdAt,
          },
    eligibility: { eligible: reasons.length === 0, reasons },
    changes,
    attempts: context.runs.map(toRunView),
    decisions: listReviewDecisionViews(db, context.task.id, context.runs),
    publication,
  };
};

/**
 * `Request Changes` (M6-02). Re-inspects the review exactly as the page does and requires the
 * result to be eligible for the normal review path, for the attempt (`runId`) and change-inventory
 * revision the reviewer saw. Then stores the feedback and moves the task Review → Queued in one
 * transaction. No start request is created: the next attempt runs only after an explicit Start.
 */
export const requestChangesForTask = async (
  db: Database,
  projectId: string,
  taskId: string,
  input: RequestChangesInput,
  { now = Date.now, createId = randomUUID }: { now?: () => number; createId?: () => string } = {},
): Promise<RequestChangesResponse> => {
  const review = await getTaskReview(db, projectId, taskId);
  if (review.run === null || review.run.id !== input.runId) {
    throw new ReviewActionError(
      'review_run_changed',
      'A newer attempt exists than the one you reviewed. Reload the page.',
    );
  }
  if (review.decisions.some((decision) => decision.runId === input.runId)) {
    throw new ReviewActionError(
      'changes_already_requested',
      'Changes were already requested for this attempt. Reload the page.',
    );
  }
  if (review.publication.current !== null) {
    throw new ReviewActionError(
      'publication_in_progress',
      'This attempt was approved for publishing. Changes cannot be requested while it is being published or its push is pending.',
    );
  }
  if (!review.eligibility.eligible) {
    const { reasons } = review.eligibility;
    throw reasons.length === 1 && reasons[0] === 'task_not_in_review'
      ? new ReviewActionError(
          'task_not_in_review',
          'Changes can be requested only while the task is in Review. Reload the page.',
          { status: review.task.status },
        )
      : new ReviewActionError(
          'run_not_review_eligible',
          'This attempt is not eligible for the normal review path, so changes cannot be requested.',
          { reasons: review.eligibility.reasons },
        );
  }
  if (review.changes.state !== 'available' || review.changes.revision !== input.revision) {
    throw new ReviewActionError(
      'review_changes_changed',
      'The worktree changed after you loaded the review. Refresh, review the current changes and submit again.',
    );
  }
  const { review: record, task } = requestTaskChanges(db, {
    id: createId(),
    taskId: review.task.id,
    input,
    now: now(),
  });
  return {
    task: { id: task.id, status: task.status },
    decision: {
      id: record.id,
      status: record.status,
      runId: record.runId,
      attempt: review.run.attempt,
      feedback: record.feedback,
      createdAt: record.createdAt,
      followUpRunId: record.followUpRunId,
      followUpAttempt: null,
    },
  };
};

/**
 * The unified diff of one changed file of the task's latest run. `path` must be listed by the
 * change inventory of the verified worktree; anything else, including traversal, absolute paths
 * and unchanged or ignored files, is `review_file_not_found`.
 */
export const getTaskReviewFileDiff = async (
  db: Database,
  projectId: string,
  taskId: string,
  path: string,
): Promise<FileDiffView> => {
  const target = requireTarget(loadContext(db, projectId, taskId));
  try {
    await verifyStoredIdentity(target);
    await verifyLiveRepository(target);
    const diff = await getTaskFileDiff({ ...inspectionOptions(target), path });
    return {
      file: diff.file,
      patch: diff.patch,
      omitted: diff.omitted,
      consistency: diff.consistency,
      revision: diff.revision,
    };
  } catch (error) {
    if (error instanceof GitInputError) {
      throw new ReviewError(
        'review_file_not_found',
        'This path is not among the task’s changed files.',
      );
    }
    throw toReviewError(error);
  }
};
