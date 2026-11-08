import type { CSSProperties } from 'react';
import { taskTransitions, type TaskAction, type TaskStatus } from '@ai-agent-manager/core';

/** Shared by column indicators and lifecycle buttons; never follows the selected accent. */
const taskStatusColors: Readonly<Record<TaskStatus, string>> = {
  backlog: 'var(--muted-foreground)',
  queued: 'var(--info)',
  in_progress: 'var(--success)',
  review: 'var(--review)',
  done: 'var(--success)',
  stopped: 'var(--warning)',
  interrupted: 'var(--warning)',
  failed: 'var(--destructive)',
  discarded: 'var(--muted-foreground)',
};

export const taskStatusStyle = (
  status: TaskStatus,
): CSSProperties & { '--task-status-color': string } => ({
  '--task-status-color': taskStatusColors[status],
});

export const lifecycleActionStatus = (action: TaskAction): TaskStatus => taskTransitions[action].to;
