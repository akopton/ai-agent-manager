import { buildPublicationCommitMessage, isActivePublicationStatus } from '@ai-agent-manager/core';
import {
  listGitOperations,
  listTaskPublications,
  type DatabaseConnection,
  type ProjectRecordWithTrust,
  type PublicationRecord,
  type TaskRecord,
  type TaskRunRecord,
  type WorkspaceRecord,
} from '@ai-agent-manager/database';
import { readPublishRemote, reviewSnapshotSchema } from '@ai-agent-manager/git';
import type {
  PublicationPanel,
  PublicationReadinessReason,
  PublicationView,
  ReviewChanges,
} from '@/lib/review/contracts';

// Read-only model of the Approve & Push section of the review page (M6-03). It reads stored
// publications and the project's remote configuration; it never hashes, stages, commits or pushes.

type Database = DatabaseConnection['db'];

const unsupportedKinds = new Set(['submodule', 'directory', 'other']);

const approvedFiles = (publication: PublicationRecord): PublicationView['files'] => {
  try {
    const parsed = reviewSnapshotSchema.safeParse(JSON.parse(publication.snapshotJson) as unknown);
    return parsed.success
      ? parsed.data.files.map(({ path, previousPath, change }) => ({ path, previousPath, change }))
      : [];
  } catch {
    return [];
  }
};

export const toPublicationView = (
  publication: PublicationRecord,
  operations: ReturnType<typeof listGitOperations>,
  attempts: ReadonlyMap<string, number>,
  taskStatus: TaskRecord['status'],
): PublicationView => ({
  id: publication.id,
  status: publication.status,
  failureStage: publication.failureStage,
  errorCode: publication.errorCode,
  errorMessage: publication.errorMessage,
  runId: publication.runId,
  attempt: attempts.get(publication.runId) ?? 0,
  fileCount: publication.fileCount,
  files: approvedFiles(publication),
  snapshotHash: publication.snapshotHash,
  baseCommit: publication.baseCommit,
  branch: publication.branch,
  remoteName: publication.remoteName,
  remoteUrl: publication.remoteUrl,
  commitMessage: publication.commitMessage,
  commitSha: publication.commitSha,
  createdAt: publication.createdAt,
  updatedAt: publication.updatedAt,
  committedAt: publication.committedAt,
  pushedAt: publication.pushedAt,
  canRetryPush:
    publication.status === 'failed' &&
    publication.failureStage === 'push' &&
    publication.commitSha !== null &&
    taskStatus === 'review',
  operations: operations
    .filter((operation) => operation.publicationId === publication.id)
    .map((operation) => ({
      kind: operation.kind,
      attempt: operation.attempt,
      status: operation.status,
      commitSha: operation.commitSha,
      remoteName: operation.remoteName,
      ref: operation.ref,
      outcome: operation.outcome,
      errorCode: operation.errorCode,
      errorMessage: operation.errorMessage,
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
    })),
});

/** Stored publications of a task as views, newest first. */
export const listPublicationViews = (
  db: Database,
  task: TaskRecord,
  runs: readonly TaskRunRecord[],
): PublicationView[] => {
  const publications = listTaskPublications(db, task.id);
  const operations = listGitOperations(
    db,
    publications.map(({ id }) => id),
  );
  const attempts = new Map(runs.map((run) => [run.id, run.attempt]));
  return publications.map((publication) =>
    toPublicationView(publication, operations, attempts, task.status),
  );
};

/** The publication that holds the task: active, or failed at the push with its commit recorded. */
export const findCurrentPublication = (history: readonly PublicationView[]) =>
  history.find((publication) => isActivePublicationStatus(publication.status)) ??
  history.find((publication) => publication.canRetryPush) ??
  null;

type PanelInput = {
  project: ProjectRecordWithTrust;
  task: TaskRecord;
  run: TaskRunRecord | null;
  workspace: WorkspaceRecord | null;
  runs: readonly TaskRunRecord[];
  changes: ReviewChanges;
  eligible: boolean;
};

const inventoryReasons = (
  changes: ReviewChanges,
  workspace: WorkspaceRecord | null,
): PublicationReadinessReason[] => {
  if (changes.state !== 'available' || workspace === null) return [];
  const reasons: PublicationReadinessReason[] = [];
  if (changes.totalFiles === 0) reasons.push('no_changes');
  if (changes.filesTruncated) reasons.push('files_truncated');
  if (changes.headCommit !== workspace.baseSha) reasons.push('unexpected_commits');
  if (changes.files.some((file) => file.change === 'conflicted')) reasons.push('conflicted_file');
  if (
    changes.files.some(
      (file) =>
        unsupportedKinds.has(file.kind) ||
        (file.previousKind !== null && unsupportedKinds.has(file.previousKind)) ||
        file.diffOmitted === 'outside_worktree' ||
        file.diffOmitted === 'unsupported_file_type',
    )
  ) {
    reasons.push('unsupported_file');
  }
  return reasons;
};

/**
 * The Approve & Push panel: destination (configured remote + task branch, or why there is none),
 * the generated commit message, readiness reasons and the publication history. Read-only.
 */
export const getPublicationPanel = async (
  db: Database,
  { project, task, run, workspace, runs, changes, eligible }: PanelInput,
): Promise<PublicationPanel> => {
  const history = listPublicationViews(db, task, runs);
  const current = findCurrentPublication(history);
  const reasons: PublicationReadinessReason[] = [];
  if (!eligible) reasons.push('not_review_eligible');
  reasons.push(...inventoryReasons(changes, workspace));
  if (current !== null) {
    reasons.push(current.canRetryPush ? 'push_pending' : 'publication_active');
  }

  let destination: PublicationPanel['destination'] = null;
  if (project.remoteName === null) {
    reasons.push('no_remote');
  } else {
    let remote = null;
    try {
      remote = await readPublishRemote(project.localPath, project.remoteName);
    } catch {
      remote = null;
    }
    if (remote === null) reasons.push('remote_not_found');
    else if (remote.mirror) reasons.push('remote_mirror');
    else if (workspace !== null) {
      destination = {
        remoteName: remote.name,
        remoteUrl: remote.displayUrl,
        branch: workspace.branch,
        remoteRef: `refs/heads/${workspace.branch}`,
      };
    }
  }

  return {
    destination,
    commitMessage:
      run === null
        ? null
        : buildPublicationCommitMessage({
            taskId: task.id,
            title: task.title,
            attempt: run.attempt,
            runId: run.id,
          }),
    readiness: { ready: reasons.length === 0 && destination !== null, reasons },
    current,
    history,
  };
};
