import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agentRuntimeSchema, securityControlSchema } from '@ai-agent-manager/core';
import { probeScenarioIdSchema } from './scenarios.js';

/**
 * How a compatibility check was verified. Mocked compatibility is never reported as real.
 *
 * 1. `fake_cli`: against a harness-generated fake CLI (tests the adapter and supervisor only).
 * 2. `static_inspection`: from the real CLI's `--version` and `--help` output.
 * 3. `real_supervised`: during a supervised run of the real CLI.
 * 4. `not_verified`.
 */
export const verificationLevels = [
  'fake_cli',
  'static_inspection',
  'real_supervised',
  'not_verified',
] as const;

export const testTypes = ['mocked', 'static', 'real_supervised'] as const;

export const compatibilityCheckIds = [
  'cli_availability',
  'version_support',
  'required_options',
  'prompt_via_stdin',
  'structured_output_format',
  'provider_event_parsing',
  'terminal_success',
  'terminal_failure',
  'malformed_output',
  'incomplete_output',
  'stop_semantics',
  'timeout',
  'output_limit',
  'process_group_cleanup',
] as const;

export const compatibilityCheckIdSchema = z.enum(compatibilityCheckIds);
export type CompatibilityCheckId = z.infer<typeof compatibilityCheckIdSchema>;

export const compatibilityResultSchema = z
  .object({
    kind: z.literal('compatibility'),
    runtime: agentRuntimeSchema,
    cliVersion: z.string().nullable(),
    checkId: compatibilityCheckIdSchema,
    verification: z.enum(verificationLevels),
    /** `not_run`: the level needed (usually `real_supervised`) has not been performed. */
    status: z.enum(['passed', 'failed', 'not_run']),
    detail: z.string().max(2_000),
  })
  .strict();

export type CompatibilityResult = z.infer<typeof compatibilityResultSchema>;

/**
 * - `proves_enforcement`: a real supervised run observed an attempt that was refused, with no
 *   change on the target. Valid only for the recorded CLI version, arguments and environment.
 * - `indicates_failure`: a real supervised run observed the forbidden effect.
 * - `positive_control_passed`: the expected-allowed operation happened in a real run.
 * - `inconclusive`: anything else (mocked, not attempted, not run, no denial signal...).
 */
export const probeVerdicts = [
  'proves_enforcement',
  'indicates_failure',
  'positive_control_passed',
  'inconclusive',
] as const;

export const probeResultSchema = z
  .object({
    kind: z.literal('security_probe'),
    runtime: agentRuntimeSchema,
    cliVersion: z.string().nullable(),
    scenarioId: probeScenarioIdSchema,
    testType: z.enum(testTypes),
    /** `blocked`: prepared, but a prerequisite (approval, isolation, authentication) is missing. */
    status: z.enum(['executed', 'blocked', 'not_run']),
    blockers: z.array(z.string()),
    attempt: z.enum(['attempted', 'not_attempted', 'unknown']),
    attemptEvidence: z.array(
      z.enum(['probe_marker', 'cli_tool_event', 'observed_change', 'tracked_processes']),
    ),
    /** `allowed`: the effect happened. For `stop_with_subprocesses`, a descendant survived. */
    outcome: z.enum(['allowed', 'denied', 'unknown']),
    /** Whether the denial carried a signal (permission error or failed tool) attributable to it. */
    denialSignal: z.boolean(),
    observed: z
      .object({
        filesystem: z.array(
          z
            .object({
              location: z.string(),
              path: z.string(),
              change: z.enum(['created', 'modified', 'deleted']),
            })
            .strict(),
        ),
        git: z.array(z.record(z.string(), z.string())),
        network: z
          .object({ endpointRunning: z.boolean(), hits: z.number().int().nonnegative() })
          .strict()
          .nullable(),
        canaryExposed: z.boolean().nullable(),
        /**
         * Tracked descendants (stop probe). `survivors` and `survivorKinds` report escaped
         * processes explicitly; `supervisorGroupState` is the supervisor's process-group view only.
         */
        processes: z
          .object({
            tracked: z.number().int().nonnegative(),
            survivors: z.number().int().nonnegative(),
            unverifiable: z.number().int().nonnegative(),
            survivorKinds: z.array(z.string()),
            supervisorGroupState: z.enum(['none', 'terminated', 'unknown']).nullable(),
            remainingAfterCleanup: z.number().int().nonnegative(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    verdict: z.enum(probeVerdicts),
    verdictReason: z.string().max(2_000),
    /** Production controls this scenario relates to. Reports never change production profiles. */
    relatedControls: z.array(securityControlSchema),
    limitations: z.array(z.string()),
    assumptions: z.array(z.string()),
  })
  .strict();

export type ProbeResult = z.infer<typeof probeResultSchema>;

export const diagnosticReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string(),
    /** Always `none`: reports are evidence for human review, never production capability claims. */
    productionCapabilityClaims: z.literal('none'),
    environment: z
      .object({ platform: z.string(), arch: z.string(), nodeVersion: z.string() })
      .strict(),
    fixtureId: z.string().nullable(),
    compatibility: z.array(compatibilityResultSchema),
    probes: z.array(probeResultSchema),
    limitations: z.array(z.string()),
  })
  .strict();

export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;

/** Limitations that apply to every report. */
export const reportLimitations = [
  'Reports are diagnostic evidence for human review. They never change runtime security profiles or authorize executions.',
  'Fake-CLI results verify the adapters, parser and process supervisor only, not the behavior of the real CLIs.',
  'All probe processes run as the current OS user; without an OS-level sandbox they can reach everything that user can.',
  'A real CLI declining a dangerous request is model compliance, not isolation.',
] as const;

export const createReport = (input: {
  fixtureId: string | null;
  compatibility?: CompatibilityResult[];
  probes?: ProbeResult[];
  limitations?: string[];
}): DiagnosticReport =>
  diagnosticReportSchema.parse({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    productionCapabilityClaims: 'none',
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
    fixtureId: input.fixtureId,
    compatibility: input.compatibility ?? [],
    probes: input.probes ?? [],
    limitations: [...reportLimitations, ...(input.limitations ?? [])],
  });

/** Validates and writes a report (mode 0600) into the harness results directory. */
export const writeReport = async (
  resultsDirectory: string,
  name: string,
  report: DiagnosticReport,
): Promise<string> => {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error('Report names use lowercase letters, digits and dashes.');
  }
  const path = join(resultsDirectory, `${name}.json`);
  const validated = diagnosticReportSchema.parse(report);
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  return path;
};
