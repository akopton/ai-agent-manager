'use client';

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, MessageSquareReply } from 'lucide-react';
import {
  reviewFeedbackMaxLength,
  reviewFeedbackMinLength,
  reviewFeedbackSchema,
} from '@ai-agent-manager/core';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { postJson, type ClientError } from '@/lib/projects/api-client';
import { requestChangesResponseSchema } from '@/lib/review/contracts';
import { taskUrl } from '@/lib/tasks/board';

/** Errors that mean the page shows an outdated review; refreshing resolves them. */
const conflictCodes = new Set([
  'review_run_changed',
  'review_changes_changed',
  'task_not_in_review',
  'changes_already_requested',
  'run_not_review_eligible',
]);

type RequestChangesFormProps = {
  projectId: string;
  taskId: string;
  runId: string;
  attempt: number;
  /** Change-inventory revision shown on the page; a changed worktree makes the request fail. */
  revision: string;
};

/**
 * Request Changes (M6-02): stores feedback for the reviewed attempt and returns the task to
 * Queued. It never starts an agent; the follow-up attempt runs after an explicit Start execution.
 */
export const RequestChangesForm = ({
  projectId,
  taskId,
  runId,
  attempt,
  revision,
}: RequestChangesFormProps) => {
  const router = useRouter();
  const fieldId = useId();
  const [feedback, setFeedback] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const parsed = reviewFeedbackSchema.safeParse(feedback);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Enter your feedback.');
      return;
    }
    setFieldError(null);
    setError(null);
    setPending(true);
    const result = await postJson(
      `/api/projects/${projectId}/tasks/${taskId}/review/request-changes`,
      { runId, revision, feedback: parsed.data },
      requestChangesResponseSchema,
    );
    if (!result.ok) {
      setPending(false);
      setError(result.error);
      return;
    }
    // Keep the form disabled: the refreshed page shows the stored request instead of the form.
    router.refresh();
  };

  const conflict = error !== null && conflictCodes.has(error.code);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Request changes</h2>
        </CardTitle>
        <CardDescription>
          Describe what the agent should change in attempt {attempt}. Your feedback is stored with
          this attempt and sent, together with the original task prompt, to the next attempt.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4 text-sm" onSubmit={(event) => void submit(event)} noValidate>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-feedback`}>Feedback</Label>
            <Textarea
              id={`${fieldId}-feedback`}
              name="feedback"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              maxLength={reviewFeedbackMaxLength}
              rows={6}
              required
              disabled={pending}
              placeholder="For example: Rename hello.txt to greeting.txt and add a trailing newline."
              aria-invalid={fieldError !== null}
              aria-describedby={`${fieldId}-hint${fieldError === null ? '' : ` ${fieldId}-error`}`}
            />
            <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
              {reviewFeedbackMinLength}–{reviewFeedbackMaxLength.toLocaleString('en')} characters (
              {feedback.trim().length.toLocaleString('en')} now).
            </p>
            {fieldError !== null ? (
              <p id={`${fieldId}-error`} className="text-xs text-destructive">
                {fieldError}
              </p>
            ) : null}
          </div>
          <div className="rounded-lg border bg-muted/30 p-3 text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">What happens next:</span> the task
              returns to <span className="font-medium text-foreground">Queued</span>. No agent
              starts automatically: start attempt {attempt + 1} explicitly with Start execution on
              the task page.
            </p>
            <p className="mt-1">
              Attempt {attempt + 1} continues in the same task worktree and branch, from the current
              uncommitted and untracked changes. Nothing is reset, cleaned, committed or pushed.
              Attempt {attempt}’s run record stays in the history.
            </p>
          </div>
          {error !== null ? (
            <Alert variant={conflict ? 'warning' : 'destructive'} role="alert">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>
                {conflict ? 'The review is out of date' : 'The change request was not saved'}
              </AlertTitle>
              <AlertDescription>
                <p>{error.message}</p>
                {conflict ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => router.refresh()}
                  >
                    Refresh the review
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <MessageSquareReply aria-hidden="true" />
              )}
              Request changes
            </Button>
            <Button asChild variant="ghost">
              <Link href={taskUrl(projectId, taskId)}>Cancel</Link>
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
};
