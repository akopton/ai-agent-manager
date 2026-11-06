'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, FolderX, Info, Loader2 } from 'lucide-react';
import {
  isActiveWorkspaceCleanupStatus,
  workspaceCleanupStatusLabels,
} from '@ai-agent-manager/core';

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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { postJson, type ClientError } from '@/lib/projects/api-client';
import { formatTimestamp } from '@/lib/projects/format';
import { shortSha } from '@/lib/review/format';
import { workspaceCleanupResponseSchema, type WorkspacePanel } from '@/lib/tasks/workspace';

const refreshIntervalMs = 2_000;

const stateBadges: Readonly<
  Record<
    WorkspacePanel['state'],
    { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }
  >
> = {
  none: { label: 'No worktree', variant: 'secondary' },
  retained: { label: 'Retained', variant: 'success' },
  missing: { label: 'Missing', variant: 'warning' },
  inconsistent: { label: 'Not verified', variant: 'warning' },
  unavailable: { label: 'Cannot inspect', variant: 'destructive' },
  removed: { label: 'Removed', variant: 'secondary' },
};

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </>
);

const describeLock = (git: NonNullable<WorkspacePanel['git']>): string => {
  if (!git.registered) return 'Not registered with Git';
  if (!git.locked) return 'Not locked';
  return git.managedLock ? 'Locked by AI Agent Manager' : 'Locked with another reason';
};

