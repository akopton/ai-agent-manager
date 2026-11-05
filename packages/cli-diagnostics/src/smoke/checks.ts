import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { agentRuntimes, type AgentRuntime } from '@ai-agent-manager/core';

// SEC-02e fixed compatibility check catalog (`docs/trusted-local-smoke-runs.md` §4). Prompts,
// models and limits are code-defined; the operator selects a check only by its ID.

export const smokeRuntimeSchema = z.enum(agentRuntimes);

export const smokeCheckIds = [
  'stdin-token',
  'explicit-model-error',
  'coding-edit',
  'stop',
  'timeout',
  'output-limit',
  'auth-error',
] as const;

export const smokeCheckIdSchema = z.enum(smokeCheckIds);
export type SmokeCheckId = z.infer<typeof smokeCheckIdSchema>;

/** Limits a check may set. Each must be at most the production default (tightening only). */
export type SmokeLimits = { maxStdoutBytes?: number };

/** The file and exact content the `coding-edit` check asks for, relative to the task worktree. */
export const codingEditTarget = Object.freeze({
  path: 'src/greeting.ts',
  content: "export const greeting = 'hello';",
});

const countingPrompt = (upTo: number): string =>
  `Count from 1 to ${upTo}, one number per line. Do not use any tools.`;

export type PreparedCheck = {
  prompt: string;
  /** For `stdin-token`: the token the assistant must reply with. Never written to a report. */
  expectedToken: string | null;
};

export type SmokeCheck = {
  id: SmokeCheckId;
  /** Runbook compatibility IDs this check covers. */
  covers: readonly string[];
  objective: string;
  /**
   * `blocked`: cannot run safely or deterministically on the host with today's harness; the
   * runner refuses it before detection.
   */
  support: { status: 'supported' } | { status: 'blocked'; reason: string };
  modelId: string | null;
  timeoutMs: number;
  limits: SmokeLimits;
  /** Stop through `AgentHandle.stop()` at the first structured output event. */
  stopAtFirstOutput: boolean;
  /** Builds the fixed prompt; a per-run nonce is the only variable part. */
  prepare: () => PreparedCheck;
};

const fixed = (prompt: string) => (): PreparedCheck => ({ prompt, expectedToken: null });

const tokenPrompt = (): PreparedCheck => {
  const token = `AAM-COMPAT-OK-${randomBytes(4).toString('hex')}`;
  return { prompt: `Reply with exactly ${token} and nothing else.`, expectedToken: token };
};

export const smokeChecks: Readonly<Record<SmokeCheckId, SmokeCheck>> = Object.freeze({
  'stdin-token': {
    id: 'stdin-token',
    covers: ['C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06', 'C-07', 'C-10', 'C-13'],
    objective:
      'Prompt via stdin, structured events, successful completion with the Default model, session metadata.',
    support: { status: 'supported' },
    modelId: null,
    timeoutMs: 180_000,
    limits: {},
    stopAtFirstOutput: false,
    prepare: tokenPrompt,
  },
  'explicit-model-error': {
    id: 'explicit-model-error',
    covers: ['C-01', 'C-02', 'C-09', 'C-13'],
    objective: 'An unknown explicit model fails as model_unavailable, without fallback.',
    support: { status: 'supported' },
    modelId: 'aam-nonexistent-model-000',
    timeoutMs: 180_000,
    limits: {},
    stopAtFirstOutput: false,
    prepare: tokenPrompt,
  },
  'coding-edit': {
    id: 'coding-edit',
    covers: ['C-01', 'C-02', 'C-13', 'C-14'],
    objective:
      'A simple edit inside the task worktree; the Git integrity check stays clean for normal edits.',
    support: { status: 'supported' },
    modelId: null,
    timeoutMs: 300_000,
    limits: {},
    stopAtFirstOutput: false,
    prepare: fixed(
      `Create the file ${codingEditTarget.path} containing exactly: ${codingEditTarget.content}  Change no other file. Do not run Git commands.`,
    ),
  },
  stop: {
    id: 'stop',
    covers: ['C-01', 'C-02', 'C-11'],
    objective:
      'A stop request through AgentHandle.stop() is reported as stopped (process group only, SEC-01).',
    support: { status: 'supported' },
    modelId: null,
    timeoutMs: 180_000,
    limits: {},
    stopAtFirstOutput: true,
    prepare: fixed(countingPrompt(400)),
  },
  timeout: {
    id: 'timeout',
    covers: ['C-01', 'C-02', 'C-15'],
    objective: 'A run exceeding the Trusted Local policy timeout is reported as timeout.',
    support: { status: 'supported' },
    modelId: null,
    timeoutMs: 15_000,
    limits: {},
    stopAtFirstOutput: false,
    prepare: fixed(countingPrompt(2000)),
  },
  'output-limit': {
    id: 'output-limit',
    covers: ['C-01', 'C-02', 'C-16'],
    objective: 'Output beyond a tightened stdout limit is reported as output_limit_exceeded.',
    support: { status: 'supported' },
    modelId: null,
    timeoutMs: 180_000,
    limits: { maxStdoutBytes: 4096 },
    stopAtFirstOutput: false,
    prepare: fixed(countingPrompt(2000)),
  },
  'auth-error': {
    id: 'auth-error',
    covers: ['C-08'],
    objective: 'An unauthenticated CLI fails without hanging or prompting.',
    support: {
      status: 'blocked',
      reason:
        "Needs an unauthenticated CLI. Logging out the operator's own sessions on the host is out of scope; this check stays with the VM plan.",
    },
    modelId: null,
    timeoutMs: 60_000,
    limits: {},
    stopAtFirstOutput: false,
    prepare: tokenPrompt,
  },
});

export const smokeRuntimes: readonly AgentRuntime[] = agentRuntimes;
