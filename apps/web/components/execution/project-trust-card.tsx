'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, ShieldCheck, ShieldOff } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import { projectTrustResponseSchema, type ProjectTrustView } from '@/lib/execution/contracts';

type ProjectTrustCardProps = {
  project: { id: string; localPath: string; gitCommonDir: string };
  trust: ProjectTrustView;
  trustedLocalEnabled: boolean;
  repositoryAvailable: boolean;
};

/**
 * Per-project Trusted Local trust. Granting shows and sends the exact repository identity (root
 * and common Git directory); the server re-checks it against the live repository.
 */
export const ProjectTrustCard = ({
  project,
  trust,
  trustedLocalEnabled,
  repositoryAvailable,
}: ProjectTrustCardProps) => {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const submit = async (grant: boolean) => {
    setPending(true);
    setError(null);
    const body = grant
      ? { trust: 'trusted_local', localPath: project.localPath, gitCommonDir: project.gitCommonDir }
      : { trust: 'none' };
    const result = await requestJson(
      'PUT',
      `/api/projects/${project.id}/execution-trust`,
      projectTrustResponseSchema,
      body,
    );
    setPending(false);
    setConfirmed(false);
    if (!result.ok) {
      setError(result.error);
    }
    router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h2>Agent execution</h2>
          {trust.current ? (
            <Badge variant="secondary">
              <ShieldCheck aria-hidden="true" />
              Trusted Local
            </Badge>
          ) : (
            <Badge variant="outline">Not trusted</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Agents run only for trusted repositories, as your user, in a task worktree that is not an
          OS-enforced boundary. See the disclosure in{' '}
          <Link href="/settings" className="underline underline-offset-4">
            Settings
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!trustedLocalEnabled ? (
          <p className="text-muted-foreground">
            Trusted Local Mode is off. Enable it in Settings before tasks of this project can run.
          </p>
        ) : null}
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[11rem_1fr]">
          <dt className="text-muted-foreground">Repository root</dt>
          <dd className="font-mono text-xs break-all">{project.localPath}</dd>
          <dt className="text-muted-foreground">Git directory</dt>
          <dd className="font-mono text-xs break-all">{project.gitCommonDir}</dd>
        </dl>
        {trust.current ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => void submit(false)}
          >
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <ShieldOff aria-hidden="true" />
            )}
            Revoke trust
          </Button>
        ) : (
          <div className="space-y-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-4"
                checked={confirmed}
                disabled={!repositoryAvailable}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                I trust this repository and its contents for local agent execution under Trusted
                Local Mode.
              </span>
            </label>
            <Button
              type="button"
              disabled={!confirmed || pending || !repositoryAvailable}
              onClick={() => void submit(true)}
            >
              {pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck aria-hidden="true" />
              )}
              Trust repository
            </Button>
          </div>
        )}
        {error !== null ? (
          <Alert variant="destructive" role="alert">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Trust was not changed</AlertTitle>
            <AlertDescription>
              <p>{error.message}</p>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
};
