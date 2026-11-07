'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, FolderGit2, FolderLock, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import {
  projectSourceAccessResponseSchema,
  type ProjectSourceAccessView,
} from '@/lib/conversations/contracts';
import { describeSourceAccessReason } from '@/lib/conversations/sources';

type ProjectSourceAccessCardProps = {
  projectId: string;
  projectName: string;
  sourceAccess: ProjectSourceAccessView;
};

/**
 * C4 — the explicit per-project permission to send tracked working-tree source excerpts to the selected CLI
 * in Project-Aware conversations. Separate from the AI Conversations acceptance and from Trusted
 * Local execution trust. The grant names the repository identity and disclosure version shown;
 * the server re-checks both.
 */
export const ProjectSourceAccessCard = ({
  projectId,
  projectName,
  sourceAccess,
}: ProjectSourceAccessCardProps) => {
  const router = useRouter();
  const id = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const submit = async (allow: boolean) => {
    setPending(true);
    setError(null);
    const result = await requestJson(
      'PUT',
      `/api/projects/${projectId}/conversation-source-access`,
      projectSourceAccessResponseSchema,
      allow
        ? {
            access: 'allowed',
            gitCommonDir: sourceAccess.gitCommonDir,
            disclosureVersion: sourceAccess.disclosure.version,
          }
        : { access: 'none' },
    );
    setPending(false);
    setConfirmed(false);
    if (!result.ok) {
      setError(result.error);
    }
    router.refresh();
  };

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 text-sm">
      <h3 id={`${id}-title`} className="flex flex-wrap items-center gap-2 font-semibold">
        Source sharing
        {sourceAccess.current ? (
          <Badge variant="secondary">
            <FolderGit2 aria-hidden="true" />
            Allowed
          </Badge>
        ) : (
          <Badge variant="outline">
            <FolderLock aria-hidden="true" />
            Not allowed
          </Badge>
        )}
      </h3>
      {sourceAccess.current ? (
        <>
          <p className="leading-6 text-muted-foreground">
            Project-Aware conversations of {projectName} may send excerpts of eligible tracked files
            from <span className="font-mono text-xs break-all">{sourceAccess.localPath}</span> to
            the selected CLI.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void submit(false)}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Stop sharing source
          </Button>
        </>
      ) : (
        <>
          <p className="leading-6 text-muted-foreground">
            {describeSourceAccessReason(sourceAccess.reason)}
          </p>
          <details className="rounded-lg border bg-inset/60 px-3 py-2">
            <summary className="cursor-pointer font-medium">
              {sourceAccess.disclosure.title}
            </summary>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-xs leading-5 text-muted-foreground">
              {sourceAccess.disclosure.statements.map((statement) => (
                <li key={statement}>{statement}</li>
              ))}
            </ul>
            <dl className="mt-2 grid gap-1 text-xs">
              <dt className="text-muted-foreground">Repository</dt>
              <dd className="font-mono break-all">{sourceAccess.localPath}</dd>
            </dl>
          </details>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span className="leading-6">
              I allow Project-Aware conversations of {projectName} to send excerpts of this
              repository’s eligible tracked files to Claude Code or Codex.
            </span>
          </label>
          <Button
            type="button"
            size="sm"
            disabled={!confirmed || pending}
            onClick={() => void submit(true)}
          >
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <FolderGit2 aria-hidden="true" />
            )}
            Allow source sharing
          </Button>
        </>
      )}
      {error !== null ? (
        <Alert variant="destructive" role="alert">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Source sharing was not changed</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
};
