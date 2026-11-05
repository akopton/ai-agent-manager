import { randomUUID } from 'node:crypto';
import {
  approvePublicationInputSchema,
  buildPublicationCommitMessage,
  PublicationError,
  retryPublicationPushInputSchema,
  type ApprovePublicationInput,
  type RetryPublicationPushInput,
} from '@ai-agent-manager/core';
import {
  createPublication,
  findProjectById,
  findPublication,
  findPublicationByRequest,
  findTaskById,
  findWorkspace,
  listGitOperations,
  listTaskRuns,
  requestPublicationPushRetry,
  type DatabaseConnection,
  type PublicationRecord,
  type TaskRecord,
} from '@ai-agent-manager/database';
import { captureReviewSnapshot, readPublishRemote } from '@ai-agent-manager/git';
import type { PublicationResponse } from '@/lib/review/contracts';
import { ReviewError } from '@/lib/review/errors';
import { toPublicationView } from '@/lib/server/publication-view';
import { getTaskReview, toReviewError } from '@/lib/server/review';

// Approve & Push commands (M6-03). The web process only records intent: an approval bound to a
// freshly captured review snapshot, or a push retry. It never stages, commits or pushes and never
// starts an agent; the worker executes the publication. Everything the browser sends is compared
// with values the server derives itself (attempt, inventory revision, remote, task branch) and is
// never used as a path, ref, remote or commit message.

type Database = DatabaseConnection['db'];

const respond = (
  db: Database,
  task: TaskRecord,
  publication: PublicationRecord,
): PublicationResponse => {
  const attempts = new Map(listTaskRuns(db, task.id).map((run) => [run.id, run.attempt]));
  return {
    task: { id: task.id, status: task.status },
    publication: toPublicationView(
      publication,
      listGitOperations(db, [publication.id]),
      attempts,
      task.status,
    ),
  };
};

const invalidInput = (issues: { path: PropertyKey[]; message: string }[]): PublicationError =>
  new PublicationError(
    'invalid_publication_input',
    issues[0]?.message ?? 'The approval is invalid.',
    { issues: issues.map(({ path, message }) => ({ path: path.join('.'), message })) },
  );

/** Returns the stored approval for a repeated request of the same task, if any. */
const findRepeatedRequest = (
  db: Database,
  taskId: string,
  requestId: string,
): PublicationResponse | null => {
  const existing = findPublicationByRequest(db, requestId);
  if (existing === undefined) return null;
  const task = findTaskById(db, existing.taskId);
  if (task === undefined || task.id !== taskId) {
    throw new PublicationError(
      'invalid_publication_input',
      'This request ID was already used for another approval.',
    );
  }
  return respond(db, task, existing);
};

/**
 * `Approve & Push`. Re-inspects the review exactly as the page does, requires the attempt and
 * change-inventory revision the operator saw, eligibility for normal review, a configured and
 * unchanged destination, and a change set that can be published as reviewed. It then captures the
 * review snapshot (content hashes of every changed path; the revision must still match afterwards)
 * and records the approval. Returns `created: false` for a repeated `requestId`.
 */
