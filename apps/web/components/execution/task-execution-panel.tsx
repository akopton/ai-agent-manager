'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { AlertTriangle, ListRestart, Loader2 } from 'lucide-react';
import {
  reviewStatusLabels,
  taskRecoveryKindLabels,
  taskRunStatusLabels,
  type TaskStatus,
} from '@ai-agent-manager/core';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { TaskExecutionActions } from '@/components/execution/task-execution-actions';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTimestamp } from '@/lib/projects/format';
import { type TaskExecutionView, type TaskRunView } from '@/lib/execution/contracts';
import { describeIntegrity, describeRunOutcome, shouldPollExecution } from '@/lib/execution/format';

const refreshIntervalMs = 2_000;

/** How the source attempt of a Retry/Resume ended, as a sentence fragment. */
const sourceOutcomes: Partial<Record<TaskStatus, string>> = {
  failed: 'failed',
  stopped: 'was stopped',
  interrupted: 'was interrupted',
};

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </>
);

const IntegrityAlert = ({ run }: { run: TaskRunView }) => {
  const { gitIntegrity } = run;
  if (gitIntegrity.status !== 'violation' && gitIntegrity.status !== 'inconclusive') {
    return null;
  }
  return (
    <Alert variant={gitIntegrity.status === 'violation' ? 'destructive' : 'warning'}>
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>
        {gitIntegrity.status === 'violation'
          ? 'Unexpected Git mutation detected'
          : 'Git integrity check inconclusive'}
      </AlertTitle>
      <AlertDescription>
        <p>
          This run is not eligible for review or publishing. Nothing was repaired or reset; inspect
          the retained worktree and the findings below.
        </p>
        {gitIntegrity.findings.length > 0 ? (
          <ul className="mt-2 list-disc pl-5 font-mono text-xs">
            {gitIntegrity.findings.slice(0, 20).map((finding) => (
              <li key={`${finding.code}:${finding.subject}`}>
                {finding.code} — {finding.subject}
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

type TaskExecutionPanelProps = {
  projectId: string;
  task: { id: string; status: TaskStatus };
  execution: TaskExecutionView;
  showActions?: boolean;
};

/**
 * Explicit Start (Queued tasks) and Stop (active run), with the latest run's state. The page
 * refreshes from the server while a start request is pending or a run is active; the database is
 * the source of truth, not this component.
 */
export const TaskExecutionPanel = ({
  projectId,
  task,
  execution,
  showActions = true,
}: TaskExecutionPanelProps) => {
  const router = useRouter();
  const [latest, ...earlier] = execution.runs;
  const polling = shouldPollExecution(execution);

  useEffect(() => {
    if (!polling) return undefined;
    const timer = setInterval(() => router.refresh(), refreshIntervalMs);
    return () => clearInterval(timer);
  }, [polling, router]);

  const command = execution.lastCommand;
  const startRequested = command?.status === 'pending';
  const canStart = task.status === 'queued' && !startRequested;
  const canStop = latest?.active === true && latest.stopRequestedAt === null;
  const pendingChangeRequest = execution.reviews.find((review) => review.followUpRunId === null);
  const decisionByRun = new Map(execution.reviews.map((review) => [review.runId, review]));
  const pendingRecovery = execution.recoveries.find((recovery) => recovery.followUpRunId === null);
  const recoveryBySource = new Map(
    execution.recoveries.map((recovery) => [recovery.sourceRunId, recovery]),
  );
  const describeRecovery = (runId: string): string => {
    const recovery = recoveryBySource.get(runId);
    if (recovery === undefined) return '';
    const verb = recovery.kind === 'retry' ? 'Retried' : 'Resumed';
    return recovery.followUpAttempt === null
      ? ` · ${verb}, waiting for Start`
      : ` · ${verb} as attempt ${recovery.followUpAttempt}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h2>Execution</h2>
          {latest !== undefined ? (
            <Badge variant="outline">
              {latest.securityMode === 'trusted_local' ? 'Trusted Local' : 'Strict Isolated'}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Runs in a dedicated task worktree as your user (Trusted Local Mode). The worktree is not
          an OS-enforced boundary. Nothing is committed or pushed automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {showActions ? (
          <TaskExecutionActions projectId={projectId} task={task} execution={execution} />
        ) : null}
        {canStart ? (
          <p className="text-xs text-muted-foreground">
            Start requests execution. The task stays Queued until the worker accepts it.
          </p>
        ) : null}
        {pendingChangeRequest !== undefined && task.status === 'queued' ? (
          <Alert>
            <ListRestart aria-hidden="true" />
            <AlertTitle>
              Start continues attempt {pendingChangeRequest.attempt} as attempt{' '}
              {pendingChangeRequest.attempt + 1}
            </AlertTitle>
            <AlertDescription>
              <p>
                Changes were requested. The next run reuses the existing task worktree and branch
                {execution.workspace !== null ? (
                  <>
                    {' '}
                    (<span className="font-mono text-xs">{execution.workspace.branch}</span>)
                  </>
                ) : null}{' '}
                and continues from its current uncommitted and untracked changes, with the original
                prompt and this feedback. The worktree is re-verified before launch; if it was
                moved, switched or committed to, the run is refused and nothing is reset.
              </p>
              <p className="mt-2 rounded-lg border bg-inset p-3 break-words whitespace-pre-wrap text-foreground">
                {pendingChangeRequest.feedback}
              </p>
            </AlertDescription>
          </Alert>
        ) : null}
        {pendingRecovery !== undefined && task.status === 'queued' ? (
          <Alert>
            <ListRestart aria-hidden="true" />
            <AlertTitle>
              {taskRecoveryKindLabels[pendingRecovery.kind]} queued: Start runs attempt{' '}
              {pendingRecovery.sourceAttempt + 1}
            </AlertTitle>
            <AlertDescription>
              <p>
                Attempt {pendingRecovery.sourceAttempt}{' '}
                {sourceOutcomes[pendingRecovery.sourceStatus] ?? 'ended'}. Nothing runs until you
                click Start execution.{' '}
                {pendingRecovery.workspaceRetained ? (
                  <>
                    The next attempt continues in the existing task worktree and branch
                    {execution.workspace !== null ? (
                      <>
                        {' '}
                        (<span className="font-mono text-xs">{execution.workspace.branch}</span>)
                      </>
                    ) : null}{' '}
                    with its current tracked and untracked changes. The worktree is re-verified
                    before launch; if it was moved, switched or committed to, the run is refused and
                    nothing is reset.
                  </>
                ) : (
                  <>
                    Attempt {pendingRecovery.sourceAttempt} ended before a worktree was created, so
                    the next attempt creates one from the base branch.
                  </>
                )}{' '}
                It starts a new agent session; the previous session is not restored.
                {pendingRecovery.feedbackAttempt !== null
                  ? ` The review feedback on attempt ${pendingRecovery.feedbackAttempt} is sent again.`
                  : ''}
              </p>
            </AlertDescription>
          </Alert>
        ) : null}
        {canStop || latest?.stopRequestedAt != null ? (
          <p className="text-xs text-muted-foreground">
            Stop terminates the agent’s process group. Processes that left the group are not
            tracked. Files in the worktree are kept.
          </p>
        ) : null}

        {startRequested ? (
          <Alert>
            <Loader2 className="animate-spin" aria-hidden="true" />
            <AlertTitle>Start requested</AlertTitle>
            <AlertDescription>
              <p>
                Waiting for the worker to claim the task. Make sure the worker is running; requests
                that wait too long expire and are not executed.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}
        {command?.status === 'rejected' && task.status === 'queued' ? (
          <Alert variant="warning">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>The last start request was not executed</AlertTitle>
            <AlertDescription>
              <p>{command.resultMessage ?? command.resultCode}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {latest === undefined ? (
          <p className="text-muted-foreground">No runs yet.</p>
        ) : (
          <>
            <IntegrityAlert run={latest} />
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[11rem_1fr]">
              <Field label="Attempt">{latest.attempt}</Field>
              <Field label="Run status">{taskRunStatusLabels[latest.status]}</Field>
              <Field label="Outcome">
                {describeRunOutcome(latest)}
                {describeRecovery(latest.id)}
              </Field>
              <Field label="Git integrity">{describeIntegrity(latest)}</Field>
              <Field label="Review eligible">
                {latest.reviewEligible
                  ? 'Yes (process completed and no observable Git mutation; review still required)'
                  : 'No'}
              </Field>
              {latest.cliVersion !== null ? (
                <Field label="CLI version">
                  <span className="font-mono text-xs">{latest.cliVersion}</span>
                </Field>
              ) : null}
              <Field label="Model">
                {latest.requestedModelId ?? 'Default'}
                {latest.effectiveModelId !== null ? (
                  <span className="text-muted-foreground">
                    {' '}
                    (reported: {latest.effectiveModelId})
                  </span>
                ) : null}
              </Field>
              {execution.workspace !== null ? (
                <>
                  <Field label="Task branch">
                    <span className="font-mono text-xs">{execution.workspace.branch}</span>
                  </Field>
                  <Field label="Base">
                    <span className="font-mono text-xs">
                      {execution.workspace.baseBranch} @ {execution.workspace.baseSha.slice(0, 12)}
                    </span>
                  </Field>
                  <Field label="Worktree">
                    <span className="font-mono text-xs break-all">{execution.workspace.path}</span>
                  </Field>
                </>
              ) : null}
              <Field label="Claimed">{formatTimestamp(latest.createdAt)}</Field>
              {latest.endedAt !== null ? (
                <Field label="Ended">{formatTimestamp(latest.endedAt)}</Field>
              ) : null}
              <Field label="Process containment">
                {latest.processContainment ?? 'process_group_only'} (descendants that leave the
                process group are not covered)
              </Field>
            </dl>
            {latest.summary !== null ? (
              <p className="rounded-lg border bg-inset p-3 break-words whitespace-pre-wrap">
                {latest.summary}
              </p>
            ) : null}
            <details className="rounded-lg border p-3">
              <summary className="cursor-pointer font-medium">
                Events ({execution.events.length}
                {latest.eventsDropped > 0 ? `, ${latest.eventsDropped} dropped` : ''})
              </summary>
              <ol className="mt-2 space-y-1 font-mono text-xs">
                {execution.events.map((event) => (
                  <li key={event.sequence} className="break-all">
                    <span className="text-muted-foreground">#{event.sequence}</span> {event.kind}{' '}
                    <span className="text-muted-foreground">{event.payload}</span>
                  </li>
                ))}
              </ol>
            </details>
            {earlier.length > 0 ? (
              <div className="space-y-1">
                <p className="font-medium">Earlier attempts</p>
                <ul className="space-y-1 text-muted-foreground">
                  {earlier.map((run) => {
                    const decision = decisionByRun.get(run.id);
                    return (
                      <li key={run.id}>
                        Attempt {run.attempt}: {taskRunStatusLabels[run.status]} —{' '}
                        {describeRunOutcome(run)}
                        {decision !== undefined ? ` · ${reviewStatusLabels[decision.status]}` : ''}
                        {describeRecovery(run.id)}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
};
