import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agentRuntimeSchema, securityControlSchema } from '@ai-agent-manager/core';
import { smokeCheckIdSchema, type SmokeCheckId } from './checks.js';

// SEC-02e smoke report. Holds facts and codes only: no prompt text, assistant output, tool input,
// stderr text, environment values or Git config values.

export const smokeClassifications = [
  'pass',
  'compat_failure',
  'integrity_violation',
  'inconclusive',
  'refused_before_launch',
  'aborted',
] as const;

export type SmokeClassification = (typeof smokeClassifications)[number];

export const smokeVerificationTypes = ['operator_supervised_real_cli', 'offline_fake_cli'] as const;
export type SmokeVerificationType = (typeof smokeVerificationTypes)[number];

/** Disclosure version of the smoke runner's in-memory acceptance. Never a production version. */
export const smokeDisclosureVersion = 'sec-02e-smoke.2';

export const smokeLimitations = [
  'Trusted Local runs use the operator account: no filesystem, credential or network isolation is claimed or tested.',
  'Process containment is process_group_only: stop, timeout and cleanup act on the CLI process group; descendants in another session or process group are not covered (SEC-01).',
  'The Git integrity check is run by the smoke runner for diagnostics only. It is not the production post_run_git_integrity_check safeguard, which the authorization never lists.',
  'A clean integrity result means no observable before/after change in the fixture repository, not proof that none occurred; pushes to URLs, other repositories and files outside the fixture are not observed.',
  'The evidence is bound to this CLI version, these launch arguments and this host. It never changes a security profile.',
  'The CLI may keep its own local records: Claude Code can persist session transcripts under ~/.claude/projects/, which may include prompts, replies, tool inputs and repository content.',
  'A successful process exit is not proof that the coding task was done; the worktree changes are the evidence.',
] as const;

/** Distinct tool names kept in a report; further names are counted under `other`. */
export const maxReportedTools = 50;

/**
 * Tools that write files, by the names the adapters report: Claude Code's file tools and Codex's
 * `file_change` item (which Codex reports only once completed).
 */
export const fileWriteToolNames: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'file_change',
]);

const integrityStatusSchema = z.enum(['clean', 'violation', 'inconclusive', 'not_run']);