export const approveTaskPublication = async (
  db: Database,
  projectId: string,
  taskId: string,
  input: ApprovePublicationInput,
  { now = Date.now, createId = randomUUID }: { now?: () => number; createId?: () => string } = {},
): Promise<{ response: PublicationResponse; created: boolean }> => {
  const parsed = approvePublicationInputSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error.issues);
  const { requestId, runId, revision, remoteName, branch } = parsed.data;

  const review = await getTaskReview(db, projectId, taskId);
  const repeated = findRepeatedRequest(db, review.task.id, requestId);
  if (repeated !== null) return { response: repeated, created: false };

  if (review.run === null || review.run.id !== runId) {
    throw new PublicationError(
      'review_run_changed',
      'A newer attempt exists than the one you reviewed. Reload the page.',
    );
  }
  if (review.decisions.some((decision) => decision.runId === runId)) {
    throw new PublicationError(
      'review_decision_exists',
      'Changes were already requested for this attempt. Reload the page.',
    );
  }
  const { current } = review.publication;
  if (current !== null) {
    throw current.canRetryPush
      ? new PublicationError(
          'publication_push_pending',
          'A commit of this task exists but was not pushed. Retry the push instead of approving again.',
          { publicationId: current.id },
        )
      : new PublicationError(
          'publication_in_progress',
          'This task is already being published. Reload the page.',
          { publicationId: current.id },
        );
  }
  if (!review.eligibility.eligible) {
    const { reasons } = review.eligibility;
    throw reasons.length === 1 && reasons[0] === 'task_not_in_review'
      ? new PublicationError(
          'task_not_in_review',
          'Only a task in Review can be approved. Reload the page.',
          { status: review.task.status },
        )
      : new PublicationError(
          'run_not_review_eligible',
          'This attempt is not eligible for the normal review path, so it cannot be approved.',
          { reasons },
        );
  }
  if (review.changes.state !== 'available' || review.changes.revision !== revision) {
    throw new PublicationError(
      'review_changes_changed',
      'The worktree changed after you loaded the review. Refresh, review the current changes and approve again.',
    );
  }

  const project = findProjectById(db, review.task.projectId);
  const [latestRun] = listTaskRuns(db, review.task.id);
  const workspace =
    latestRun?.id !== runId || latestRun.workspaceId === null
      ? undefined
      : findWorkspace(db, latestRun.workspaceId);
  if (project === undefined || workspace === undefined) {
    throw new ReviewError('review_unavailable', 'The task’s workspace record is missing.');
  }
  if (project.remoteName === null) {
    throw new PublicationError(
      'publication_remote_missing',
      'This project has no remote configured. Choose a remote in the project settings; nothing is published to a guessed destination.',
    );
  }
  const remote = await readPublishRemote(project.localPath, project.remoteName);
  if (remote === null || remote.mirror) {
    throw new PublicationError(
      'publication_remote_missing',
      remote === null
        ? `The project's remote "${project.remoteName}" does not exist in the repository.`
        : `The project's remote "${project.remoteName}" is a mirror remote and cannot be used for a single-branch push.`,
    );
  }
  if (remote.name !== remoteName || workspace.branch !== branch) {
    throw new PublicationError(
      'publication_target_changed',
      'The destination changed after you loaded the review. Refresh and confirm the new destination.',
      { remoteName: remote.name, branch: workspace.branch },
    );
  }

  let capture;
  try {
    capture = await captureReviewSnapshot({
      repositoryPath: project.localPath,
      worktreePath: workspace.path,
      branchName: workspace.branch,
      baseCommit: workspace.baseSha,
    });
  } catch (error) {
    throw toReviewError(error);
  }
  if (capture.revision !== revision) {
    throw new PublicationError(
      'review_changes_changed',
      'The worktree changed after you loaded the review. Refresh, review the current changes and approve again.',
    );
  }
  if (capture.status === 'blocked') {
    throw new PublicationError(
      'publication_blocked',
      'These changes cannot be published as reviewed.',
      { blockers: capture.blockers.slice(0, 20) },
    );
  }
  const task = findTaskById(db, review.task.id);
  if (task === undefined)
    throw new PublicationError('publication_not_found', 'The task does not exist.');

  const { publication, created } = createPublication(db, {
    input: {
      id: createId(),
      requestId,
      taskId: task.id,
      runId: review.run.id,
      workspaceId: workspace.id,
      inventoryRevision: capture.revision,
      snapshotHash: capture.snapshotHash,
      snapshotJson: JSON.stringify(capture.snapshot),
      fileCount: capture.snapshot.files.length,
      baseCommit: workspace.baseSha,
      branch: workspace.branch,
      remoteName: remote.name,
      remoteUrl: remote.displayUrl,
      remoteUrlDigest: remote.urlDigest,
      commitMessage: buildPublicationCommitMessage({
        taskId: task.id,
        title: task.title,
        attempt: review.run.attempt,
        runId: review.run.id,
      }),
    },
    now: now(),
  });
  return { response: respond(db, task, publication), created };
};

/**
 * `Retry push` for a publication whose commit exists and whose push failed or was interrupted. Only
 * records the request; the worker re-verifies the worktree, branch and remote before pushing the
 * same commit again.
 */
export const retryTaskPublicationPush = async (
  db: Database,
  projectId: string,
  taskId: string,
  input: RetryPublicationPushInput,
  { now = Date.now }: { now?: () => number } = {},
): Promise<PublicationResponse> => {
  const parsed = retryPublicationPushInputSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error.issues);
  const project = findProjectById(db, projectId);
  const task = findTaskById(db, taskId);
  if (project === undefined || task === undefined || task.projectId !== project.id) {
    throw new PublicationError('publication_not_found', 'The task does not exist.');
  }
  const existing = findPublication(db, parsed.data.publicationId);
  if (existing === undefined || existing.taskId !== task.id) {
    throw new PublicationError('publication_not_found', 'The publication does not exist.');
  }
  const publication = requestPublicationPushRetry(db, {
    taskId: task.id,
    publicationId: existing.id,
    now: now(),
  });
  return respond(db, findTaskById(db, task.id) ?? task, publication);
};
