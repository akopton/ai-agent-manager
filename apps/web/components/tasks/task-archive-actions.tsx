'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArchiveRestore, FolderArchive, Info, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import { taskResponseSchema } from '@/lib/tasks/contracts';
import type { TaskArchiveOption } from '@/lib/tasks/workspace';

type TaskArchiveActionsProps = {
  projectId: string;
  task: { id: string; title: string };
  option: TaskArchiveOption | null | undefined;
  size?: 'sm' | 'default';
  /** Show why Archive is unavailable (Task Details); board cards stay compact. */
  showUnavailableReason?: boolean;
};

/**
 * Archive (hide from the default board) or Restore (show it again with its original status). Both
 * are reversible visibility changes: unlike Discard they change no status, and unlike Remove local
 * worktree they touch nothing on disk. The page changes only after the server confirms.
 */
export const TaskArchiveActions = ({
  projectId,
  task,
  option,
  size = 'default',
  showUnavailableReason = false,
}: TaskArchiveActionsProps) => {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  if (option === null || option === undefined) return null;
  const action = option.archived ? 'restore' : 'archive';
  if (!option.archived && !option.available) {
    return showUnavailableReason && option.reason !== null ? (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        <span>Archive unavailable: {option.reason}</span>
      </p>
    ) : null;
  }

  const run = async () => {
    setPending(true);
    setError(null);
    const result = await requestJson(
      'POST',
      `/api/projects/${projectId}/tasks/${task.id}/${action}`,
      taskResponseSchema,
    );
    setPending(false);
    if (!result.ok) setError(result.error);
    router.refresh();
  };

  const label = action === 'archive' ? 'Archive' : 'Restore';
  const Icon = action === 'archive' ? FolderArchive : ArchiveRestore;
  return (
    <div className="space-y-2">
      <Button
        type="button"
        size={size}
        variant={action === 'restore' && size === 'default' ? 'default' : 'outline'}
        disabled={pending}
        onClick={() => void run()}
        aria-label={`${label}: ${task.title}`}
        title={
          action === 'archive'
            ? 'Hide from the board. Nothing is deleted; restore it any time.'
            : 'Show on the board again with its original status.'
        }
      >
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <Icon aria-hidden="true" />
        )}
        {label}
      </Button>
      {error !== null ? (
        <Alert variant="destructive" role="alert">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>{`The task was not ${action === 'archive' ? 'archived' : 'restored'}`}</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};
