'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, GitBranch, Loader2, Upload } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { postJson, type ClientError } from '@/lib/projects/api-client';
import {
  publicationResponseSchema,
  type ChangedFileView,
  type PublicationPanel,
} from '@/lib/review/contracts';
import { describeFileChange, publicationReadinessMessages, shortSha } from '@/lib/review/format';

/** Errors that mean the page shows an outdated review or destination; refreshing resolves them. */
const conflictCodes = new Set([
  'review_run_changed',
  'review_changes_changed',
  'task_not_in_review',
  'review_decision_exists',
  'publication_in_progress',
  'publication_push_pending',
  'publication_target_changed',
  'run_not_review_eligible',
]);

type ApprovePublishPanelProps = {
  projectId: string;
  taskId: string;
  runId: string;
  attempt: number;
  /** Change-inventory revision shown on the page; a changed worktree makes the approval fail. */
  revision: string;
  files: ChangedFileView[];
  baseBranch: string;
  baseSha: string;
  publication: PublicationPanel;
};

const newRequestId = (): string => crypto.randomUUID();

/**
 * Approve & Push (M6-03). Shows exactly what would be committed and where it would be pushed, and
 * records the approval only after a separate, explicit confirmation. The request carries what was
 * shown (attempt, revision, remote, branch); the server re-checks each value and generates the
 * commit message itself. The worker then commits on the task branch and pushes that branch only.
 */
export const ApprovePublishPanel = ({
  projectId,
  taskId,
  runId,
  attempt,
  revision,
  files,
  baseBranch,
  baseSha,
  publication,
}: ApprovePublishPanelProps) => {
  const router = useRouter();
  const checkboxId = useId();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  // One request ID per confirmation dialog: a double click or a retried request after a lost
  // response returns the same approval instead of creating a second one.
  const [requestId, setRequestId] = useState(newRequestId);

  const { destination, commitMessage, readiness } = publication;

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (next) {
      setConfirmed(false);
      setError(null);
      setRequestId(newRequestId());
    }
  };

  const approve = async () => {
    if (pending || !confirmed || destination === null) return;
    setPending(true);
    setError(null);
    const result = await postJson(
      `/api/projects/${projectId}/tasks/${taskId}/review/approve`,
      {
        requestId,
        runId,
        revision,
        remoteName: destination.remoteName,
        branch: destination.branch,
        confirmed: true,
      },
      publicationResponseSchema,
    );
    if (!result.ok) {
      setPending(false);
      setError(result.error);
      return;
    }
    setOpen(false);
    setPending(false);
    router.refresh();
  };

  const conflict = error !== null && conflictCodes.has(error.code);
  const ready = readiness.ready && destination !== null && commitMessage !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Approve &amp; Push</h2>
        </CardTitle>
        <CardDescription>
          Commit exactly the reviewed changes of attempt {attempt} on the task branch and push that
          branch to the project’s remote. Nothing is merged into {baseBranch}, and no pull request
          is opened.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!ready ? (
          <Alert variant="warning">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Approve &amp; Push is not available</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {readiness.reasons.map((reason) => (
                  <li key={reason}>{publicationReadinessMessages[reason]}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[11rem_1fr]">
          <dt className="text-muted-foreground">Source</dt>
          <dd className="min-w-0 font-mono text-xs break-all">
            task worktree of attempt {attempt}, based on {baseBranch} @ {shortSha(baseSha)}
          </dd>
          <dt className="text-muted-foreground">Commit on</dt>
          <dd className="min-w-0 font-mono text-xs break-all">
            {destination?.branch ?? '—'} (local task branch)
          </dd>
          <dt className="text-muted-foreground">Push to</dt>
          <dd className="min-w-0 font-mono text-xs break-all">
            {destination === null
              ? 'No destination'
              : `${destination.remoteName} (${destination.remoteUrl}) → ${destination.remoteRef}`}
          </dd>
        </dl>

        {commitMessage !== null ? (
          <div className="space-y-1">
            <p className="font-medium">Commit message</p>
            <pre className="rounded-lg border bg-inset p-3 font-mono text-xs break-words whitespace-pre-wrap">
              {commitMessage}
            </pre>
          </div>
        ) : null}

        {ready ? (
          <AlertDialog open={open} onOpenChange={handleOpenChange}>
            <AlertDialogTrigger asChild>
              <Button type="button">
                <Upload aria-hidden="true" />
                Approve &amp; Push…
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
              <AlertDialogHeader>
                <AlertDialogTitle>Commit and push {files.length} reviewed files?</AlertDialogTitle>
                <AlertDialogDescription>
                  The worker re-checks the worktree first. If anything changed since this review,
                  nothing is committed and you have to review again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-3 text-sm">
                <ul className="max-h-48 overflow-y-auto rounded-lg border p-2 font-mono text-xs">
                  {files.map((file) => (
                    <li key={file.path} className="flex gap-2 break-all">
                      <span className="w-20 shrink-0 text-muted-foreground">
                        {describeFileChange(file)}
                      </span>
                      <span>
                        {file.previousPath !== null ? `${file.previousPath} → ` : ''}
                        {file.path}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="rounded-lg border bg-inset p-3">
                  <p className="font-medium">What happens</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                    <li>
                      One commit with exactly these files (including untracked ones; Git-ignored
                      files are never included) is created on{' '}
                      <span className="font-mono">{destination.branch}</span>.
                    </li>
                    <li>
                      That branch is pushed to{' '}
                      <span className="font-mono">
                        {destination.remoteName} ({destination.remoteUrl})
                      </span>{' '}
                      as <span className="font-mono">{destination.remoteRef}</span>, without force.
                      A remote branch with other commits is not overwritten.
                    </li>
                    <li>
                      {baseBranch} is not changed, nothing is merged, no pull request is opened and
                      no agent is started.
                    </li>
                    <li>The task moves to Done only after both the commit and the push succeed.</li>
                  </ul>
                </div>
                <label htmlFor={checkboxId} className="flex items-start gap-2">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={confirmed}
                    disabled={pending}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>
                    I reviewed these changes and want to commit them and push{' '}
                    <span className="font-mono">{destination.branch}</span> to{' '}
                    <span className="font-mono">{destination.remoteName}</span>.
                  </span>
                </label>
                {error !== null ? (
                  <Alert variant={conflict ? 'warning' : 'destructive'} role="alert">
                    <AlertCircle aria-hidden="true" />
                    <AlertTitle>
                      {conflict ? 'The review is out of date' : 'The approval was not recorded'}
                    </AlertTitle>
                    <AlertDescription>
                      <p>{error.message}</p>
                      {conflict ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() => {
                            setOpen(false);
                            router.refresh();
                          }}
                        >
                          Refresh the review
                        </Button>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel asChild>
                  <Button type="button" variant="outline" disabled={pending}>
                    Cancel
                  </Button>
                </AlertDialogCancel>
                {/* A plain button keeps the dialog open while the request runs and on failure. */}
                <Button
                  type="button"
                  disabled={!confirmed || pending}
                  onClick={() => void approve()}
                >
                  {pending ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <GitBranch aria-hidden="true" />
                  )}
                  Approve &amp; Push
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </CardContent>
    </Card>
  );
};
