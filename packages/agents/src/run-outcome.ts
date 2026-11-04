import type { AgentOutputParser, AgentRunOutcome } from './contract.js';
import { isModelUnavailableMessage, shortText } from './output-parsing.js';
import type { ProcessExit } from './process-supervisor.js';

export type RunOutcomeContext = {
  /** The run's wall-clock limit, reported in timeout messages. */
  timeoutMs: number | undefined;
  /** Whether an explicit model was requested (enables `model_unavailable`). */
  explicitModel: boolean;
};

/**
 * Classifies a supervised CLI process exit together with what the parser saw. Pure; shared by
 * `startAgentExecution` and the diagnostics harness so both report terminal states identically.
 */
export const classifyRunOutcome = (
  exit: ProcessExit,
  parser: Pick<AgentOutputParser, 'outcome' | 'lastNotice'>,
  lastStderrLine: string | null,
  context: RunOutcomeContext,
): AgentRunOutcome => {
  const { exitCode, signal } = exit;
  const failed = (
    code: Extract<AgentRunOutcome, { status: 'failed' }>['code'],
    message: string,
  ) => ({
    status: 'failed' as const,
    code,
    message,
    exitCode,
    signal,
  });
  if (exit.spawnError !== null) {
    return failed('spawn_failed', `The CLI could not be started: ${exit.spawnError.message}`);
  }
  switch (exit.termination) {
    case 'requested':
      return { status: 'stopped', exitCode, signal };
    case 'timeout':
      return failed('timeout', `The run exceeded ${context.timeoutMs ?? 0} ms and was terminated.`);
    case 'output_limit':
      return failed(
        'output_limit_exceeded',
        'The CLI output exceeded the limit; the run was terminated.',
      );
    case 'event_handler_failed':
      return failed(
        'event_handler_failed',
        'An event could not be delivered; the run was terminated.',
      );
    case null:
      break;
  }
  if (signal !== null) {
    return failed(
      'terminated_by_signal',
      `The CLI was terminated by ${signal}, which AI Agent Manager did not send.`,
    );
  }
  const outcome = parser.outcome();
  const { explicitModel } = context;
  if (outcome.status === 'failed') {
    return failed(
      explicitModel && isModelUnavailableMessage(outcome.message)
        ? 'model_unavailable'
        : 'provider_error',
      outcome.message,
    );
  }
  if (exitCode !== 0) {
    const notice = parser.lastNotice() ?? lastStderrLine;
    const detail = notice === null ? '' : `: ${notice}`;
    // 128 + n is how a CLI that handled signal n reports it, for example 143 after SIGTERM.
    const signalNote =
      exitCode !== null && exitCode > 128 && exitCode < 160 ? ' (likely signal-initiated)' : '';
    return failed(
      explicitModel && notice !== null && isModelUnavailableMessage(notice)
        ? 'model_unavailable'
        : 'non_zero_exit',
      shortText(`The CLI exited with code ${exitCode ?? 'unknown'}${signalNote}${detail}`, 2_048),
    );
  }
  if (outcome.status !== 'succeeded') {
    return failed('incomplete_output', 'The CLI exited with code 0 without reporting a result.');
  }
  return {
    status: 'completed',
    exitCode: 0,
    signal: null,
    ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
  };
};