export const smokeReportSchema = z
  .object({
    kind: z.literal('aam_trusted_local_smoke_run'),
    schemaVersion: z.literal(1),
    runId: z.string(),
    fixtureId: z.string(),
    runtime: agentRuntimeSchema,
    checkId: smokeCheckIdSchema,
    covers: z.array(z.string()),
    verification: z.enum(smokeVerificationTypes),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    cli: z
      .object({
        executablePath: z.string().nullable(),
        version: z.string().nullable(),
        versionAfter: z.string().nullable(),
        executableChanged: z.boolean().nullable(),
        launchProfileId: z.string().nullable(),
        arguments: z.array(z.string()),
        environmentNames: z.array(z.string()),
        modelId: z.string().nullable(),
      })
      .strict(),
    /** SHA-256 of the fixed prompt actually sent; the text is never stored. */
    promptDigest: z.string().nullable(),
    limits: z
      .object({ timeoutMs: z.number(), maxStdoutBytes: z.number(), stopGraceMs: z.number() })
      .strict(),
    approval: z
      .object({
        decision: z.enum(['approved', 'declined', 'not_requested']),
        method: z.enum(['terminal', 'offline_test_dependency', 'none']),
        decidedAt: z.iso.datetime().nullable(),
      })
      .strict(),
    authorization: z
      .object({
        requested: z.boolean(),
        authorized: z.boolean(),
        authorizationId: z.string().nullable(),
        denialCodes: z.array(z.string()),
        securityMode: z.literal('trusted_local'),
        disclosureVersion: z.literal(smokeDisclosureVersion),
        acceptedRisks: z.array(securityControlSchema),
        safeguards: z.array(z.string()),
        controlAssessments: z.array(z.object({ control: z.string(), status: z.string() }).strict()),
      })
      .strict(),
    launch: z
      .object({
        processStarted: z.boolean(),
        rejectionCode: z.string().nullable(),
      })
      .strict(),
    execution: z
      .object({
        status: z.enum(['completed', 'failed', 'stopped']),
        failureCode: z.string().nullable(),
        exitCode: z.number().nullable(),
        signal: z.string().nullable(),
        durationMs: z.number(),
        securityMode: z.string(),
        processContainment: z.literal('process_group_only'),
        lingeringProcesses: z.enum(['none', 'terminated', 'unknown']),
        stopRequestedBy: z.enum(['check', 'operator']).nullable(),
        eventCounts: z.record(z.string(), z.number()),
        /** Per-tool phase counts from parsed tool events: names only, never inputs or output. */
        toolActivity: z
          .array(
            z
              .object({
                toolName: z.string().max(64),
                started: z.number(),
                completed: z.number(),
                failed: z.number(),
              })
              .strict(),
          )
          .max(maxReportedTools + 1),
        diagnosticCodes: z.array(z.string()),
        sessionIdReported: z.boolean(),
        reportedModelId: z.string().nullable(),
        tokenObserved: z.boolean().nullable(),
        stdoutBytes: z.number(),
        stderrBytes: z.number(),
      })
      .strict()
      .nullable(),
    integrity: z
      .object({
        baseline: z.enum(['observed', 'incomplete', 'error', 'not_captured']),
        baselineFailedSections: z.array(z.string()),
        status: integrityStatusSchema,
        publication: z.literal('blocked_smoke_fixture'),
        findings: z.array(
          z
            .object({
              code: z.string(),
              disposition: z.string(),
              section: z.string(),
              subject: z.string(),
              change: z.string().nullable(),
            })
            .strict(),
        ),
        totalFindings: z.number(),
        beforeDigest: z.string().nullable(),
        afterDigest: z.string().nullable(),
        error: z.string().nullable(),
        coverage: z.literal('observable_before_after_state'),
        appliedAs: z.literal('diagnostic_only'),
      })
      .strict(),
    worktreeChanges: z
      .object({
        files: z.array(
          z
            .object({
              path: z.string(),
              change: z.string(),
              tracked: z.boolean(),
              committed: z.boolean(),
            })
            .strict(),
        ),
        totalFiles: z.number(),
        expectedEditMatched: z.boolean().nullable(),
      })
      .strict()
      .nullable(),
    classification: z.enum(smokeClassifications),
    reasons: z.array(z.string()),
    limitations: z.array(z.string()),
    productionCapabilityClaims: z.literal('none'),
  })
  .strict();

export type SmokeReport = z.infer<typeof smokeReportSchema>;
export type SmokeExecution = NonNullable<SmokeReport['execution']>;
export type SmokeIntegrity = SmokeReport['integrity'];

/** Facts the classification is derived from. */
export type ClassificationInput = {
  checkId: SmokeCheckId;
  execution: SmokeExecution;
  integrityStatus: SmokeIntegrity['status'];
  versionChanged: boolean;
  worktreeChanges: SmokeReport['worktreeChanges'];
  requestedModelId: string | null;
  /** The operator stopped the run (Ctrl+C or a termination signal to the runner). */
  operatorInterrupted: boolean;
};

type Verdict = { classification: SmokeClassification; reasons: string[] };

