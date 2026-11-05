import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultExecutionLimits,
  getAgentAdapter,
  startAgentExecution,
  type AgentEvent,
  type AgentHandle,
  type AgentRunResult,
  type CliDetectionOptions,
  type CliInstallation,
} from '@ai-agent-manager/agents';
import {
  assessControl,
  securityControls,
  type AgentRuntime,
  type ControlAssessment,
} from '@ai-agent-manager/core';
import {
  captureGitIntegritySnapshot,
  gitIntegritySections,
  inspectTaskChanges,
  verifyGitIntegrity,
  type GitIntegritySnapshot,
} from '@ai-agent-manager/git';
import {
  authorizeTrustedLocalExecution,
  type AuthorizeTrustedLocalExecutionRequest,
  type TrustedLocalState,
} from '@ai-agent-manager/orchestrator';
import type { ProtectedRoot } from '../paths.js';
import {
  confirmationToken,
  type ApprovalDecision,
  type ApprovalSummary,
  type ConfirmRun,
} from './approval.js';
import {
  codingEditTarget,
  smokeCheckIdSchema,
  smokeChecks,
  smokeRuntimeSchema,
  type SmokeCheck,
  type SmokeCheckId,
} from './checks.js';
import {
  claimSmokeFixture,
  recordSmokeProcess,
  SmokeFixtureError,
  verifySmokeFixture,
  type VerifiedSmokeFixture,
} from './fixture.js';
import {
  classifyLaunchedRun,
  maxReportedTools,
  smokeDisclosureVersion,
  smokeLimitations,
  writeSmokeReport,
  type SmokeClassification,
  type SmokeExecution,
  type SmokeIntegrity,
  type SmokeReport,
  type SmokeVerificationType,
} from './report.js';

// SEC-02e smoke runner: one fixed compatibility check through the production Trusted Local path
// (`authorizeTrustedLocalExecution` → `startAgentExecution`, same process), wrapped in a Git
// integrity baseline and comparison. It never imports the unguarded diagnostics supervisor.

export type SmokeRunInput = {
  manifestPath: string;
  /** Validated against the runtime allow list. */
  runtime: unknown;
  /** Validated against the fixed check catalog. */
  checkId: unknown;
  /** Aborting requests a stop through `AgentHandle.stop()` (or cancels before launch). */
  signal?: AbortSignal;
};

/**
 * Dependencies of the runner. The command line uses only `confirm` (terminal approval) and
 * `verification: 'operator_supervised_real_cli'`; every other field exists for offline tests.
 */
export type SmokeRunnerDependencies = {
  confirm: ConfirmRun;
  verification: SmokeVerificationType;
  /** @internal Tests only: points discovery at a fake CLI. */
  detectionOptions?: CliDetectionOptions;
  /** @internal Tests only. */
  protectedRoots?: readonly ProtectedRoot[];
  /** @internal Tests only: shorter timeouts for the same checks. */
  checks?: Readonly<Record<SmokeCheckId, SmokeCheck>>;
  /** @internal Tests only: simulate integrity inspection failures. */
  captureBaseline?: typeof captureGitIntegritySnapshot;
  /** @internal Tests only. */
  verifyIntegrity?: typeof verifyGitIntegrity;
  log?: (line: string) => void;
};

export type SmokeRunOutcome = {
  classification: SmokeClassification;
  reasons: string[];
  /** `null` when the fixture could not be verified, so nothing was written into it. */
  reportPath: string | null;
  report: SmokeReport | null;
};

const sha256 = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

/** Identity in the form the Git integrity snapshot records (decimal strings of bigint stats). */
const gitFileIdentity = async (path: string): Promise<{ dev: string; ino: string }> => {
  const stats = await lstat(path, { bigint: true });
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
};

/**
 * What a report may say about an error: its class and code. Messages can embed Git stderr or
 * paths, so they go to the operator's terminal only.
 */
const errorKind = (error: unknown): string => {
  if (!(error instanceof Error)) return 'non-Error value';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code)
    ? `${error.name} (${code})`
    : error.name;
};

/** Error name and message only, bounded; never a stack or an attached cause. Terminal only. */
const describeError = (error: unknown): string =>
  (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);

/**
 * A tool name as it may appear in a report: a short identifier, otherwise `other`. At most
 * `maxReportedTools` distinct names; later names are counted under `other`.
 */
