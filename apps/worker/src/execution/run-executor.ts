import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import {
  getAgentAdapter,
  startAgentExecution,
  type AgentEvent,
  type AgentHandle,
  type AgentRunResult,
  type CliDetectionOptions,
  type ExecutionLimits,
} from '@ai-agent-manager/agents';
import {
  evaluateTrustedLocalConsent,
  trustedLocalDisclosure,
  truncateText,
  type AgentRuntime,
  type GitIntegrityResultStatus,
  type TrustedLocalExecutionAuthorization,
} from '@ai-agent-manager/core';
import {
  appendRunEvent,
  findProjectById,
  findTaskRun,
  finishTaskRun,
  getTrustedLocalConsent,
  nextRunEventSequence,
  recordGitIntegrity,
  recordRunWorkspace,
  toProjectTrustState,
  updateTaskRunProgress,
  type ClaimedRun,
  type DatabaseConnection,
  type RunFinish,
} from '@ai-agent-manager/database';
import {
  captureGitIntegritySnapshot,
  createTaskWorktree,
  gitIntegritySections,
  TaskWorktreeError,
  validateRepository,
  verifyGitIntegrity,
  type GitIntegrityComparison,
  type GitIntegritySnapshot,
  type TaskWorktree,
} from '@ai-agent-manager/git';
import {
  authorizeTrustedLocalExecution,
  type AuthorizeTrustedLocalExecutionRequest,
  type TrustedLocalState,
} from '@ai-agent-manager/orchestrator';
import type { Logger } from '../logger.js';
import { normalizeAgentEvent } from './run-events.js';

// Executes one claimed task run (M4-02) through the production Trusted Local path:
//
//   claimed run → verify repository → create task worktree → detect CLI → prepare invocation →
//   Git integrity baseline → re-read persisted consent and trust → Trusted Local gate →
//   launch boundary → supervise → post-run Git integrity comparison → named task transition.
//
// The worker never constructs an authorization: it only passes the gate's result to
// `startAgentExecution`, in the same process, immediately. Nothing is committed, pushed, reset or
// deleted; the worktree and its files are retained on every outcome.

type Database = DatabaseConnection['db'];

export type StopReason = 'operator' | 'shutdown';

export type RunExecutorOptions = {
  db: Database;
  /** Validated managed worktree root (`resolveRuntimePaths().worktreeRoot`). */
  worktreeRoot: string;
  workerInstanceId: string;
  logger: Logger;
  now?: () => number;
  /** @internal Tests only: points CLI discovery at fake CLIs. */
  detectionOptions?: Partial<Record<AgentRuntime, CliDetectionOptions>>;
  /** @internal Tests only: tighter limits (the launch boundary refuses wider ones). */
  limits?: Partial<ExecutionLimits>;
  /** @internal Tests only. */
  captureBaseline?: typeof captureGitIntegritySnapshot;
  /** @internal Tests only. */
  verifyIntegrity?: typeof verifyGitIntegrity;
};

type Ending =
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'cancelled'; reason: StopReason }
  | { kind: 'launched'; result: AgentRunResult }
  | { kind: 'worker_error'; message: string };

type ActiveRun = {
  runId: string;
  handle: AgentHandle | null;
  stopReason: StopReason | null;
  done: Promise<void>;
};

/** Persisted baselines larger than this are not stored; restart recovery is then inconclusive. */
const maxBaselineJsonBytes = 4 * 1024 * 1024;
const maxStoredFindings = 50;

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

const describeError = (error: unknown): string =>
  truncateText(error instanceof Error ? `${error.name}: ${error.message}` : String(error), 500);

/** Identity in the form the Git integrity snapshot records (decimal strings of bigint stats). */
const fileIdentity = async (path: string): Promise<{ dev: string; ino: string }> => {
  const stats = await lstat(path, { bigint: true });
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
};

/**
 * The text sent to the agent on stdin: project instructions, then the task prompt. Global
 * instructions do not exist yet (Settings, M7). Repository instruction files are read by the CLI.
 */
export const composeRunPrompt = (projectInstructions: string, taskPrompt: string): string =>
  projectInstructions.trim() === ''
    ? taskPrompt
    : `Project instructions:\n${projectInstructions.trim()}\n\nTask:\n${taskPrompt}`;