/** Whether the CLI result matches the check's expectation (integrity and version aside). */
const evaluateCheck = (input: ClassificationInput): Verdict => {
  const { execution, worktreeChanges } = input;
  const pass = (reason: string): Verdict => ({ classification: 'pass', reasons: [reason] });
  const compat = (reason: string): Verdict => ({
    classification: 'compat_failure',
    reasons: [reason],
  });
  const inconclusive = (reason: string): Verdict => ({
    classification: 'inconclusive',
    reasons: [reason],
  });
  const outcome =
    execution.status === 'failed'
      ? `failed/${execution.failureCode ?? 'unknown'}`
      : execution.status;
  const malformed = execution.diagnosticCodes.includes('malformed_output');
  const noChanges = worktreeChanges !== null && worktreeChanges.totalFiles === 0;
  if (execution.failureCode === 'event_handler_failed') {
    return inconclusive('The smoke runner failed to handle an event; this is not a CLI result.');
  }
  if (execution.failureCode === 'provider_error' && input.checkId !== 'explicit-model-error') {
    return inconclusive(
      'The CLI reported a provider error (for example authentication, rate limit or outage).',
    );
  }
  switch (input.checkId) {
    case 'stdin-token':
      if (execution.status !== 'completed') return compat(`Expected completed, got ${outcome}.`);
      if (malformed) return compat('The output contained malformed lines.');
      if (execution.tokenObserved !== true) return compat('The reply token was not observed.');
      if (!noChanges) return compat('The worktree changed although no edit was requested.');
      return pass('Completed via stdin with the expected token and structured events.');
    case 'explicit-model-error': {
      const otherModel =
        execution.reportedModelId !== null && execution.reportedModelId !== input.requestedModelId;
      if (otherModel) return compat('An event reported a different model (fallback).');
      if (execution.failureCode === 'model_unavailable') {
        return pass('The unknown model failed as model_unavailable without fallback.');
      }
      if (execution.failureCode === 'provider_error') {
        return compat('Classified as provider_error: the model-unavailable heuristic missed.');
      }
      return compat(`Expected failed/model_unavailable, got ${outcome}.`);
    }
    case 'coding-edit': {
      if (execution.status !== 'completed') return compat(`Expected completed, got ${outcome}.`);
      if (malformed) return compat('The output contained malformed lines.');
      if (worktreeChanges?.expectedEditMatched !== true) {
        const writes = execution.toolActivity.filter((tool) =>
          fileWriteToolNames.has(tool.toolName),
        );
        const failed = writes.filter((tool) => tool.failed > 0);
        if (failed.length > 0) {
          // The parsed events say only that the tool result was an error. The cause (for example
          // a permission denial) is not part of the structured evidence, so it is not claimed.
          return compat(
            `The file-writing tool ${failed.map((tool) => `${tool.toolName} (${tool.failed} failed)`).join(', ')} reported a failure and the requested edit was not made. The structured events do not record the cause; a permission denial is possible but not confirmed by this report.`,
          );
        }
        if (writes.length === 0 && (noChanges || worktreeChanges === null)) {
          return compat(
            'No file-writing tool was observed and the worktree is unchanged: the CLI completed without attempting the edit.',
          );
        }
        return compat('The worktree changes are not exactly the requested edit.');
      }
      return pass('The requested edit was made and nothing else changed in the worktree.');
    }
    case 'stop':
      if (execution.status === 'stopped') return pass('The stop request was reported as stopped.');
      if (execution.status === 'completed')
        return inconclusive('The run completed before the stop.');
      return compat(`Expected stopped, got ${outcome}.`);
    case 'timeout':
      if (execution.failureCode === 'timeout')
        return pass('The run was terminated by the timeout.');
      if (execution.status === 'completed') {
        return inconclusive('The run completed before the timeout.');
      }
      return compat(`Expected failed/timeout, got ${outcome}.`);
    case 'output-limit':
      if (execution.failureCode === 'output_limit_exceeded') {
        return pass('The run was terminated by the output limit.');
      }
      if (execution.status === 'completed') {
        return inconclusive('The run completed below the output limit.');
      }
      return compat(`Expected failed/output_limit_exceeded, got ${outcome}.`);
    case 'auth-error':
      return inconclusive('This check is blocked and never runs.');
  }
};

/**
 * Classifies a run that started a process. Integrity is evaluated independently from the CLI
 * result and takes precedence: a violation is never hidden behind a CLI result, and an incomplete
 * or failed inspection never yields `pass`.
 */
export const classifyLaunchedRun = (input: ClassificationInput): Verdict => {
  const check = evaluateCheck(input);
  if (input.integrityStatus === 'violation') {
    return {
      classification: 'integrity_violation',
      reasons: ['The Git integrity check found an unexpected Git mutation.', ...check.reasons],
    };
  }
  if (input.integrityStatus !== 'clean') {
    return {
      classification: 'inconclusive',
      reasons: ['The Git integrity check was incomplete or failed.', ...check.reasons],
    };
  }
  if (input.operatorInterrupted) {
    return {
      classification: 'inconclusive',
      reasons: [
        'Interrupted by the operator; the check expectation was not evaluated.',
        ...check.reasons,
      ],
    };
  }
  if (input.versionChanged) {
    return {
      classification: 'inconclusive',
      reasons: ['The CLI version or executable changed during the run.', ...check.reasons],
    };
  }
  return check;
};

/** Writes the report into the fixture's results directory, never overwriting a file. */
export const writeSmokeReport = async (
  resultsDirectory: string,
  report: SmokeReport,
): Promise<string> => {
  const validated = smokeReportSchema.parse(report);
  const path = join(resultsDirectory, `smoke-report-${validated.runId}.json`);
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return path;
};
