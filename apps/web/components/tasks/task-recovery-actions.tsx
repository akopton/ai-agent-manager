'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Ban, Info, Loader2, RotateCcw, StepForward } from 'lucide-react';
import { taskRecoveryKindLabels, type TaskStatus } from '@ai-agent-manager/core';

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
import { LifecycleButton } from '@/components/tasks/lifecycle-button';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import { taskResponseSchema } from '@/lib/tasks/contracts';
import { taskRecoverySegments, type TaskRecoveryOptions } from '@/lib/tasks/recovery';

type ActionProps = {
  projectId: string;
  task: { id: string; title: string; status: TaskStatus };
  options: TaskRecoveryOptions;
  size: 'sm' | 'default';
};

const UnavailableNote = ({ label, reason }: { label: string; reason: string }) => (
  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
    <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
    <span>
      {label} unavailable: {reason}
    </span>
  </p>
);

const ErrorAlert = ({ title, error }: { title: string; error: ClientError }) => (
  <Alert variant="destructive" role="alert">
    <AlertCircle aria-hidden="true" />
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription>
      <p>{error.message}</p>
    </AlertDescription>
  </Alert>
);

/**
 * Retry (Failed) or Resume (Stopped, Interrupted). The dialog explains that the action only queues
 * the task; the page changes only after the server confirms the transition.
 */