/** A bounded, value-free summary of a comparison for `task_runs.git_integrity_result_json`. */
export const summarizeComparison = (comparison: GitIntegrityComparison) => ({
  status: comparison.status,
  publication: comparison.publication,
  totalFindings: comparison.totalFindings,
  findingsTruncated: comparison.findingsTruncated || comparison.findings.length > maxStoredFindings,
  findings: comparison.findings
    .slice(0, maxStoredFindings)
    .map(({ code, disposition, section, subject, change, refCategory }) => ({
      code,
      disposition,
      section,
      subject: truncateText(subject, 300),
      change,
      refCategory,
    })),
  beforeDigest: comparison.beforeDigest,
  afterDigest: comparison.afterDigest,
  coverage: comparison.coverage,
});

export type IntegrityOutcome = { status: GitIntegrityResultStatus; resultJson: string | null };

/** Runs the post-run comparison. Any failure is `inconclusive`, never `clean`. */
export const verifyAfterRun = async (
  baseline: GitIntegritySnapshot | null,
  verify: typeof verifyGitIntegrity,
): Promise<IntegrityOutcome> => {
  if (baseline === null) {
    return { status: 'not_run', resultJson: null };
  }
  try {
    const { comparison } = await verify(baseline);
    return {
      status: comparison.status,
      resultJson: JSON.stringify(summarizeComparison(comparison)),
    };
  } catch (error) {
    return {
      status: 'inconclusive',
      resultJson: JSON.stringify({ status: 'inconclusive', error: describeError(error) }),
    };
  }
};

/**
 * Maps the run's ending and Git integrity outcome to the stored run status and the named task
 * transition. Only a completed process **with a clean integrity check** reaches `Review`. A
 * completed run whose check found a violation or was inconclusive keeps run status `completed`
 * (the process outcome) and moves the task to `Failed` with an integrity error code, so it is not
 * review- or publish-eligible and its worktree is retained for inspection.
 */
export const resolveRunFinish = (
  ending: Ending,
  integrity: GitIntegrityResultStatus,
  operatorStopRequested: boolean,
): Pick<RunFinish, 'status' | 'taskAction' | 'errorCode' | 'errorMessage'> => {
  switch (ending.kind) {
    case 'refused':
      return {
        status: 'failed',
        taskAction: 'fail',
        errorCode: ending.code,
        errorMessage: ending.message,
      };
    case 'worker_error':
      return {
        status: 'failed',
        taskAction: 'fail',
        errorCode: 'worker_error',
        errorMessage: ending.message,
      };
    case 'cancelled':
      return ending.reason === 'operator' || operatorStopRequested
        ? { status: 'stopped', taskAction: 'stop', errorCode: null, errorMessage: null }
        : {
            status: 'interrupted',
            taskAction: 'interrupt',
            errorCode: 'worker_shutdown',
            errorMessage: 'The worker shut down before the agent was launched.',
          };
    case 'launched': {
      const { result } = ending;
      if (result.status === 'stopped') {
        return operatorStopRequested
          ? { status: 'stopped', taskAction: 'stop', errorCode: null, errorMessage: null }
          : {
              status: 'interrupted',
              taskAction: 'interrupt',
              errorCode: 'worker_shutdown',
              errorMessage:
                'The worker shut down and stopped the agent process group. It is not resumed automatically.',
            };
      }
      if (result.status === 'failed') {
        return {
          status: 'failed',
          taskAction: 'fail',
          errorCode: result.code,
          errorMessage: result.message,
        };
      }
      if (integrity === 'clean') {
        return {
          status: 'completed',
          taskAction: 'complete_execution',
          errorCode: null,
          errorMessage: null,
        };
      }
      return {
        status: 'completed',
        taskAction: 'fail',
        errorCode:
          integrity === 'violation' ? 'git_integrity_violation' : 'git_integrity_inconclusive',
        errorMessage:
          integrity === 'violation'
            ? 'The agent process completed, but the Git integrity check found an unexpected Git mutation. The result is not eligible for review or publishing; inspect the findings and the retained worktree.'
            : 'The agent process completed, but the Git integrity check could not confirm the Git state. The result is not eligible for review or publishing.',
      };
    }
  }
};

export type RunExecutor = {
  /** Executes a claimed run in the background; the promise settles after the run is finished. */
  execute: (claim: ClaimedRun) => Promise<void>;
  /** Requests a stop of an active run of this worker. Idempotent. */
  requestStop: (runId: string, reason: StopReason) => void;
  /** Stops every active run and waits until each is finished and recorded. */
  stopAll: (reason: StopReason) => Promise<void>;
  isActive: (runId: string) => boolean;
  readonly activeCount: number;
};