const describeWorkingTree = (git: NonNullable<WorkspacePanel['git']>): string => {
  const tree = git.workingTree;
  if (tree === null) return 'Not inspected';
  if (tree.clean) return 'Clean (no uncommitted or untracked files)';
  const changed = tree.staged + tree.unstaged + tree.conflicted;
  return [
    changed > 0 ? `${changed} changed` : undefined,
    tree.untracked > 0 ? `${tree.untracked} untracked` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(', ');
};

type RemoveDialogProps = {
  projectId: string;
  task: { id: string; title: string };
  panel: WorkspacePanel & {
    workspace: NonNullable<WorkspacePanel['workspace']>;
  };
  expectedCommit: string;
};

/** The separately confirmed Remove local worktree action. */
const RemoveWorktreeDialog = ({ projectId, task, panel, expectedCommit }: RemoveDialogProps) => {
  const router = useRouter();
  const checkboxId = useId();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  // One request ID per dialog opening: a double submit is deduplicated by the server.
  const [requestId, setRequestId] = useState('');
  const { workspace } = panel;

  const handleOpenChange = (value: boolean) => {
    if (pending) return;
    setOpen(value);
    setConfirmed(false);
    setError(null);
    if (value) setRequestId(crypto.randomUUID());
  };

  const submit = async () => {
    setPending(true);
    setError(null);
    const result = await postJson(
      `/api/projects/${projectId}/tasks/${task.id}/workspace/cleanup`,
      { requestId, workspaceId: workspace.id, expectedCommit, confirmed: true },
      workspaceCleanupResponseSchema,
    );
    setPending(false);
    router.refresh();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          aria-label={`Remove local worktree: ${task.title}`}
        >
          <FolderX aria-hidden="true" />
          Remove local worktree…
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove the local worktree of “{task.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the task’s worktree directory from disk. It is not Archive and not Discard,
            and it cannot be undone from AI Agent Manager.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3">
          <div>
            <p className="font-medium">Removed</p>
            <p className="break-all text-muted-foreground">
              The directory <code className="font-mono text-xs">{workspace.path}</code> and its Git
              worktree registration, with a non-forced <code>git worktree remove</code>.
            </p>
          </div>
          <div>
            <p className="font-medium">Kept unchanged</p>
            <p className="text-muted-foreground">
              The local task branch <code className="font-mono text-xs">{workspace.branch}</code> at{' '}
              <code className="font-mono text-xs">{shortSha(expectedCommit)}</code>, any remote
              branch, the main project checkout, other worktrees, and every task, attempt, review
              and publication record.
            </p>
          </div>
          <p className="text-muted-foreground">
            The worker checks the worktree again right before removing it. If it is no longer clean,
            locked, on the task branch at this commit, or at its managed location, nothing is
            removed.
          </p>
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
          <span>I understand that this worktree directory will be deleted from disk.</span>
        </label>
        {error !== null ? (
          <Alert variant="destructive" role="alert">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>The removal was not requested</AlertTitle>
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
            onClick={() => void submit()}
            disabled={pending || !confirmed}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {pending ? 'Requesting…' : 'Remove local worktree'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

type TaskWorkspacePanelProps = {
  projectId: string;
  task: { id: string; title: string };
  panel: WorkspacePanel;
};

/**
 * The task's managed worktree: where it is, what Git reports about it now, and whether it can be
 * removed. Refreshes while a removal is requested or running.
 */
export const TaskWorkspacePanel = ({ projectId, task, panel }: TaskWorkspacePanelProps) => {
  const router = useRouter();
  const pending = panel.current !== null && isActiveWorkspaceCleanupStatus(panel.current.status);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => router.refresh(), refreshIntervalMs);
    return () => clearInterval(timer);
  }, [pending, router]);

  const badge = stateBadges[panel.state];
  const { workspace, git, cleanup, current } = panel;
  return (
    <Card aria-labelledby="workspace-title">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h2 id="workspace-title">Local worktree</h2>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </CardTitle>
        <CardDescription>
          The managed Git worktree this task ran in. Archive and Discard never remove it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {workspace === null ? (
          <p className="text-sm text-muted-foreground">
            No worktree was created for this task. It is created when the task first starts.
          </p>
        ) : (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[11rem_1fr]">
            <Field label="Path">
              <code className="font-mono text-xs break-all">{workspace.path}</code>
            </Field>
            <Field label="Task branch">
              <code className="font-mono text-xs">{workspace.branch}</code>
              {git?.branchCommit != null ? (
                <span className="text-muted-foreground">
                  {' '}
                  at <code className="font-mono text-xs">{shortSha(git.branchCommit)}</code>
                </span>
              ) : null}
            </Field>
            <Field label="Base">
              <code className="font-mono text-xs">{workspace.baseBranch}</code>
              <span className="text-muted-foreground">
                {' '}
                at <code className="font-mono text-xs">{shortSha(workspace.baseSha)}</code>
              </span>
            </Field>
            {git !== null ? (
              <>
                <Field label="Lock">{describeLock(git)}</Field>
                <Field label="Working tree">{describeWorkingTree(git)}</Field>
                {git.ignoredCount !== null ? (
                  <Field label="Ignored files">
                    {git.ignoredCount === 0 ? 'None' : `${git.ignoredCount} Git-ignored paths`}
                  </Field>
                ) : null}
                <Field label="Identity">
                  {git.identityVerified ? (
                    'Verified managed task worktree'
                  ) : (
                    <span className="text-warning">Not verified: {git.identityReason}</span>
                  )}
                </Field>
              </>
            ) : null}
            <Field label="Created">{formatTimestamp(workspace.createdAt)}</Field>
          </dl>
        )}

        {current !== null && isActiveWorkspaceCleanupStatus(current.status) ? (
          <Alert variant="info" role="status">
            <Loader2 className="animate-spin" aria-hidden="true" />
            <AlertTitle>{workspaceCleanupStatusLabels[current.status]}</AlertTitle>
            <AlertDescription>
              <p>The worker verifies the worktree again before it removes anything.</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {current?.status === 'removed' ? (
          <Alert variant="success">
            <CheckCircle2 aria-hidden="true" />
            <AlertTitle>Local worktree removed</AlertTitle>
            <AlertDescription>
              <p>
                Removed {current.removedAt === null ? '' : formatTimestamp(current.removedAt)}.{' '}
                {current.branchCommit !== null
                  ? `The task branch was kept at ${shortSha(current.branchCommit)}.`
                  : 'The task branch was not found after the removal.'}{' '}
                All task, attempt, review and publication records are kept.
              </p>
              {current.errorMessage !== null ? <p>{current.errorMessage}</p> : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {current?.status === 'failed' ? (
          <Alert variant="warning">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>The last removal did not complete</AlertTitle>
            <AlertDescription>
              <p>{current.errorMessage ?? 'Nothing was removed.'}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {cleanup.available && workspace !== null && cleanup.expectedCommit !== null ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {cleanup.basis === 'published'
                ? 'The reviewed changes were committed and the push to the task branch was confirmed, and the worktree is clean at that commit.'
                : 'The task was discarded and its worktree holds no changes or commits.'}
            </p>
            <RemoveWorktreeDialog
              projectId={projectId}
              task={task}
              panel={{ ...panel, workspace }}
              expectedCommit={cleanup.expectedCommit}
            />
          </div>
        ) : panel.state !== 'none' && panel.state !== 'removed' && !pending ? (
          <div className="space-y-1">
            <p className="flex items-start gap-1.5 text-sm font-medium">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              Remove local worktree unavailable
            </p>
            <ul className="list-disc space-y-1 pl-10 text-sm text-muted-foreground">
              {cleanup.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};
