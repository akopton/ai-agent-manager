import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  FileCheck2,
  FolderX,
  Info,
  ListRestart,
  ShieldAlert,
} from 'lucide-react';
import { ExecutionError, taskRunStatusLabels } from '@ai-agent-manager/core';

import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { ApprovePublishPanel } from '@/components/review/approve-publish-panel';
import { AttemptHistory } from '@/components/review/attempt-history';
import { PublicationStatus } from '@/components/review/publication-status';
import { RefreshReviewButton } from '@/components/review/refresh-review-button';
import { RequestChangesForm } from '@/components/review/request-changes-form';
import { ReviewFileList } from '@/components/review/review-file-list';
import { TaskRuntimeBadge, TaskStatusBadge } from '@/components/tasks/task-badges';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { describeIntegrity, describeRunOutcome } from '@/lib/execution/format';
import { formatTimestamp } from '@/lib/projects/format';
import type { TaskReviewView } from '@/lib/review/contracts';
import { reviewBlockMessages, shortSha } from '@/lib/review/format';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { getTaskReview } from '@/lib/server/review';
import { agentRuntimeLabels, taskUrl } from '@/lib/tasks/board';

export const metadata: Metadata = { title: 'Review changes · AI Agent Manager' };

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </>
);

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-xs break-all">{children}</span>
);

