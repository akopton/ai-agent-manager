import { createInterface } from 'node:readline/promises';
import type { AgentRuntime, SecurityControl } from '@ai-agent-manager/core';
import type { SmokeCheckId } from './checks.js';

/** Everything the operator sees before approving one run. Contains no environment values. */
export type ApprovalSummary = {
  fixtureId: string;
  runId: string;
  runtime: AgentRuntime;
  cliVersion: string;
  executablePath: string;
  checkId: SmokeCheckId;
  objective: string;
  /** The exact fixed prompt sent on stdin. */
  prompt: string;
  /** The complete argument vector, executable first. */
  invocation: readonly string[];
  /** Names only: values are never shown or recorded. */
  environmentNames: readonly string[];
  workingDirectory: string;
  modelId: string | null;
  timeoutMs: number;
  maxStdoutBytes: number;
  disclosureVersion: string;
  acceptedRisks: readonly SecurityControl[];
  limitations: readonly string[];
  /** What the operator must type to approve this one run. */
  confirmationToken: string;
};

export type ApprovalDecision = {
  approved: boolean;
  method: 'terminal' | 'offline_test_dependency';
  decidedAt: string;
  /** Why no approval was given, when `approved` is false. */
  reason?: 'declined' | 'not_interactive' | 'interrupted';
};

/** Asks for approval of exactly one run. A decision never carries over to another run. */
export type ConfirmRun = (summary: ApprovalSummary) => Promise<ApprovalDecision>;

/** Binds the confirmation to the fixture, runtime, check and run. */
export const confirmationToken = (
  fixtureId: string,
  runtime: AgentRuntime,
  checkId: SmokeCheckId,
  runId: string,
): string => `${fixtureId.slice(0, 8)}/${runtime}/${checkId}/${runId.slice(-6)}`;

const quote = (value: string): string =>
  /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export const renderApprovalSummary = (summary: ApprovalSummary): string =>
  [
    '',
    '=== AI Agent Manager SEC-02e Trusted Local smoke run: approval required ===',
    '',
    `Runtime:            ${summary.runtime} ${summary.cliVersion}`,
    `Executable:         ${summary.executablePath}`,
    `Check:              ${summary.checkId}: ${summary.objective}`,
    `Run ID:             ${summary.runId}`,
    `Fixture:            ${summary.fixtureId}`,
    `Working directory:  ${summary.workingDirectory} (disposable task worktree, verified)`,
    `Model:              ${summary.modelId ?? 'Default (no --model)'}`,
    `Timeout:            ${summary.timeoutMs} ms`,
    `Stdout limit:       ${summary.maxStdoutBytes} bytes`,
    `Environment names:  ${summary.environmentNames.join(' ')} (values not shown)`,
    '',
    'Invocation (prompt on stdin, not an argument):',
    `  ${summary.invocation.map(quote).join(' ')}`,
    '',
    'Prompt (exact text sent on stdin):',
    `  ${summary.prompt}`,
    '',
    `Trusted Local disclosure ${summary.disclosureVersion}. By approving you accept, for this run only:`,
    ...summary.acceptedRisks.map((risk) => `  - ${risk} is NOT enforced`),
    'The agent runs as your macOS user and may use your files, credentials and network,',
    'and could commit or push. A benign prompt is not a security boundary.',
    ...summary.limitations.map((line) => `  * ${line}`),
    '',
  ].join('\n');

/**
 * Production approval: refuses unless both streams are terminals, prints the summary, and
 * approves only if the operator types the run's exact confirmation token. One prompt per run.
 */
export const createTerminalApproval =
  (
    input: NodeJS.ReadableStream & { isTTY?: boolean },
    output: NodeJS.WritableStream & { isTTY?: boolean },
  ): ConfirmRun =>
  async (summary) => {
    if (input.isTTY !== true || output.isTTY !== true) {
      return {
        approved: false,
        method: 'terminal',
        decidedAt: new Date().toISOString(),
        reason: 'not_interactive',
      };
    }
    output.write(`${renderApprovalSummary(summary)}\n`);
    const prompt = createInterface({ input, output, terminal: true });
    // In terminal mode Ctrl+C reaches readline as a keypress, not as a process signal. Without a
    // listener readline would only pause, so Ctrl+C and end of input both cancel the approval.
    const cancel = new AbortController();
    prompt.on('SIGINT', () => cancel.abort());
    prompt.on('close', () => cancel.abort());
    try {
      const answer = await prompt
        .question(
          `Type ${summary.confirmationToken} to start this one run (anything else cancels): `,
          {
            signal: cancel.signal,
          },
        )
        .catch(() => null);
      if (answer === null) {
        output.write('\nApproval cancelled. Nothing was run.\n');
        return {
          approved: false,
          method: 'terminal',
          decidedAt: new Date().toISOString(),
          reason: 'interrupted',
        };
      }
      const approved = answer.trim() === summary.confirmationToken;
      return {
        approved,
        method: 'terminal',
        decidedAt: new Date().toISOString(),
        ...(approved ? {} : { reason: 'declined' as const }),
      };
    } finally {
      prompt.close();
    }
  };
