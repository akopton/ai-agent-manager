'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2, RotateCw, Upload } from 'lucide-react';
import { isActivePublicationStatus, publicationStatusLabels } from '@ai-agent-manager/core';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTimestamp } from '@/lib/projects/format';
import { postJson, type ClientError } from '@/lib/projects/api-client';
import { publicationResponseSchema, type PublicationView } from '@/lib/review/contracts';
import { describePublicationFailure, shortSha } from '@/lib/review/format';

const refreshIntervalMs = 2_000;

/** Re-renders the page while a publication is in progress, so its progress becomes visible. */
const useRefreshWhile = (active: boolean) => {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), refreshIntervalMs);
    return () => clearInterval(timer);
  }, [active, router]);
};

const OperationList = ({ publication }: { publication: PublicationView }) => (
  <ol className="space-y-1 font-mono text-xs">
    {publication.operations.map((operation) => (
      <li key={`${operation.kind}-${operation.attempt}`} className="break-all">
        {operation.kind} #{operation.attempt}: {operation.status}
        {operation.outcome !== null ? ` (${operation.outcome.replaceAll('_', ' ')})` : ''}
        {operation.commitSha !== null ? ` · ${shortSha(operation.commitSha)}` : ''}
        {operation.errorCode !== null ? ` · ${operation.errorCode}` : ''}
        {operation.finishedAt !== null ? ` · ${formatTimestamp(operation.finishedAt)}` : ''}
      </li>
    ))}
  </ol>
);

type PublicationStatusProps = {
  projectId: string;
  taskId: string;
  /** The publication that holds the task, else the most recent one. */
  publication: PublicationView;
};

/**
 * Progress and outcome of an Approve & Push publication. Commit and push are shown separately; a
 * finished agent run or a created commit is never presented as a successful publication. When the
 * commit exists but the push failed, the only action is Retry push, which reuses that commit.
 */
export const PublicationStatus = ({ projectId, taskId, publication }: PublicationStatusProps) => {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const active = isActivePublicationStatus(publication.status);
  useRefreshWhile(active);

  const retryPush = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await postJson(
      `/api/projects/${projectId}/tasks/${taskId}/review/retry-push`,
      { publicationId: publication.id },
      publicationResponseSchema,
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  };

  const failed = publication.status === 'failed';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h2>Publication</h2>
          <Badge variant={failed ? 'destructive' : 'outline'}>
            {failed && publication.failureStage !== null
              ? `Failed at ${publication.failureStage}`
              : publicationStatusLabels[publication.status]}
          </Badge>
        </CardTitle>
        <CardDescription>
          Approved attempt {publication.attempt} · {publication.fileCount}{' '}
          {publication.fileCount === 1 ? 'file' : 'files'} ·{' '}
          {formatTimestamp(publication.createdAt)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {active ? (
          <Alert>
            <Loader2 className="animate-spin" aria-hidden="true" />
            <AlertTitle>{publicationStatusLabels[publication.status]}</AlertTitle>
            <AlertDescription>
              <p>
                The worker re-checks the approved snapshot, commits it on{' '}
                <span className="font-mono">{publication.branch}</span> and pushes that branch. This
                page updates automatically. If the worker is not running, the approval waits until
                it starts.
              </p>
            </AlertDescription>
          </Alert>
        ) : publication.status === 'pushed' ? (
          <Alert>
            <CheckCircle2 aria-hidden="true" />
            <AlertTitle>Committed and pushed</AlertTitle>
            <AlertDescription>
              <p>
                Commit <span className="font-mono">{shortSha(publication.commitSha ?? '')}</span> is
                on <span className="font-mono">{publication.remoteName}</span> as{' '}
                <span className="font-mono">refs/heads/{publication.branch}</span>. Nothing was
                merged; integrating the branch is up to you.
              </p>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive" role="alert">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{describePublicationFailure(publication)}</AlertTitle>
            <AlertDescription>
              {publication.errorMessage !== null ? <p>{publication.errorMessage}</p> : null}
              {publication.errorCode !== null ? (
                <p className="mt-1 font-mono text-xs">{publication.errorCode}</p>
              ) : null}
            </AlertDescription>
          </Alert>
        )}

        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[11rem_1fr]">
          <dt className="text-muted-foreground">Destination</dt>
          <dd className="min-w-0 font-mono text-xs break-all">
            {publication.remoteName} ({publication.remoteUrl}) → refs/heads/{publication.branch}
          </dd>
          <dt className="text-muted-foreground">Commit</dt>
          <dd className="min-w-0 font-mono text-xs break-all">
            {publication.commitSha ?? 'not created'}
          </dd>
          <dt className="text-muted-foreground">Snapshot</dt>
          <dd className="min-w-0 font-mono text-xs break-all">{publication.snapshotHash}</dd>
        </dl>

        {publication.operations.length > 0 ? <OperationList publication={publication} /> : null}

        {publication.canRetryPush ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              The commit stays on the task branch. Retry push sends the same commit again; it is
              never recreated, and an identical remote branch is reported as up to date.
            </p>
            {error !== null ? (
              <Alert variant="destructive" role="alert">
                <AlertCircle aria-hidden="true" />
                <AlertTitle>The retry was not recorded</AlertTitle>
                <AlertDescription>
                  <p>{error.message}</p>
                </AlertDescription>
              </Alert>
            ) : null}
            <Button type="button" disabled={pending} onClick={() => void retryPush()}>
              {pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <RotateCw aria-hidden="true" />
              )}
              Retry push
            </Button>
          </div>
        ) : null}
        {failed && !publication.canRetryPush ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Upload className="size-4" aria-hidden="true" />
            Nothing was published. Review the current changes; you can approve again when they are
            eligible.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
};