const reportableToolName = (name: string, seen: ReadonlyMap<string, unknown>): string => {
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(name) || name === 'other') return 'other';
  return seen.has(name) || seen.size < maxReportedTools ? name : 'other';
};

const outputEventTypes = new Set(['message', 'tool_activity', 'metadata', 'provider_notice']);

const maxReportedChanges = 50;
const maxReportedFindings = 100;

const notRunIntegrity = (): SmokeIntegrity => ({
  baseline: 'not_captured',
  baselineFailedSections: [],
  status: 'not_run',
  publication: 'blocked_smoke_fixture',
  findings: [],
  totalFindings: 0,
  beforeDigest: null,
  afterDigest: null,
  error: null,
  coverage: 'observable_before_after_state',
  appliedAs: 'diagnostic_only',
});

/** Reads the coding-edit target without following links; content is compared, never stored. */
const expectedEditMatches = async (worktreePath: string): Promise<boolean> => {
  const path = join(worktreePath, codingEditTarget.path);
  const stats = await lstat(path).catch(() => null);
  if (stats === null || !stats.isFile() || stats.size > 4096) {
    return false;
  }
  const content = await readFile(path, 'utf8').catch(() => null);
  return content !== null && content.trim() === codingEditTarget.content;
};

export const createSmokeRunner =
  (dependencies: SmokeRunnerDependencies) =>
  async (input: SmokeRunInput): Promise<SmokeRunOutcome> => {
    const log = dependencies.log ?? (() => undefined);
    // A function, so TypeScript does not narrow the abort state across awaits.
    const cancelled = (): boolean => input.signal?.aborted === true;
    const catalog = dependencies.checks ?? smokeChecks;
    const runtimeParsed = smokeRuntimeSchema.safeParse(input.runtime);
    const checkParsed = smokeCheckIdSchema.safeParse(input.checkId);
    if (!runtimeParsed.success || !checkParsed.success) {
      return {
        classification: 'aborted',
        reasons: [
          ...(runtimeParsed.success ? [] : ['Unknown runtime; use claude or codex.']),
          ...(checkParsed.success ? [] : ['Unknown check ID; see the fixed check catalog.']),
        ],
        reportPath: null,
        report: null,
      };
    }
    const runtime: AgentRuntime = runtimeParsed.data;
    const check = catalog[checkParsed.data];
    const fixtureOptions =
      dependencies.protectedRoots === undefined
        ? {}
        : { protectedRoots: dependencies.protectedRoots };

    let fixture: VerifiedSmokeFixture;
    try {
      fixture = await verifySmokeFixture(input.manifestPath, fixtureOptions);
    } catch (error) {
      const reasons = error instanceof SmokeFixtureError ? [...error.reasons] : [String(error)];
      return { classification: 'aborted', reasons, reportPath: null, report: null };
    }

    const runId = `smoke-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const limits = {
      timeoutMs: check.timeoutMs,
      maxStdoutBytes: check.limits.maxStdoutBytes ?? defaultExecutionLimits.maxStdoutBytes,
      stopGraceMs: defaultExecutionLimits.stopGraceMs,
    };
    const report: SmokeReport = {
      kind: 'aam_trusted_local_smoke_run',
      schemaVersion: 1,
      runId,
      fixtureId: fixture.manifest.fixtureId,
      runtime,
      checkId: check.id,
      covers: [...check.covers],
      verification: dependencies.verification,
      startedAt,
      endedAt: startedAt,
      cli: {
        executablePath: null,
        version: null,
        versionAfter: null,
        executableChanged: null,
        launchProfileId: null,
        arguments: [],
        environmentNames: [],
        modelId: check.modelId,
      },
      promptDigest: null,
      limits,
      approval: { decision: 'not_requested', method: 'none', decidedAt: null },
      authorization: {
        requested: false,
        authorized: false,
        authorizationId: null,
        denialCodes: [],
        securityMode: 'trusted_local',
        disclosureVersion: smokeDisclosureVersion,
        acceptedRisks: [],
        safeguards: [],
        controlAssessments: [],
      },
      launch: { processStarted: false, rejectionCode: null },
      execution: null,
      integrity: notRunIntegrity(),
      worktreeChanges: null,
      classification: 'aborted',
      reasons: [],
      limitations: [
        ...smokeLimitations,
        ...(dependencies.verification === 'offline_fake_cli'
          ? ['Offline run against a fake CLI: says nothing about the real CLI.']
          : []),
      ],
      productionCapabilityClaims: 'none',
    };
    const finish = async (
      classification: SmokeClassification,
      reasons: string[],
    ): Promise<SmokeRunOutcome> => {
      report.classification = classification;
      report.reasons = reasons;
      report.endedAt = new Date().toISOString();
      const reportPath = await writeSmokeReport(fixture.manifest.resultsDirectory, report);
      return { classification, reasons, reportPath, report };
    };

    // State shared with the failure guard below, so an unexpected exception after launch still
    // stops the CLI, attempts the post-run integrity check and writes a non-passing report.
    const guard: {
      collectAfterRun: (() => Promise<boolean>) | null;
      postRunCollected: boolean;
      activeHandle: AgentHandle | null;
      runCompleted: boolean;
    } = { collectAfterRun: null, postRunCollected: false, activeHandle: null, runCompleted: false };

    const execute = async (): Promise<SmokeRunOutcome> => {
      if (check.support.status === 'blocked') {
        return finish('aborted', [`Check ${check.id} is blocked: ${check.support.reason}`]);
      }

      // CLI discovery and invocation preparation, exactly as production.
      const adapter = getAgentAdapter(runtime);
      const detection = await adapter.detect(dependencies.detectionOptions);
      if (detection.status !== 'available') {
        return finish('aborted', [`The ${runtime} CLI is unavailable (${detection.reason}).`]);
      }
      const installation: CliInstallation = detection.installation;
      report.cli.executablePath = installation.executablePath;
      report.cli.version = installation.version;
      const prepared = check.prepare();
      const prompt = prepared.prompt;
      report.promptDigest = sha256(prompt);
      const workingDirectory = fixture.worktree.path;
      const preparation = adapter.prepareExecution(installation, {
        runId,
        prompt,
        modelId: check.modelId,
        workingDirectory,
        timeoutMs: check.timeoutMs,
      });
      if (!preparation.ok) {
        return finish('refused_before_launch', [
          `The adapter refused to prepare the launch (${preparation.code}).`,
        ]);
      }
      const { plan } = preparation;
      report.cli.launchProfileId = plan.launchProfileId;
      report.cli.arguments = [...plan.args];
      report.cli.environmentNames = [...plan.environmentNames];

      // Honest assessments from the shipped profile; the risks are what is not enforced.
      const assessments: ControlAssessment[] = securityControls.map((control) =>
        assessControl(adapter.securityProfile, control, installation.version),
      );
      const acceptedRisks = assessments
        .filter((assessment) => assessment.status !== 'enforced')
        .map((assessment) => assessment.control);
      report.authorization.acceptedRisks = acceptedRisks;
      report.authorization.controlAssessments = assessments.map(({ control, status }) => ({
        control,
        status,
      }));

      // Explicit operator approval for this one run.
      const summary: ApprovalSummary = {
        fixtureId: fixture.manifest.fixtureId,
        runId,
        runtime,
        cliVersion: installation.version,
        executablePath: installation.executablePath,
        checkId: check.id,
        objective: check.objective,
        prompt,
        invocation: [plan.executablePath, ...plan.args],
        environmentNames: plan.environmentNames,
        workingDirectory,
        modelId: check.modelId,
        timeoutMs: limits.timeoutMs,
        maxStdoutBytes: limits.maxStdoutBytes,
        disclosureVersion: smokeDisclosureVersion,
        acceptedRisks,
        limitations: smokeLimitations,
        confirmationToken: confirmationToken(fixture.manifest.fixtureId, runtime, check.id, runId),
      };
      if (cancelled()) {
        return finish('aborted', ['Cancelled by the operator before approval.']);
      }
      const decision: ApprovalDecision = await dependencies.confirm(summary);
      report.approval = {
        decision: decision.approved ? 'approved' : 'declined',
        method: decision.method,
        decidedAt: decision.decidedAt,
      };
      if (!decision.approved) {
        return finish('aborted', [
          decision.reason === 'not_interactive'
            ? 'Approval requires an interactive terminal.'
            : decision.reason === 'interrupted'
              ? 'The operator cancelled the approval prompt.'
              : 'The operator did not approve this run.',
        ]);
      }
      if (cancelled()) {
        return finish('aborted', ['Cancelled by the operator after approval, before launch.']);
      }

      // Re-verify after the (possibly long) approval, then claim the fixture for this run only.
      try {
        fixture = await verifySmokeFixture(input.manifestPath, fixtureOptions);
        await claimSmokeFixture(fixture, runId);
      } catch (error) {
        const detail = error instanceof SmokeFixtureError ? error.reasons : [errorKind(error)];
        return finish('aborted', ['The fixture changed or was used during approval.', ...detail]);
      }

      // Git integrity baseline. Every section must be observed, or nothing launches.
      let baseline: GitIntegritySnapshot;
      try {
        baseline = await (dependencies.captureBaseline ?? captureGitIntegritySnapshot)({
          repositoryPath: fixture.repository.root,
          worktreePath: fixture.worktree.path,
          branchName: fixture.worktree.branch,
          baseCommit: fixture.worktree.baseCommit,
          expectedRepository: {
            root: fixture.repository.root,
            commonDir: fixture.repository.commonDir,
            rootIdentity: await gitFileIdentity(fixture.repository.root),
            commonDirIdentity: await gitFileIdentity(fixture.repository.commonDir),
          },
        });
      } catch (error) {
        log(`Baseline capture failed: ${describeError(error)}`);
        report.integrity = { ...notRunIntegrity(), baseline: 'error', error: errorKind(error) };
        return finish('aborted', ['The Git integrity baseline could not be captured.']);
      }
      const failedSections = gitIntegritySections.filter(
        (section) => baseline[section].status !== 'observed',
      );
      const taskState =
        baseline.taskWorktree.status === 'observed' ? baseline.taskWorktree.value.state : null;
      if (failedSections.length > 0 || taskState !== 'ready') {
        report.integrity = {
          ...notRunIntegrity(),
          baseline: 'incomplete',
          baselineFailedSections: [...failedSections],
        };
        return finish('aborted', [
          'The Git integrity baseline is incomplete; the CLI was not launched.',
        ]);
      }
      report.integrity = { ...notRunIntegrity(), baseline: 'observed' };
      if (cancelled()) {
        return finish('aborted', ['Cancelled by the operator before authorization; nothing ran.']);
      }

      // Post-run evidence, collected after every terminal outcome, including a refused launch.
      const collect = async (): Promise<boolean> => {
        guard.postRunCollected = true;
        try {
          const verified = await (dependencies.verifyIntegrity ?? verifyGitIntegrity)(baseline);
          const { comparison } = verified;
          report.integrity = {
            ...report.integrity,
            status: comparison.status,
            findings: comparison.findings
              .slice(0, maxReportedFindings)
              .map(({ code, disposition, section, subject, change }) => ({
                code,
                disposition,
                section,
                subject,
                change,
              })),
            totalFindings: comparison.totalFindings,
            beforeDigest: comparison.beforeDigest,
            afterDigest: comparison.afterDigest,
          };
        } catch (error) {
          log(`Post-run integrity verification failed: ${describeError(error)}`);
          report.integrity = {
            ...report.integrity,
            status: 'inconclusive',
            error: errorKind(error),
          };
        }
        const changes = await inspectTaskChanges({
          repositoryPath: fixture.repository.root,
          worktreePath: fixture.worktree.path,
          branchName: fixture.worktree.branch,
          baseCommit: fixture.worktree.baseCommit,
        }).catch(() => null);
        if (changes !== null) {
          const onlyExpected =
            changes.totalFiles === 1 &&
            changes.files[0]?.path === codingEditTarget.path &&
            changes.files[0].committed === false;
          report.worktreeChanges = {
            files: changes.files.slice(0, maxReportedChanges).map((file) => ({
              path: file.path,
              change: file.change,
              tracked: file.tracked,
              committed: file.committed,
            })),
            totalFiles: changes.totalFiles,
            expectedEditMatched:
              check.id === 'coding-edit'
                ? onlyExpected && (await expectedEditMatches(fixture.worktree.path))
                : null,
          };
        }
        const after = await adapter.detect(dependencies.detectionOptions).catch(() => null);
        if (after === null || after.status !== 'available') {
          return true;
        }
        report.cli.versionAfter = after.installation.version;
        const before = installation.fingerprint;
        const now = after.installation.fingerprint;
        report.cli.executableChanged =
          after.installation.executablePath !== installation.executablePath ||
          before.dev !== now.dev ||
          before.ino !== now.ino ||
          before.size !== now.size ||
          before.mtimeMs !== now.mtimeMs;
        return after.installation.version !== installation.version || report.cli.executableChanged;
      };
      guard.collectAfterRun = collect;
      const integrityReasons = (): string[] =>
        report.integrity.status === 'violation'
          ? ['The Git integrity check found an unexpected Git mutation.']
          : report.integrity.status === 'clean'
            ? []
            : ['The Git integrity check was incomplete or failed.'];

      // In-memory trusted state, for this verified fixture repository only. Never persisted.
      const acceptedAt = decision.decidedAt;
      const trustedState: TrustedLocalState = {
        enabled: true,
        currentDisclosureVersion: smokeDisclosureVersion,
        acceptance: { disclosureVersion: smokeDisclosureVersion, acceptedAt, acceptedRisks },
        trustedRepositories: [
          {
            root: fixture.repository.root,
            commonDir: fixture.repository.commonDir,
            trustedAt: acceptedAt,
          },
        ],
      };
      const request: AuthorizeTrustedLocalExecutionRequest = {
        policy: {
          mode: 'trusted_local',
          version: 1,
          acceptance: { disclosureVersion: smokeDisclosureVersion, acceptedAt },
          acceptedRisks,
          interactiveApproval: 'deny',
          timeoutMs: check.timeoutMs,
        },
        run: { runId, prompt },
        runtime,
        installation,
        modelId: check.modelId,
        invocation: plan.invocation,
        workspace: {
          taskId: fixture.taskId,
          repositoryPath: fixture.repository.root,
          commonDir: fixture.repository.commonDir,
          worktreeRoot: fixture.worktree.worktreeRoot,
          worktreePath: fixture.worktree.path,
          branchName: fixture.worktree.branch,
          baseCommit: fixture.worktree.baseCommit,
        },
      };
      report.authorization.requested = true;
      const authorization = await authorizeTrustedLocalExecution(request, trustedState);
      if (!authorization.authorized) {
        report.authorization.denialCodes = authorization.denials.map((denial) => denial.code);
        await collect();
        return finish(
          report.integrity.status === 'violation' ? 'integrity_violation' : 'refused_before_launch',
          [
            `The Trusted Local gate denied the run: ${report.authorization.denialCodes.join(', ')}.`,
            ...integrityReasons(),
          ],
        );
      }
      const granted = authorization.authorization;
      report.authorization.authorized = true;
      report.authorization.authorizationId = granted.authorizationId;
      report.authorization.safeguards = [...granted.safeguards];
      if (granted.safeguards.includes('post_run_git_integrity_check')) {
        // The worker lifecycle does not exist; the launch boundary would refuse it as well.
        await collect();
        return finish('refused_before_launch', [
          'The authorization lists post_run_git_integrity_check, which no lifecycle applies yet.',
        ]);
      }

      if (cancelled()) {
        // The unused authorization expires; it is never stored or reused.
        await collect();
        return finish('aborted', ['Cancelled by the operator before launch; nothing ran.']);
      }

      // Launch through the production boundary in this process.
      const counts: Record<string, number> = {};
      const diagnosticCodes = new Set<string>();
      let sessionIdReported = false;
      let reportedModelId: string | null = null;
      let tokenObserved = false;
      let handle: AgentHandle | null = null;
      let stopRequestedBy: 'check' | 'operator' | null = null;
      const requestStop = (by: 'check' | 'operator'): void => {
        if (stopRequestedBy !== null) return;
        stopRequestedBy = by;
        log(`Requesting stop (${by}) through AgentHandle.stop().`);
        // Deferred, so it never runs inside the supervisor's emit callback.
        setImmediate(() => void handle?.stop());
      };
      const tools = new Map<string, { started: number; completed: number; failed: number }>();
      const emit = (event: AgentEvent): void => {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        if (event.type === 'tool_activity') {
          const name = reportableToolName(event.toolName, tools);
          const entry = tools.get(name) ?? { started: 0, completed: 0, failed: 0 };
          entry[event.phase] += 1;
          tools.set(name, entry);
        }
        if (event.type === 'diagnostic') diagnosticCodes.add(event.code);
        if (event.type === 'metadata') {
          if (event.sessionId !== undefined) sessionIdReported = true;
          if (event.reportedModelId !== undefined) reportedModelId = event.reportedModelId;
        }
        if (
          event.type === 'message' &&
          prepared.expectedToken !== null &&
          event.text.includes(prepared.expectedToken)
        ) {
          tokenObserved = true;
        }
        if (check.stopAtFirstOutput && outputEventTypes.has(event.type)) requestStop('check');
      };
      const onAbort = (): void => requestStop('operator');
      input.signal?.addEventListener('abort', onAbort, { once: true });
      let result: AgentRunResult;
      try {
        const started = await startAgentExecution({
          securityMode: 'trusted_local',
          adapter,
          installation,
          request: { runId, prompt, modelId: check.modelId, workingDirectory },
          authorization: granted,
          emit,
          limits: { ...check.limits },
        });
        if (!started.started) {
          report.launch.rejectionCode = started.code;
          await collect();
          return finish(
            report.integrity.status === 'violation'
              ? 'integrity_violation'
              : 'refused_before_launch',
            [`The launch boundary refused the run (${started.code}).`, ...integrityReasons()],
          );
        }
        report.launch.processStarted = true;
        handle = started.handle;
        guard.activeHandle = started.handle;
        await recordSmokeProcess(
          fixture.manifest.resultsDirectory,
          runId,
          started.handle.pid,
        ).catch(() => log('Could not write the run-process recovery record; continuing.'));
        log(
          `Started ${runtime}: pid ${started.handle.pid ?? 'unknown'}, own process group (process_group_only; descendants that leave it are not tracked, SEC-01). Ctrl+C requests a stop.`,
        );
        if (stopRequestedBy !== null || cancelled()) {
          stopRequestedBy ??= 'operator';
          void started.handle.stop();
        }
        result = await started.handle.completed;
        guard.runCompleted = true;
      } finally {
        input.signal?.removeEventListener('abort', onAbort);
      }

      const execution: SmokeExecution = {
        status: result.status,
        failureCode: result.status === 'failed' ? result.code : null,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: Date.parse(result.endedAt) - Date.parse(result.startedAt),
        securityMode: result.securityMode,
        processContainment: result.processContainment,
        lingeringProcesses: result.lingeringProcesses,
        stopRequestedBy,
        eventCounts: counts,
        toolActivity: [...tools.entries()]
          .map(([toolName, phases]) => ({ toolName, ...phases }))
          .sort((left, right) => (left.toolName < right.toolName ? -1 : 1)),
        diagnosticCodes: [...diagnosticCodes].sort(),
        sessionIdReported,
        reportedModelId,
        tokenObserved: prepared.expectedToken === null ? null : tokenObserved,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
      };
      report.execution = execution;
      log(
        `Run ended: ${execution.status}${execution.failureCode ? `/${execution.failureCode}` : ''}.`,
      );
      const versionChanged = await collect();
      const verdict = classifyLaunchedRun({
        checkId: check.id,
        execution,
        integrityStatus: report.integrity.status,
        versionChanged,
        worktreeChanges: report.worktreeChanges,
        requestedModelId: check.modelId,
        operatorInterrupted: stopRequestedBy === 'operator',
      });
      return finish(verdict.classification, verdict.reasons);
    };

    try {
      return await execute();
    } catch (error) {
      log(`The runner failed: ${describeError(error)}`);
      const reasons = [
        `The runner failed unexpectedly (${errorKind(error)}); details were printed to the terminal only.`,
      ];
      if (guard.activeHandle !== null && !guard.runCompleted) {
        // Never leave the CLI running behind a failed runner.
        const stopped = await guard.activeHandle.stop().catch(() => null);
        reasons.push(
          stopped === null
            ? 'The CLI stop could not be confirmed; check its process group manually.'
            : `The CLI was stopped (${stopped.status}, process group only).`,
        );
      }
      if (guard.collectAfterRun !== null && !guard.postRunCollected) {
        await guard.collectAfterRun().catch(() => false);
      }
      if (report.integrity.status === 'violation') {
        reasons.push('The Git integrity check found an unexpected Git mutation.');
      }
      return finish(
        report.integrity.status === 'violation'
          ? 'integrity_violation'
          : report.launch.processStarted
            ? 'inconclusive'
            : 'aborted',
        reasons,
      );
    }
  };
