'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, Play, Square } from 'lucide-react';
import type { TaskStatus } from '@ai-agent-manager/core';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { LifecycleButton } from '@/components/tasks/lifecycle-button';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import { taskExecutionResponseSchema, type TaskExecutionView } from '@/lib/execution/contracts';

/** The existing Start/Stop commands, shared by the details header and execution-panel callers. */
export const TaskExecutionActions = ({
  projectId,
  task,
  execution,
}: {
  projectId: string;
  task: { id: string; status: TaskStatus };
  execution: TaskExecutionView;
}) => {
  const router = useRouter();
  const [pending, setPending] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const latest = execution.runs[0];
  const canStart = task.status === 'queued' && execution.lastCommand?.status !== 'pending';
  const canStop = latest?.active === true && latest.stopRequestedAt === null;

  const send = async (command: 'start' | 'stop') => {
    if (pending !== null) return;
    setPending(command);
    setError(null);
    const result = await requestJson(
      'POST',
      `/api/projects/${projectId}/tasks/${task.id}/${command}`,
      taskExecutionResponseSchema,
    );
    setPending(null);
    if (!result.ok) setError(result.error);
    router.refresh();
  };

  if (!canStart && !canStop && error === null) return null;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap gap-2">
        {canStart ? (
          <LifecycleButton
            action="start"
            type="button"
            title="Requests execution; the worker moves the task to In Progress after its checks."
            disabled={pending !== null}
            onClick={() => void send('start')}
          >
            {pending === 'start' ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
            Start execution
          </LifecycleButton>
        ) : null}
        {canStop ? (
          <Button
            type="button"
            variant="destructive"
            disabled={pending !== null}
            onClick={() => void send('stop')}
          >
            {pending === 'stop' ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Square aria-hidden="true" />
            )}
            Stop
          </Button>
        ) : null}
      </div>
      {error === null ? null : (
        <Alert variant="destructive" role="alert">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>The request was not accepted</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
};
