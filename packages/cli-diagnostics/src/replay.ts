import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  defaultExecutionLimits,
  type AgentAdapter,
  type AgentFailureCode,
  type AgentOutputEvent,
} from '@ai-agent-manager/agents';
import { classifyRunOutcome, createLineSplitter } from '@ai-agent-manager/agents/diagnostics';
import type { AgentRuntime } from '@ai-agent-manager/core';

/**
 * How the captured process ended, as recorded by the operator. Replay cannot observe a process;
 * these facts come from the capture, not from execution.
 */
export type ReplayTermination =
  | { kind: 'exited'; exitCode: number }
  | { kind: 'signaled'; signal: NodeJS.Signals }
  /** The operator stopped the run (production: `stop()`), whatever the exit status. */
  | { kind: 'stop_requested'; exitCode: number | null; signal: NodeJS.Signals | null };

export type ReplayOptions = {
  adapter: AgentAdapter;
  /** Absolute path to a captured stdout file (JSON lines). */
  eventsFile: string;
  termination: ReplayTermination;
  /** Whether the capture used an explicit `--model` (enables `model_unavailable`). */
  explicitModel?: boolean;
  /** Production defaults: 32 MiB total stdout, 1 MiB per line. */
  maxStdoutBytes?: number;
  maxLineBytes?: number;
};

/** One normalized event, reduced to fields that never contain message text or tool input. */
export type ReplayedEvent = {
  sequence: number;
  type: AgentOutputEvent['type'];
  phase?: 'started' | 'completed' | 'failed';
  toolName?: string;
  code?: string;
  truncated?: boolean;
};

export type ReplayResult = {
  kind: 'offline_replay';
  /** Always `parser_only`: no process was started; signals, timing and descendants are not tested. */
  verification: 'parser_only';
  runtime: AgentRuntime;
  input: { bytesRead: number; lines: number; outputLimitReached: boolean };
  eventCounts: Record<string, number>;
  /** Normalized events in delivery order (bounded; see `eventsOmitted`). */
  events: ReplayedEvent[];
  eventsOmitted: number;
  diagnosticCodes: string[];
  sessionIdReported: boolean;
  reportedModelId: string | null;
  /** Terminal classification by the production `classifyRunOutcome`. Messages are omitted. */
  outcome: { status: 'completed' | 'failed' | 'stopped'; code: AgentFailureCode | null };
  limitations: string[];
};

export class ReplayInputError extends Error {
  override name = 'ReplayInputError';
}

const maxReportedEvents = 5_000;
const chunkBytes = 64 * 1024;

/**
 * Replays captured CLI stdout through the production line splitter, the adapter's production
 * parser and the production outcome classifier, with the same per-line and total-output limits
 * as `startAgentExecution`. It starts no process and needs no authentication or network.
 *
 * Safety: the file is opened with `O_NOFOLLOW` and must be a regular file; reading stops at the
 * output limit, so memory stays bounded. The result contains counts, event types, tool names and
 * codes only, never message text, tool input, stderr or the prompt.
 */
