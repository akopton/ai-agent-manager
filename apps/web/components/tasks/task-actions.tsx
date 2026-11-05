'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ListPlus, Loader2, Undo2 } from 'lucide-react';
import type { TaskStatus } from '@ai-agent-manager/core';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import {
  availableUserTaskActions,
  userTaskActionLabels,
  userTaskActionSegments,
  type UserTaskAction,
} from '@/lib/tasks/actions';
import { taskResponseSchema } from '@/lib/tasks/contracts';

const icons = { queue: ListPlus, return_to_backlog: Undo2 } as const;

type TaskActionsProps = {
  projectId: string;
  task: { id: string; title: string; status: TaskStatus };
  size?: 'sm' | 'default';
};

/**
 * The user actions the domain allows for the task's status. Each sends one named action; the page
 * is then refreshed from the server, so the board never shows a status the server did not store.
 */
export const TaskActions = ({ projectId, task, size = 'default' }: TaskActionsProps) => {
  const router = useRouter();
  const [pending, setPending] = useState<UserTaskAction | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const actions = availableUserTaskActions(task.status);

  if (actions.length === 0) {
    return null;
  }

  const run = async (action: UserTaskAction) => {
    setPending(action);
    setError(null);
    const result = await requestJson(
      'POST',
      `/api/projects/${projectId}/tasks/${task.id}/${userTaskActionSegments[action]}`,
      taskResponseSchema,
    );
    setPending(null);
    if (!result.ok) {
      setError(result.error);
    }
    // Refresh in both cases: after a conflict the board shows the task's current status.
    router.refresh();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const Icon = icons[action];
          return (
            <Button
              key={action}
              type="button"
              size={size}
              // Compact board cards keep the task title as the primary element.
              variant={action === 'queue' ? (size === 'sm' ? 'secondary' : 'default') : 'outline'}
              disabled={pending !== null}
              onClick={() => void run(action)}
              aria-label={`${userTaskActionLabels[action]}: ${task.title}`}
            >
              {pending === action ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Icon aria-hidden="true" />
              )}
              {userTaskActionLabels[action]}
            </Button>
          );
        })}
      </div>
      {error !== null ? (
        <Alert variant="destructive" role="alert">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>The task was not changed</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};