const IntegrityBanner = ({ run }: { run: NonNullable<TaskReviewView['run']> }) => {
  const { gitIntegrity } = run;
  if (gitIntegrity.status !== 'violation' && gitIntegrity.status !== 'inconclusive') {
    return null;
  }
  return (
    <Alert variant="destructive" role="alert">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>
        {gitIntegrity.status === 'violation'
          ? 'Unexpected Git mutation detected — review and publishing are blocked'
          : 'Git integrity could not be confirmed — review and publishing are blocked'}
      </AlertTitle>
      <AlertDescription>
        <p>
          The post-run check compares Git state before and after the run. The changes below are
          shown for inspection only; this run cannot follow the normal review path. Nothing was
          repaired or reset.
        </p>
        {gitIntegrity.findings.length > 0 ? (
          <ul className="mt-2 list-disc pl-5 font-mono text-xs">
            {gitIntegrity.findings.slice(0, 20).map((finding) => (
              <li key={`${finding.code}:${finding.subject}`} className="break-all">
                {finding.disposition}: {finding.code} — {finding.subject}
              </li>
            ))}
          </ul>
        ) : null}
        {gitIntegrity.totalFindings > Math.min(20, gitIntegrity.findings.length) ? (
          <p className="mt-1 text-xs">{gitIntegrity.totalFindings} findings in total.</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
};

/** A change request that waits for its follow-up attempt. */
const PendingChangeRequest = ({ review }: { review: TaskReviewView }) => {
  const pending = review.decisions.find((decision) => decision.followUpRunId === null);
  if (pending === undefined) {
    return null;
  }
  return (
    <Alert>
      <ListRestart aria-hidden="true" />
      <AlertTitle>Changes requested for attempt {pending.attempt}</AlertTitle>
      <AlertDescription>
        <p>
          The task is {review.task.status === 'queued' ? 'back in Queued' : 'not in Review'}. No
          agent was started. Start attempt {pending.attempt + 1} explicitly with Start execution on
          the{' '}
          <Link className="underline" href={taskUrl(review.task.projectId, review.task.id)}>
            task page
          </Link>
          ; it continues in this worktree from the changes shown below, with your feedback.
        </p>
        <p className="mt-2 rounded-lg border bg-inset p-3 break-words whitespace-pre-wrap text-foreground">
          {pending.feedback}
        </p>
      </AlertDescription>
    </Alert>
  );
};

const EligibilityBanner = ({ review }: { review: TaskReviewView }) => {
  const { eligibility } = review;
  if (
    !eligibility.eligible &&
    review.task.status === 'queued' &&
    review.decisions.some((decision) => decision.followUpRunId === null)
  ) {
    // The pending change request explains the state; the review path resumes after the next run.
    return null;
  }
  if (eligibility.eligible) {
    return (
      <Alert>
        <FileCheck2 aria-hidden="true" />
        <AlertTitle>Ready for your review</AlertTitle>
        <AlertDescription>
          <p>
            The agent process completed and the Git integrity check found no observable Git
            mutation. Neither shows that the implementation is correct: judge the result by the
            changes below. You can request changes or approve and push below; Discard is not
            available yet.
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="warning">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Not eligible for the normal review path</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-5">
          {eligibility.reasons.map((reason) => (
            <li key={reason}>{reviewBlockMessages[reason]}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
};

const RunDetails = ({ review }: { review: TaskReviewView }) => {
  const { run, workspace, changes, task } = review;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h2>Run</h2>
          {run !== null ? (
            <Badge variant="outline">
              {run.securityMode === 'trusted_local' ? 'Trusted Local' : 'Strict Isolated'}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          The latest run of this task. “Completed” describes the agent process, not the quality of
          its work.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[11rem_1fr]">
          <Field label="Task">
            {task.title} <Mono>({task.id})</Mono>
          </Field>
          <Field label="Project">{task.projectName}</Field>
          {run === null ? (
            <Field label="Run">None yet</Field>
          ) : (
            <>
              <Field label="Attempt">{run.attempt}</Field>
              <Field label="Runtime">{agentRuntimeLabels[run.agentRuntime]}</Field>
              <Field label="Model">
                {run.requestedModelId ?? 'Default'}
                <span className="text-muted-foreground">
                  {run.effectiveModelId !== null
                    ? ` (reported by the CLI: ${run.effectiveModelId})`
                    : ' (effective model not reported)'}
                </span>
              </Field>
              {run.cliVersion !== null ? (
                <Field label="CLI version">
                  <Mono>{run.cliVersion}</Mono>
                </Field>
              ) : null}
              <Field label="Run status">{taskRunStatusLabels[run.status]}</Field>
              <Field label="Execution outcome">{describeRunOutcome(run)}</Field>
              <Field label="Git integrity">{describeIntegrity(run)}</Field>
              {run.endedAt !== null ? (
                <Field label="Ended">{formatTimestamp(run.endedAt)}</Field>
              ) : null}
            </>
          )}
          {workspace !== null ? (
            <>
              <Field label="Base">
                <Mono>
                  {workspace.baseBranch} @ {shortSha(workspace.baseSha)}
                </Mono>
              </Field>
              <Field label="Task branch">
                <Mono>{workspace.branch}</Mono>
              </Field>
              {changes.state === 'available' ? (
                <Field label="Branch HEAD">
                  <Mono>{shortSha(changes.headCommit)}</Mono>
                  {changes.headCommit === workspace.baseSha ? (
                    <span className="text-muted-foreground"> (no commits since base)</span>
                  ) : !changes.baseIsAncestor ? (
                    <span className="text-destructive">
                      {' '}
                      (the base commit is no longer an ancestor: the branch was rewritten)
                    </span>
                  ) : (
                    <span className="text-destructive"> (commits were added to the branch)</span>
                  )}
                </Field>
              ) : null}
              <Field label="Worktree">
                <Mono>{workspace.path}</Mono>
              </Field>
            </>
          ) : null}
        </dl>
        {run?.summary != null ? (
          <div className="space-y-1">
            <p className="font-medium">Agent summary</p>
            <p className="text-xs text-muted-foreground">
              As reported by the agent at the end of the run. Not verified.
            </p>
            <p className="rounded-lg border bg-inset p-3 break-words whitespace-pre-wrap">
              {run.summary}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

const ChangesSection = ({ review }: { review: TaskReviewView }) => {
  const { changes, task, run } = review;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Changes</h2>
        </CardTitle>
        <CardDescription>
          Every difference between the base commit and the current worktree: commits on the task
          branch, staged and unstaged edits, and untracked files. Read-only; nothing is staged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {run === null ? (
          <p className="text-muted-foreground">
            This task has not run yet, so there is nothing to review.
          </p>
        ) : changes.state === 'unavailable' ? (
          <Alert variant="destructive" role="alert">
            <FolderX aria-hidden="true" />
            <AlertTitle>The changes could not be inspected</AlertTitle>
            <AlertDescription>
              <p>{changes.message}</p>
              <p className="mt-1 font-mono text-xs">{changes.code}</p>
            </AlertDescription>
          </Alert>
        ) : changes.files.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
            <Info className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="font-medium">The agent made no changes</p>
            <p className="max-w-md text-muted-foreground">
              The worktree matches the base commit
              {changes.ignoredCount > 0
                ? `, apart from ${changes.ignoredCount}${changes.ignoredTruncated ? '+' : ''} Git-ignored paths, which are not shown`
                : ''}
              .
            </p>
          </div>
        ) : (
          <>
            <p>
              {changes.totalFiles} {changes.totalFiles === 1 ? 'file' : 'files'} changed ·{' '}
              <span className="text-success">+{changes.totals.additions}</span>{' '}
              <span className="text-destructive">−{changes.totals.deletions}</span>
              {changes.ignoredCount > 0 ? (
                <span className="text-muted-foreground">
                  {' '}
                  · {changes.ignoredCount}
                  {changes.ignoredTruncated ? '+' : ''} Git-ignored paths not shown
                </span>
              ) : null}
            </p>
            {changes.consistency === 'changed_during_inspection' ? (
              <Alert variant="warning">
                <AlertTriangle aria-hidden="true" />
                <AlertTitle>The worktree changed during inspection</AlertTitle>
                <AlertDescription>
                  <p>
                    Something modified the worktree while it was read. Refresh to inspect again.
                  </p>
                </AlertDescription>
              </Alert>
            ) : null}
            {changes.filesTruncated ? (
              <p className="text-muted-foreground">
                Showing the first {changes.files.length} of {changes.totalFiles} files.
              </p>
            ) : null}
            <ReviewFileList
              projectId={task.projectId}
              taskId={task.id}
              files={changes.files}
              revision={changes.revision}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
};

/**
 * Approve & Push (M6-03): the publication that holds the task (progress, failure, Retry push), or
 * the approval panel for an eligible review. Rendering never stages, commits or pushes.
 */
const PublicationSection = ({ review }: { review: TaskReviewView }) => {
  const { publication, task, run, workspace, changes } = review;
  const shown = publication.current ?? publication.history[0] ?? null;
  const showStatus =
    shown !== null &&
    (publication.current !== null || task.status === 'done' || shown.runId === run?.id);
  return (
    <>
      {showStatus ? (
        <PublicationStatus projectId={task.projectId} taskId={task.id} publication={shown} />
      ) : null}
      {publication.current === null &&
      task.status === 'review' &&
      run !== null &&
      workspace !== null &&
      changes.state === 'available' ? (
        <ApprovePublishPanel
          projectId={task.projectId}
          taskId={task.id}
          runId={run.id}
          attempt={run.attempt}
          revision={changes.revision}
          files={changes.files}
          baseBranch={workspace.baseBranch}
          baseSha={workspace.baseSha}
          publication={publication}
        />
      ) : null}
    </>
  );
};

const ReviewPage = async ({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}) => {
  await connection();
  const { projectId, taskId } = await params;
  const result = await loadForPage(async () => {
    try {
      return await getTaskReview(getDatabase(), projectId, taskId);
    } catch (error) {
      if (
        error instanceof ExecutionError &&
        (error.code === 'project_not_found' || error.code === 'task_not_found')
      ) {
        return undefined;
      }
      throw error;
    }
  });

  if (!result.ok) {
    return <DatabaseNotReady message={result.message} />;
  }
  if (result.data === undefined) {
    notFound();
  }
  const review = result.data;
  const { task, run } = review;

  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href={taskUrl(task.projectId, task.id)}>
            <ArrowLeft aria-hidden="true" />
            Task details
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-3">
            <p className="text-sm text-muted-foreground">Review changes</p>
            <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
              {task.title}
            </h1>
            <div className="flex flex-wrap gap-2">
              <TaskStatusBadge status={task.status} />
              {run !== null ? (
                <TaskRuntimeBadge agentRuntime={run.agentRuntime} modelId={run.requestedModelId} />
              ) : null}
            </div>
          </div>
          <RefreshReviewButton />
        </div>
      </section>

      {run !== null ? <IntegrityBanner run={run} /> : null}
      <PendingChangeRequest review={review} />
      <EligibilityBanner review={review} />
      <RunDetails review={review} />
      <ChangesSection review={review} />
      <PublicationSection review={review} />
      {review.eligibility.eligible &&
      run !== null &&
      review.changes.state === 'available' &&
      review.publication.current === null ? (
        <RequestChangesForm
          projectId={task.projectId}
          taskId={task.id}
          runId={run.id}
          attempt={run.attempt}
          revision={review.changes.revision}
        />
      ) : null}
      <AttemptHistory attempts={review.attempts} decisions={review.decisions} />
    </>
  );
};

export default ReviewPage;
