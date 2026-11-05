import { reviewStatusLabels, taskRunStatusLabels } from '@ai-agent-manager/core';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ReviewDecisionView, TaskRunView } from '@/lib/execution/contracts';
import { describeIntegrity, describeRunOutcome } from '@/lib/execution/format';
import { formatTimestamp } from '@/lib/projects/format';

type AttemptHistoryProps = {
  attempts: readonly TaskRunView[];
  decisions: readonly ReviewDecisionView[];
};

/**
 * Every attempt of the task with its run status, execution outcome, Git integrity result and the
 * review decision about it. Task status, run status and review decisions are shown separately.
 */
export const AttemptHistory = ({ attempts, decisions }: AttemptHistoryProps) => {
  if (attempts.length === 0) {
    return null;
  }
  const decisionByRun = new Map(decisions.map((decision) => [decision.runId, decision]));
  const decisionByFollowUp = new Map(
    decisions.flatMap((decision) =>
      decision.followUpRunId === null ? [] : [[decision.followUpRunId, decision] as const],
    ),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Attempts and review history</h2>
        </CardTitle>
        <CardDescription>
          Each attempt keeps its own run record and events. Follow-up attempts continue in the same
          worktree, so the changes shown above are the current worktree state, not a snapshot of an
          earlier attempt.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3 text-sm">
          {attempts.map((run) => {
            const decision = decisionByRun.get(run.id);
            const continued = decisionByFollowUp.get(run.id);
            return (
              <li key={run.id} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Attempt {run.attempt}</span>
                  <Badge variant="outline">{taskRunStatusLabels[run.status]}</Badge>
                  {decision !== undefined ? (
                    <Badge variant="secondary">{reviewStatusLabels[decision.status]}</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {formatTimestamp(run.createdAt)}
                  </span>
                </div>
                <p className="text-muted-foreground">
                  {describeRunOutcome(run)} · Git integrity: {describeIntegrity(run)}
                </p>
                {continued !== undefined ? (
                  <p className="text-muted-foreground">
                    Continued attempt {continued.attempt} in the same worktree with its review
                    feedback.
                  </p>
                ) : null}
                {decision !== undefined ? (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Feedback submitted {formatTimestamp(decision.createdAt)}
                      {decision.followUpAttempt !== null
                        ? ` · addressed by attempt ${decision.followUpAttempt}`
                        : ' · waiting for an explicit Start'}
                    </p>
                    <p className="rounded-lg border bg-muted/30 p-3 break-words whitespace-pre-wrap">
                      {decision.feedback}
                    </p>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
};