const RecoverDialog = ({ projectId, task, options, size }: ActionProps) => {
  const router = useRouter();
  const checkboxId = useId();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const recovery = options.recovery;
  if (recovery === null) return null;
  const label = taskRecoveryKindLabels[recovery.kind];
  if (!recovery.available) {
    return <UnavailableNote label={label} reason={recovery.unavailableReason ?? 'not available'} />;
  }
  const next = options.attempt + 1;
  const Icon = recovery.kind === 'retry' ? RotateCcw : StepForward;

  const handleOpenChange = (value: boolean) => {
    if (pending) return;
    setOpen(value);
    setConfirmed(false);
    setError(null);
  };

  const submit = async () => {
    setPending(true);
    setError(null);
    const result = await requestJson(
      'POST',
      `/api/projects/${projectId}/tasks/${task.id}/${taskRecoverySegments[recovery.kind]}`,
      taskResponseSchema,
      {
        runId: options.runId,
        ...(recovery.processConfirmationRequired ? { processStopConfirmed: confirmed } : {}),
      },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      // The task may have changed meanwhile; show its current state behind the dialog.
      router.refresh();
      return;
    }
    setOpen(false);
    router.refresh();
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <LifecycleButton
          action={recovery.kind}
          type="button"
          size={size}
          aria-label={`${label}: ${task.title}`}
        >
          <Icon aria-hidden="true" />
          {label}…
        </LifecycleButton>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {label} “{task.title}” as attempt {next}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This only queues the task. It does not start an agent. Nothing runs until you click{' '}
            <span className="font-medium text-foreground">Start execution</span> on the task page,
            which checks Trusted Local consent, project trust and the per-runtime limit again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="grid list-disc gap-2 pl-5 text-muted-foreground">
          {recovery.workspaceRetained ? (
            <li>
              Attempt {next} continues in the{' '}
              <span className="text-foreground">existing task worktree and branch</span>, with all
              current tracked and untracked changes. Nothing is reset, cleaned or recreated. The
              worktree is checked now and again before launch; if it was moved, unlocked, switched
              or committed to, the request is refused and nothing is changed.
            </li>
          ) : (
            <li>
              Attempt {options.attempt} ended before a task worktree was created, so attempt {next}{' '}
              creates one from the base branch.
            </li>
          )}
          <li>
            A new agent session is started with the original prompt and a note about the earlier
            attempt. The previous agent conversation is not restored.
          </li>
          {recovery.carriesFeedback ? (
            <li>
              Your latest review feedback is sent again, because no later attempt reached review.
            </li>
          ) : null}
          <li>All earlier attempts, events and review records are kept.</li>
          <li>
            Before queueing and again at Start, the app refuses if the old agent’s process group
            still exists. It cannot see processes that left that group, so stop any you started
            yourself or know about.
          </li>
        </ul>
        {recovery.processConfirmationRequired ? (
          <Alert variant="warning">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Check that the old agent is no longer running</AlertTitle>
            <AlertDescription>
              <p>
                The worker restarted after attempt {options.attempt} was authorized but before its
                process ID was recorded. AI Agent Manager therefore cannot check whether that agent
                is still running.
              </p>
              <p>
                If it is, the new attempt and the old agent would work in the same worktree at the
                same time and could overwrite each other’s changes. Verify it yourself before you
                continue, for example in Activity Monitor or with <code>ps</code>: look for a{' '}
                <code>claude</code> or <code>codex</code> process, and anything it started, still
                working in this task’s worktree. Stop any you find.
              </p>
              <label htmlFor={checkboxId} className="mt-2 flex items-start gap-2 text-foreground">
                <input
                  id={checkboxId}
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={confirmed}
                  disabled={pending}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  I verified that no agent process of attempt {options.attempt}, or process it
                  started, is still working in this task’s worktree.
                </span>
              </label>
            </AlertDescription>
          </Alert>
        ) : null}
        {error !== null ? <ErrorAlert title={`${label} was not recorded`} error={error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </AlertDialogCancel>
          {/* A plain button keeps the dialog open while the request runs and on failure. */}
          <LifecycleButton
            action={recovery.kind}
            onClick={() => void submit()}
            disabled={pending || (recovery.processConfirmationRequired && !confirmed)}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {pending ? 'Queueing…' : `${label} and queue`}
          </LifecycleButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** Discard after an explicit confirmation that states it is not Git cleanup. */
const DiscardDialog = ({ projectId, task, options, size }: ActionProps) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const discard = options.discard;
  if (discard === null) return null;
  if (!discard.available) {
    return (
      <UnavailableNote label="Discard" reason={discard.unavailableReason ?? 'not available'} />
    );
  }

  const handleOpenChange = (value: boolean) => {
    if (pending) return;
    setOpen(value);
    setError(null);
  };

  const submit = async () => {
    setPending(true);
    setError(null);
    const result = await requestJson(
      'POST',
      `/api/projects/${projectId}/tasks/${task.id}/discard`,
      taskResponseSchema,
      { runId: options.runId, confirmed: true },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      router.refresh();
      return;
    }
    setOpen(false);
    router.refresh();
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button type="button" size={size} variant="outline" aria-label={`Discard: ${task.title}`}>
          {/* Not the Archive icon: Discard rejects the result, Archive only hides the task. */}
          <Ban aria-hidden="true" />
          Discard…
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard “{task.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Discard is a logical task-state change, not Git cleanup. Nothing on disk or in Git is
            deleted or changed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3">
          <div>
            <p className="font-medium">Changed</p>
            <p className="text-muted-foreground">
              The task becomes Discarded. This is final: it can no longer be retried, resumed,
              reviewed or published.
            </p>
          </div>
          <div>
            <p className="font-medium">Kept unchanged</p>
            <p className="text-muted-foreground">
              The task and every attempt, event, review and publication record.
              {discard.workspaceRetained
                ? ' The task worktree with its tracked and untracked files, and the task branch. Nothing is reset, cleaned, removed, pruned, committed or pushed.'
                : ' Nothing is reset, cleaned, removed, pruned, committed or pushed.'}
            </p>
          </div>
          {discard.workspaceRetained ? (
            <p className="text-muted-foreground">
              Discard does not remove the worktree. Remove local worktree (on the task page) is a
              separate, confirmed action, offered only when the worktree holds no changes; it never
              deletes the task branch.
            </p>
          ) : null}
        </div>
        {error !== null ? <ErrorAlert title="The task was not discarded" error={error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button variant="destructive" onClick={() => void submit()} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {pending ? 'Discarding…' : 'Discard task'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

type TaskRecoveryActionsProps = {
  projectId: string;
  task: { id: string; title: string; status: TaskStatus };
  options: TaskRecoveryOptions | null | undefined;
  size?: 'sm' | 'default';
};

/** Retry/Resume and Discard for a task, as the server-derived options allow. */
export const TaskRecoveryActions = ({
  projectId,
  task,
  options,
  size = 'default',
}: TaskRecoveryActionsProps) => {
  if (options === null || options === undefined) return null;
  const props = { projectId, task, options, size };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <RecoverDialog {...props} />
        <DiscardDialog {...props} />
      </div>
    </div>
  );
};
