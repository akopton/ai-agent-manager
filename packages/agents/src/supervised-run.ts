import type { ExecutionSecurityMode } from '@ai-agent-manager/core';
import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  AgentLifecycleEvent,
  AgentOutputEvent,
  AgentRunResult,
} from './contract.js';
import { shortText } from './output-parsing.js';
import { startSupervisedProcess } from './process-supervisor.js';
import { classifyRunOutcome } from './run-outcome.js';

/** Limits a supervised run applies; see `ExecutionLimits`. */
export type SupervisedRunLimits = {
  stopGraceMs: number;
  maxStdoutBytes: number;
  maxLineBytes: number;
  maxStderrEventBytes: number;
};

/**
 * One already-authorized and fully checked invocation. Only the two launch boundaries
 * (`startAgentExecution` and `startConversationTurn`) build this, after every binding check.
 *
 * @internal Not exported from any package entry point.
 */
export type SupervisedRunInput = {
  adapter: AgentAdapter;
  runId: string;
  executablePath: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Never emitted. */
  stdin: string;
  explicitModel: boolean;
  timeoutMs: number | undefined;
  limits: SupervisedRunLimits;
  securityMode: ExecutionSecurityMode;
  clock: () => Date;
  emit: (event: AgentEvent) => void;
};

type RunState = {
  sequence: number;
  sessionId?: string;
  reportedModelId?: string;
  stderrEventBytes: number;
  stderrTruncationReported: boolean;
  lastStderrLine: string | null;
};

/**
 * Spawns, supervises and classifies one CLI run: process group, timeout, output limits, parsed
 * provider events, bounded stderr, lingering-process cleanup and exactly one terminal event.
 * Shared by Execution Mode and Conversation Mode so both report outcomes identically.
 *
 * @internal
 */
export const startSupervisedRun = (input: SupervisedRunInput): AgentHandle => {
  const { adapter, limits, clock, timeoutMs, securityMode } = input;
  const parser = adapter.createOutputParser({ explicitModel: input.explicitModel });
  const startedAt = clock().toISOString();
  const state: RunState = {
    sequence: 0,
    stderrEventBytes: 0,
    stderrTruncationReported: false,
    lastStderrLine: null,
  };

  const deliver = (event: AgentOutputEvent | AgentLifecycleEvent): void => {
    state.sequence += 1;
    input.emit({
      runId: input.runId,
      runtime: adapter.runtime,
      sequence: state.sequence,
      timestamp: clock().toISOString(),
      ...event,
    });
  };
  const deliverOutput = (event: AgentOutputEvent): void => {
    if (event.type === 'metadata') {
      if (event.sessionId !== undefined) state.sessionId = event.sessionId;
      if (event.reportedModelId !== undefined) state.reportedModelId = event.reportedModelId;
    }
    deliver(event);
  };

  const supervised = startSupervisedProcess(
    {
      executablePath: input.executablePath,
      args: input.args,
      cwd: input.cwd,
      env: input.environment,
      stdin: input.stdin,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      stopGraceMs: limits.stopGraceMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxLineBytes: limits.maxLineBytes,
    },
    {
      onStarted: (pid, processGroupId) =>
        deliver({
          type: 'started',
          pid,
          processGroupId,
          securityMode,
          processContainment: 'process_group_only',
        }),
      onStdoutLine: (line) => {
        if (line.truncated) {
          deliver({
            type: 'diagnostic',
            code: 'line_truncated',
            message: `A stdout line exceeded ${limits.maxLineBytes} bytes and was discarded.`,
          });
          return;
        }
        for (const event of parser.parseLine(line.text)) deliverOutput(event);
      },
      onStderrLine: (line) => {
        if (line.text.trim() !== '') {
          state.lastStderrLine = shortText(line.text, 500);
        }
        const bytes = Buffer.byteLength(line.text);
        if (state.stderrEventBytes + bytes > limits.maxStderrEventBytes) {
          if (!state.stderrTruncationReported) {
            state.stderrTruncationReported = true;
            deliver({
              type: 'diagnostic',
              code: 'stderr_truncated',
              message: `Stderr exceeded ${limits.maxStderrEventBytes} bytes; further stderr is not delivered.`,
            });
          }
          return;
        }
        state.stderrEventBytes += bytes;
        deliver({ type: 'stderr', text: line.text, truncated: line.truncated });
      },
      onTerminating: (reason) => deliver({ type: 'stopping', reason }),
    },
  );

  const completed = supervised.exited.then((exit): AgentRunResult => {
    const outcome = classifyRunOutcome(exit, parser, state.lastStderrLine, {
      timeoutMs,
      explicitModel: input.explicitModel,
    });
    const result: AgentRunResult = Object.freeze({
      ...outcome,
      runId: input.runId,
      runtime: adapter.runtime,
      securityMode,
      pid: exit.pid,
      startedAt,
      endedAt: clock().toISOString(),
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
      ...(state.reportedModelId === undefined ? {} : { reportedModelId: state.reportedModelId }),
      stdoutBytes: exit.stdoutBytes,
      stderrBytes: exit.stderrBytes,
      lingeringProcesses: exit.lingeringProcesses,
      processContainment: 'process_group_only',
    });
    try {
      if (exit.lingeringProcesses !== 'none') {
        deliver({
          type: 'diagnostic',
          code: 'lingering_processes',
          message:
            exit.lingeringProcesses === 'terminated'
              ? 'Processes left in the process group after the CLI exited were terminated.'
              : 'Processes in the process group could not be confirmed terminated.',
        });
      }
      deliver({ type: outcome.status, result });
    } catch {
      // The run is over; the result is still available through `completed`.
    }
    return result;
  });

  return {
    runId: input.runId,
    pid: supervised.pid,
    stop: () => {
      supervised.terminate('requested');
      return completed;
    },
    completed,
  };
};