export const createRunExecutor = (options: RunExecutorOptions): RunExecutor => {
  const { db, logger } = options;
  const now = options.now ?? Date.now;
  const capture = options.captureBaseline ?? captureGitIntegritySnapshot;
  const verify = options.verifyIntegrity ?? verifyGitIntegrity;
  const active = new Map<string, ActiveRun>();

  const signalStop = (entry: ActiveRun): void => {
    const { handle } = entry;
    if (handle === null) return;
    // Deferred, so it never runs inside the supervisor's emit callback.
    setImmediate(() => {
      void handle.stop().catch(() => undefined);
    });
  };

  const requestStop = (runId: string, reason: StopReason): void => {
    const entry = active.get(runId);
    if (entry === undefined || entry.stopReason !== null) return;
    entry.stopReason = reason;
    if (reason === 'operator') {
      updateTaskRunProgress(db, runId, { status: 'stopping' }, now());
    }
    signalStop(entry);
  };

  const runOne = async (claim: ClaimedRun, entry: ActiveRun): Promise<void> => {
    const { run, task, project } = claim;
    const runtime = task.agentRuntime;
    let sequence = nextRunEventSequence(db, run.id);
    const record = (kind: string, payload: Record<string, unknown>): void => {
      try {
        appendRunEvent(db, { runId: run.id, sequence, kind, payload, createdAt: now() });
        sequence += 1;
      } catch (error) {
        logger.error(`Run ${run.id}: could not persist a ${kind} event.`, error);
      }
    };
    const stopped = (): StopReason | null => entry.stopReason;
    let baseline: GitIntegritySnapshot | null = null;
    let launched = false;
    let completed = false;

    const execute = async (): Promise<Ending> => {
      const refused = (code: string, message: string): Ending => ({
        kind: 'refused',
        code,
        message,
      });
      record('run_claimed', { attempt: run.attempt, runtime, securityMode: run.securityMode });

      // 1. The registered repository must still be the same repository.
      const validation = await validateRepository(project.localPath);
      if (
        !validation.valid ||
        validation.repository.root !== project.localPath ||
        validation.repository.commonDir !== project.gitCommonDir
      ) {
        return refused(
          'repository_changed',
          'The project repository is missing or is no longer the registered repository.',
        );
      }
      const reason = stopped();
      if (reason !== null) return { kind: 'cancelled', reason };

      // 2. A dedicated task branch and worktree from the resolved local base branch.
      const baseBranch = task.baseBranch ?? project.defaultBaseBranch;
      let worktree: TaskWorktree;
      try {
        worktree = await createTaskWorktree({
          repositoryPath: project.localPath,
          baseBranch,
          taskId: task.id,
          worktreeRoot: options.worktreeRoot,
        });
      } catch (error) {
        const code = error instanceof TaskWorktreeError ? error.code : 'unexpected';
        return refused('worktree_failed', `The task worktree could not be created (${code}).`);
      }
      recordRunWorkspace(db, {
        runId: run.id,
        workspace: {
          id: randomUUID(),
          taskId: task.id,
          generation: run.attempt,
          repositoryRoot: worktree.repository.root,
          gitCommonDir: worktree.repository.commonDir,
          worktreeRoot: options.worktreeRoot,
          path: worktree.path,
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          baseSha: worktree.baseCommit,
          createdAt: now(),
        },
      });
      record('worktree_created', {
        branch: worktree.branch,
        baseBranch: worktree.baseBranch,
        baseSha: worktree.baseCommit,
      });

      // 3. CLI discovery and the exact invocation, as production launches it.
      const adapter = getAgentAdapter(runtime);
      const detection = await adapter.detect(options.detectionOptions?.[runtime]);
      if (detection.status !== 'available') {
        return refused('cli_unavailable', detection.message);
      }
      const { installation } = detection;
      const prompt = composeRunPrompt(project.instructions, task.prompt);
      const preparation = adapter.prepareExecution(installation, {
        runId: run.id,
        prompt,
        modelId: task.modelId,
        workingDirectory: worktree.path,
        timeoutMs: run.timeoutMs,
      });
      if (!preparation.ok) {
        return refused(preparation.code, preparation.message);
      }
      const { plan } = preparation;
      updateTaskRunProgress(
        db,
        run.id,
        { launchProfileId: plan.launchProfileId, cliVersion: installation.version },
        now(),
      );

      // 4. Git integrity baseline. Every section must be observed, or nothing launches.
      try {
        baseline = await capture({
          repositoryPath: worktree.repository.root,
          worktreePath: worktree.path,
          branchName: worktree.branch,
          baseCommit: worktree.baseCommit,
          expectedRepository: {
            root: worktree.repository.root,
            commonDir: worktree.repository.commonDir,
            rootIdentity: await fileIdentity(worktree.repository.root),
            commonDirIdentity: await fileIdentity(worktree.repository.commonDir),
          },
        });
      } catch (error) {
        logger.error(`Run ${run.id}: the Git integrity baseline failed.`, error);
        return refused(
          'integrity_baseline_failed',
          'The Git integrity baseline could not be captured.',
        );
      }
      const failedSections = gitIntegritySections.filter(
        (section) => baseline?.[section].status !== 'observed',
      );
      const taskState =
        baseline.taskWorktree.status === 'observed' ? baseline.taskWorktree.value.state : null;
      if (failedSections.length > 0 || taskState !== 'ready') {
        // Not a usable baseline: nothing ran, so there is nothing to compare.
        baseline = null;
        return refused(
          'integrity_baseline_incomplete',
          `The Git integrity baseline is incomplete (${failedSections.join(', ') || 'task worktree not ready'}); the agent was not launched.`,
        );
      }
      const baselineJson = JSON.stringify(baseline);
      updateTaskRunProgress(
        db,
        run.id,
        {
          gitIntegrityBaselineJson:
            Buffer.byteLength(baselineJson) <= maxBaselineJsonBytes ? baselineJson : null,
        },
        now(),
      );
      record('integrity_baseline', { status: 'observed' });
      const beforeAuthorization = stopped();
      if (beforeAuthorization !== null) return { kind: 'cancelled', reason: beforeAuthorization };

      // 5. Consent and trust are re-read from persisted operator state, never from the claim.
      const consent = getTrustedLocalConsent(db);
      const currentProject = findProjectById(db, project.id);
      if (currentProject === undefined) {
        return refused('project_not_found', 'The project no longer exists.');
      }
      const decisionByConsent = evaluateTrustedLocalConsent(
        consent,
        toProjectTrustState(currentProject),
      );
      if (
        !decisionByConsent.ok ||
        consent.acceptedAt === null ||
        consent.disclosureVersion === null ||
        currentProject.executionTrustedCommonDir === null ||
        currentProject.executionTrustedAt === null
      ) {
        return refused(
          decisionByConsent.ok ? 'trusted_local_not_enabled' : decisionByConsent.code,
          decisionByConsent.ok ? 'Trusted Local consent is incomplete.' : decisionByConsent.message,
        );
      }
      const acceptedAt = iso(consent.acceptedAt);
      const trustedState: TrustedLocalState = {
        enabled: consent.enabled,
        currentDisclosureVersion: trustedLocalDisclosure.version,
        acceptance: {
          disclosureVersion: consent.disclosureVersion,
          acceptedAt,
          acceptedRisks: [...consent.acceptedRisks],
        },
        trustedRepositories: [
          {
            root: currentProject.localPath,
            commonDir: currentProject.executionTrustedCommonDir,
            trustedAt: iso(currentProject.executionTrustedAt),
          },
        ],
      };
      const request: AuthorizeTrustedLocalExecutionRequest = {
        policy: {
          mode: 'trusted_local',
          version: 1,
          acceptance: { disclosureVersion: consent.disclosureVersion, acceptedAt },
          acceptedRisks: [...consent.acceptedRisks],
          interactiveApproval: 'deny',
          timeoutMs: run.timeoutMs,
        },
        run: { runId: run.id, prompt },
        runtime,
        installation,
        modelId: task.modelId,
        invocation: plan.invocation,
        workspace: {
          taskId: task.id,
          repositoryPath: worktree.repository.root,
          commonDir: worktree.repository.commonDir,
          worktreeRoot: options.worktreeRoot,
          worktreePath: worktree.path,
          branchName: worktree.branch,
          baseCommit: worktree.baseCommit,
        },
      };
      const decision = await authorizeTrustedLocalExecution(request, trustedState);
      if (!decision.authorized) {
        const codes = [...new Set(decision.denials.map((denial) => denial.code))];
        record('authorization_denied', { codes });
        return refused(
          'authorization_denied',
          `The Trusted Local gate denied the run: ${codes.join(', ')}.`,
        );
      }
      const authorization: TrustedLocalExecutionAuthorization = decision.authorization;
      updateTaskRunProgress(
        db,
        run.id,
        {
          authorizationId: authorization.authorizationId,
          controlAssessmentJson: JSON.stringify(
            authorization.controlAssessments.map(({ control, status, mechanism }) => ({
              control,
              status,
              mechanism,
            })),
          ),
          acceptedRisksJson: JSON.stringify(authorization.acceptedRisks),
          safeguardsJson: JSON.stringify(authorization.safeguards),
          processContainment: authorization.processContainment,
        },
        now(),
      );
      record('authorized', {
        authorizationId: authorization.authorizationId,
        safeguards: [...authorization.safeguards],
        acceptedRisks: [...authorization.acceptedRisks],
      });
      const beforeLaunch = stopped();
      if (beforeLaunch !== null) {
        // The unused authorization expires in the issuance registry; it is never stored.
        return { kind: 'cancelled', reason: beforeLaunch };
      }

      // 6. Launch through the production boundary, in this process, immediately.
      const emit = (event: AgentEvent): void => {
        try {
          const normalized = normalizeAgentEvent(event);
          record(normalized.kind, normalized.payload);
          if (event.type === 'metadata' && event.sessionId !== undefined) {
            updateTaskRunProgress(
              db,
              run.id,
              { sessionId: truncateText(event.sessionId, 200) },
              now(),
            );
          }
        } catch (error) {
          logger.error(`Run ${run.id}: an agent event could not be recorded.`, error);
        }
      };
      const started = await startAgentExecution({
        securityMode: 'trusted_local',
        adapter,
        installation,
        request: { runId: run.id, prompt, modelId: task.modelId, workingDirectory: worktree.path },
        authorization,
        emit,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });
      if (!started.started) {
        return refused('launch_rejected', `The launch boundary refused the run (${started.code}).`);
      }
      launched = true;
      entry.handle = started.handle;
      updateTaskRunProgress(
        db,
        run.id,
        {
          status: entry.stopReason === 'operator' ? 'stopping' : 'running',
          pid: started.handle.pid,
          startedAt: now(),
        },
        now(),
      );
      logger.info(
        `Run ${run.id}: started ${runtime} (pid ${started.handle.pid ?? 'unknown'}, own process group; descendants that leave it are not tracked).`,
      );
      if (entry.stopReason !== null) {
        signalStop(entry);
      }
      const result = await started.handle.completed;
      completed = true;
      return { kind: 'launched', result };
    };

    let ending: Ending;
    try {
      ending = await execute();
    } catch (error) {
      logger.error(`Run ${run.id}: the worker failed while executing the run.`, error);
      ending = { kind: 'worker_error', message: describeError(error) };
      if (launched && !completed && entry.handle !== null) {
        // Never leave the CLI running behind a failed worker path.
        await entry.handle.stop().catch(() => null);
      }
    }

    // 7. Post-run Git integrity comparison, attempted after every outcome that had a baseline.
    const integrity = await verifyAfterRun(baseline, verify);
    if (integrity.status !== 'not_run') {
      recordGitIntegrity(db, run.id, { ...integrity, checkedAt: now() });
      record('git_integrity', { status: integrity.status });
    }

    const operatorStopRequested =
      entry.stopReason === 'operator' || findTaskRun(db, run.id)?.stopRequestedAt != null;
    const finish = resolveRunFinish(ending, integrity.status, operatorStopRequested);
    const result = ending.kind === 'launched' ? ending.result : null;
    const finished = finishTaskRun(db, run.id, {
      ...finish,
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      lingeringProcesses: result?.lingeringProcesses ?? null,
      summary: result?.status === 'completed' ? (result.summary ?? null) : null,
      ...(result?.sessionId === undefined
        ? {}
        : { sessionId: truncateText(result.sessionId, 200) }),
      ...(result?.reportedModelId === undefined
        ? {}
        : { effectiveModelId: truncateText(result.reportedModelId, 200) }),
      endedAt: now(),
    });
    record('run_finished', {
      status: finish.status,
      errorCode: finish.errorCode ?? null,
      gitIntegrity: integrity.status,
    });
    logger.info(
      `Run ${run.id}: ${finish.status}${finish.errorCode ? ` (${finish.errorCode})` : ''}; task ${finished?.task.status ?? 'unchanged'}; Git integrity ${integrity.status}.`,
    );
  };

  const execute = (claim: ClaimedRun): Promise<void> => {
    let resolveDone: () => void = () => undefined;
    const entry: ActiveRun = {
      runId: claim.run.id,
      handle: null,
      stopReason: null,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
    };
    active.set(claim.run.id, entry);
    void runOne(claim, entry)
      .catch((error: unknown) => logger.error(`Run ${claim.run.id}: finishing failed.`, error))
      .finally(() => {
        active.delete(claim.run.id);
        resolveDone();
      });
    return entry.done;
  };

  const stopAll = async (reason: StopReason): Promise<void> => {
    const entries = [...active.values()];
    for (const entry of entries) requestStop(entry.runId, reason);
    await Promise.all(entries.map((entry) => entry.done));
  };

  return {
    execute,
    requestStop,
    stopAll,
    isActive: (runId) => active.has(runId),
    get activeCount() {
      return active.size;
    },
  };
};
