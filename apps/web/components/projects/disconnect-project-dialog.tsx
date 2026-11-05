'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, Unlink } from 'lucide-react';

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
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import { disconnectProjectResponseSchema } from '@/lib/projects/contracts';
import { disconnectedProjectsUrl } from '@/lib/projects/feedback';

type DisconnectProjectDialogProps = {
  project: { id: string; name: string; localPath: string };
  /** Tasks that reference the project. While there are any, disconnecting is refused. */
  taskCount: number;
};

export const DisconnectProjectDialog = ({ project, taskCount }: DisconnectProjectDialogProps) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (pending) {
      return;
    }
    setOpen(next);
    setError(null);
  };

  const handleDisconnect = async () => {
    setPending(true);
    setError(null);
    const result = await requestJson(
      'DELETE',
      `/api/projects/${project.id}`,
      disconnectProjectResponseSchema,
    );
    if (!result.ok) {
      setPending(false);
      setError(result.error);
      return;
    }
    router.push(disconnectedProjectsUrl(result.data.disconnected.name));
    router.refresh();
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">
          <Unlink aria-hidden="true" />
          Disconnect…
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect “{project.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the project from AI Agent Manager only. Nothing on disk is deleted or
            changed.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-3">
          <div>
            <p className="font-medium">Removed from AI Agent Manager</p>
            <p className="text-muted-foreground">
              The project entry and its settings: name, priority, project instructions, default base
              branch and remote selection.
            </p>
          </div>
          <div>
            <p className="font-medium">Kept unchanged</p>
            <p className="text-muted-foreground">
              The repository and everything in it: files and uncommitted changes, branches,
              worktrees, remotes, Git configuration and history.
            </p>
            <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
              {project.localPath}
            </p>
          </div>
          <p className="text-muted-foreground">
            A project that still has tasks or other records is not disconnected. You can add the
            repository again at any time.
          </p>
        </div>

        {taskCount > 0 ? (
          <Alert variant="warning">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>
              This project has {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
            </AlertTitle>
            <AlertDescription>
              <p>
                It cannot be disconnected while tasks exist. Task deletion is not available yet, so
                the tasks and the project stay as they are.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {error !== null ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>The project was not disconnected</AlertTitle>
            <AlertDescription>
              <p>{error.message}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </AlertDialogCancel>
          {/* A plain button keeps the dialog open while the request runs and on failure. */}
          <Button
            variant="destructive"
            onClick={() => void handleDisconnect()}
            disabled={pending || taskCount > 0}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {pending ? 'Disconnecting…' : 'Disconnect project'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
