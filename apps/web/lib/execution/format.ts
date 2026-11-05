import type { TaskExecutionView, TaskRunView } from '@/lib/execution/contracts';

// Truthful, compact descriptions of a run for the task page. A completed process is never
// described as a completed task: only the change review shows what changed.

export const describeRunOutcome = (run: TaskRunView): string => {
  if (run.active) {
    return run.stopRequestedAt !== null ? 'Stop requested' : 'In progress';
  }
  const exit =
    run.exitCode !== null
      ? `exit ${run.exitCode}`
      : run.signal !== null
        ? `signal ${run.signal}`
        : null;
  switch (run.status) {
    case 'completed':
      return run.errorCode === null
        ? `Agent process completed${exit === null ? '' : ` (${exit})`}`
        : `Agent process completed, but blocked: ${run.errorCode}`;
    case 'stopped':
      return 'Stopped by the operator (process group terminated)';
    case 'interrupted':
      return run.errorMessage ?? 'Interrupted';
    case 'failed':
      return [run.errorCode ?? 'failed', exit, run.errorMessage].filter(Boolean).join(' — ');
    default:
      return run.status;
  }
};

export const describeIntegrity = (run: TaskRunView): string => {
  switch (run.gitIntegrity.status) {
    case 'clean':
      return 'Clean: no observable Git mutation (not proof that none occurred)';
    case 'violation':
      return `Violation (${run.gitIntegrity.totalFindings} findings)`;
    case 'inconclusive':
      return 'Inconclusive: the Git state could not be confirmed';
    case 'not_run':
      return run.active ? 'Pending' : 'Not run (no baseline was captured)';
  }
};

/** Refresh the page while the worker still has something to do for this task. */
export const shouldPollExecution = (execution: TaskExecutionView): boolean =>
  execution.lastCommand?.status === 'pending' || execution.runs.some((run) => run.active);