export const replayCapturedOutput = async (options: ReplayOptions): Promise<ReplayResult> => {
  const { adapter, eventsFile, termination } = options;
  const maxStdoutBytes = options.maxStdoutBytes ?? defaultExecutionLimits.maxStdoutBytes;
  const maxLineBytes = options.maxLineBytes ?? defaultExecutionLimits.maxLineBytes;
  if (!isAbsolute(eventsFile) || eventsFile.includes('\0')) {
    throw new ReplayInputError('The events file must be an absolute path.');
  }
  if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes <= 0) {
    throw new ReplayInputError('The output limit must be a positive integer.');
  }
  const handle = await open(eventsFile, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      throw new ReplayInputError(
        error.code === 'ELOOP'
          ? 'The events file must not be a symbolic link.'
          : `The events file cannot be opened (${error.code ?? 'error'}).`,
      );
    },
  );

  const explicitModel = options.explicitModel ?? false;
  const parser = adapter.createOutputParser({ explicitModel });
  const splitter = createLineSplitter(maxLineBytes);
  const eventCounts: Record<string, number> = {};
  const events: ReplayedEvent[] = [];
  const diagnosticCodes = new Set<string>();
  let eventsOmitted = 0;
  let sequence = 0;
  let lines = 0;
  let bytesRead = 0;
  let outputLimitReached = false;
  let sessionIdReported = false;
  let reportedModelId: string | null = null;

  const record = (event: AgentOutputEvent): void => {
    sequence += 1;
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    const reduced: ReplayedEvent = { sequence, type: event.type };
    if (event.type === 'tool_activity') {
      reduced.phase = event.phase;
      reduced.toolName = event.toolName;
    } else if (event.type === 'diagnostic') {
      reduced.code = event.code;
      diagnosticCodes.add(event.code);
    } else if (event.type === 'message' || event.type === 'stderr') {
      reduced.truncated = event.truncated;
    } else if (event.type === 'metadata') {
      if (event.sessionId !== undefined) sessionIdReported = true;
      if (event.reportedModelId !== undefined) reportedModelId = event.reportedModelId;
    }
    if (events.length < maxReportedEvents) events.push(reduced);
    else eventsOmitted += 1;
  };
  // Same handling as the production `onStdoutLine` hook in `startAgentExecution`.
  const deliverLine = (line: { text: string; truncated: boolean }): void => {
    lines += 1;
    if (line.truncated) {
      record({
        type: 'diagnostic',
        code: 'line_truncated',
        message: `A stdout line exceeded ${maxLineBytes} bytes and was discarded.`,
      });
      return;
    }
    for (const event of parser.parseLine(line.text)) record(event);
  };

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new ReplayInputError('The events file must be a regular file.');
    }
    const buffer = Buffer.alloc(chunkBytes);
    for (;;) {
      const { bytesRead: count } = await handle.read(buffer, 0, chunkBytes, null);
      if (count === 0) break;
      bytesRead += count;
      // The production supervisor stops delivering stdout once the total exceeds the limit and
      // terminates the process; nothing after that point is parsed.
      if (bytesRead > maxStdoutBytes) {
        outputLimitReached = true;
        break;
      }
      for (const line of splitter.push(Buffer.from(buffer.subarray(0, count)))) deliverLine(line);
    }
  } finally {
    await handle.close();
  }
  if (!outputLimitReached) {
    // Like the supervisor at exit: an unterminated last line is still delivered.
    const rest = splitter.flush();
    if (rest !== null) deliverLine(rest);
  }

  const exitCode =
    termination.kind === 'exited'
      ? termination.exitCode
      : termination.kind === 'stop_requested'
        ? termination.exitCode
        : null;
  const signal =
    termination.kind === 'signaled'
      ? termination.signal
      : termination.kind === 'stop_requested'
        ? termination.signal
        : null;
  const outcome = classifyRunOutcome(
    {
      pid: null,
      exitCode,
      signal,
      spawnError: null,
      termination: outputLimitReached
        ? 'output_limit'
        : termination.kind === 'stop_requested'
          ? 'requested'
          : null,
      stdoutBytes: bytesRead,
      stderrBytes: 0,
      lingeringProcesses: 'unknown',
    },
    parser,
    // Stderr is not replayed; it only enriches non-zero-exit messages, which are omitted anyway.
    null,
    { timeoutMs: undefined, explicitModel },
  );

  return {
    kind: 'offline_replay',
    verification: 'parser_only',
    runtime: adapter.runtime,
    input: { bytesRead, lines, outputLimitReached },
    eventCounts,
    events,
    eventsOmitted,
    diagnosticCodes: [...diagnosticCodes].sort(),
    sessionIdReported,
    reportedModelId,
    outcome: {
      status: outcome.status,
      code: outcome.status === 'failed' ? outcome.code : null,
    },
    limitations: [
      'Offline parser verification only: no process was started. Stdin handling, exit codes, signals, timing, stop behavior and descendant processes are not tested by replay.',
      'The termination facts (exit code, signal, stop) are supplied by the operator, not observed.',
    ],
  };
};
