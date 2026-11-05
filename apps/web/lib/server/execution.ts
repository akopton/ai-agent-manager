import { randomUUID } from 'node:crypto';
import {
  ExecutionError,
  isRunReviewEligible,
  projectIdSchema,
  trustedLocalDisclosure,
  type AcceptTrustedLocalInput,
  type ProjectExecutionTrustInput,
  type TaskRunStatus,
} from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  disableTrustedLocal,
  findLatestTaskCommand,
  findProjectById,
  findTaskById,
  getTrustedLocalConsent,
  listRunEvents,
  listTaskRuns,
  listTaskWorkspaces,
  requestRunStop,
  requestTaskExecution,
  setProjectExecutionTrust,
  type DatabaseConnection,
  type ProjectRecordWithTrust,
  type TaskRunRecord,
} from '@ai-agent-manager/database';
import { validateRepository } from '@ai-agent-manager/git';
import type {
  ExecutionSettingsView,
  ProjectTrustView,
  TaskExecutionView,
  TaskRunView,
} from '@/lib/execution/contracts';

// Operator-facing execution commands for the web app. Nothing here launches an agent, creates a
// worktree or touches a repository except read-only identity checks: the web process records
// consent, trust, start requests and stop intents; the worker claims and executes them.

type Database = DatabaseConnection['db'];

export type ExecutionServiceOptions = { now?: () => number; createId?: () => string };

const projectNotFound = (): ExecutionError =>
  new ExecutionError('project_not_found', 'The project does not exist.');

const requireProject = (db: Database, projectId: string): ProjectRecordWithTrust => {
  const parsed = projectIdSchema.safeParse(projectId);
  const record = parsed.success ? findProjectById(db, parsed.data) : undefined;
  if (record === undefined) {
    throw projectNotFound();
  }
  return record;
};

const requireProjectTaskId = (db: Database, projectId: string, taskId: string): string => {
  const project = requireProject(db, projectId);
  const task = findTaskById(db, taskId);
  if (task === undefined || task.projectId !== project.id) {
    throw new ExecutionError('task_not_found', 'The task does not exist.');
  }
  return task.id;
};

export const getExecutionSettings = (db: Database): ExecutionSettingsView => {
  const consent = getTrustedLocalConsent(db);
  return {
    disclosure: {
      version: trustedLocalDisclosure.version,
      title: trustedLocalDisclosure.title,
      statements: [...trustedLocalDisclosure.statements],
      acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
    },
    trustedLocal: {
      enabled: consent.enabled,
      acceptedDisclosureVersion: consent.disclosureVersion,
      acceptedAt: consent.acceptedAt,
      current: consent.enabled && consent.disclosureVersion === trustedLocalDisclosure.version,
    },
  };
};

/** Records the operator's explicit acceptance of the current disclosure. */
export const enableTrustedLocal = (
  db: Database,
  input: AcceptTrustedLocalInput,
  { now = Date.now }: ExecutionServiceOptions = {},
): ExecutionSettingsView => {
  acceptTrustedLocal(db, { input, now: now() });
  return getExecutionSettings(db);
};

/** Disables Trusted Local Mode. Active runs are not stopped; new starts are refused. */
export const disableTrustedLocalMode = (
  db: Database,
  { now = Date.now }: ExecutionServiceOptions = {},
): ExecutionSettingsView => {
  disableTrustedLocal(db, { now: now() });
  return getExecutionSettings(db);
};

export const toProjectTrustView = (project: ProjectRecordWithTrust): ProjectTrustView => ({
  executionTrust: project.executionTrust,
  trustedCommonDir: project.executionTrustedCommonDir,
  trustedAt: project.executionTrustedAt,
  current:
    project.executionTrust === 'trusted_local' &&
    project.executionTrustedCommonDir === project.gitCommonDir,
});

export const getProjectTrust = (db: Database, projectId: string): ProjectTrustView =>
  toProjectTrustView(requireProject(db, projectId));

/**
 * Grants or revokes Trusted Local execution for a project. Granting re-validates the stored
 * canonical path (never a browser-supplied path) and requires the live repository to be the one
 * the operator confirmed: same root and common Git directory.
 */
export const setProjectTrust = async (
  db: Database,
  projectId: string,
  input: ProjectExecutionTrustInput,
  { now = Date.now }: ExecutionServiceOptions = {},
): Promise<ProjectTrustView> => {
  const project = requireProject(db, projectId);
  if (input.trust === 'trusted_local') {
    if (input.localPath !== project.localPath || input.gitCommonDir !== project.gitCommonDir) {
      throw new ExecutionError(
        'repository_changed',
        'The confirmed repository differs from the registered project. Reload the page.',
      );
    }
    const validation = await validateRepository(project.localPath);
    if (
      !validation.valid ||
      validation.repository.root !== project.localPath ||
      validation.repository.commonDir !== project.gitCommonDir
    ) {
      throw new ExecutionError(
        'repository_changed',
        'The repository at the registered path is missing or is a different repository. It cannot be trusted.',
      );
    }
  }
  const updated = setProjectExecutionTrust(db, { projectId: project.id, trust: input, now: now() });
  if (updated === undefined) {
    throw projectNotFound();
  }
  return toProjectTrustView(updated);
};

/** Records an explicit start request for a Queued task. The worker claims and executes it. */
export const startTaskExecution = (
  db: Database,
  projectId: string,
  taskId: string,
  { now = Date.now, createId = randomUUID }: ExecutionServiceOptions = {},
): TaskExecutionView => {
  const id = requireProjectTaskId(db, projectId, taskId);
  requestTaskExecution(db, { id: createId(), taskId: id, now: now() });
  return getTaskExecution(db, projectId, taskId);
};

/** Persists a stop intent for the task's active run; the owning worker stops its process group. */
export const stopTaskExecution = (
  db: Database,
  projectId: string,
  taskId: string,
  { now = Date.now }: ExecutionServiceOptions = {},
): TaskExecutionView => {
  const id = requireProjectTaskId(db, projectId, taskId);
  requestRunStop(db, { taskId: id, now: now() });
  return getTaskExecution(db, projectId, taskId);
};

const parseJsonArray = (text: string | null): string[] => {
  if (text === null) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
};

type IntegrityFindingView = TaskRunView['gitIntegrity']['findings'][number];

const parseFindings = (
  text: string | null,
): { findings: IntegrityFindingView[]; total: number } => {
  if (text === null) return { findings: [], total: 0 };
  try {
    const value = JSON.parse(text) as { findings?: unknown; totalFindings?: unknown };
    const findings = Array.isArray(value.findings)
      ? value.findings.flatMap((entry: unknown): IntegrityFindingView[] => {
          if (entry === null || typeof entry !== 'object') return [];
          const { code, disposition, subject } = entry as Record<string, unknown>;
          return typeof code === 'string' && typeof subject === 'string'
            ? [
                {
                  code,
                  disposition: disposition === 'violation' ? 'violation' : 'inconclusive',
                  subject,
                },
              ]
            : [];
        })
      : [];
    return {
      findings,
      total: typeof value.totalFindings === 'number' ? value.totalFindings : findings.length,
    };
  } catch {
    return { findings: [], total: 0 };
  }
};

const activeStatuses: readonly TaskRunStatus[] = ['pending', 'starting', 'running', 'stopping'];

export const toRunView = (run: TaskRunRecord): TaskRunView => {
  const { findings, total } = parseFindings(run.gitIntegrityResultJson);
  return {
    id: run.id,
    attempt: run.attempt,
    status: run.status,
    active: activeStatuses.includes(run.status),
    agentRuntime: run.agentRuntime,
    requestedModelId: run.requestedModelId,
    effectiveModelId: run.effectiveModelId,
    securityMode: run.securityMode,
    disclosureVersion: run.disclosureVersion,
    cliVersion: run.cliVersion,
    processContainment: run.processContainment,
    acceptedRisks: parseJsonArray(run.acceptedRisksJson),
    safeguards: parseJsonArray(run.safeguardsJson),
    exitCode: run.exitCode,
    signal: run.signal,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    summary: run.summary,
    stopRequestedAt: run.stopRequestedAt,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    eventsDropped: run.eventsDropped,
    reviewEligible: isRunReviewEligible(run),
    gitIntegrity: {
      status: run.gitIntegrityStatus,
      checkedAt: run.gitIntegrityCheckedAt,
      totalFindings: total,
      findings,
    },
  };
};

/** Runs (newest first), the latest workspace, the latest start request and recent events. */
export const getTaskExecution = (
  db: Database,
  projectId: string,
  taskId: string,
  { eventLimit = 100 }: { eventLimit?: number } = {},
): TaskExecutionView => {
  const id = requireProjectTaskId(db, projectId, taskId);
  const runs = listTaskRuns(db, id);
  const [latest] = runs;
  const [workspace] = listTaskWorkspaces(db, id);
  const command = findLatestTaskCommand(db, id);
  return {
    runs: runs.map(toRunView),
    workspace:
      workspace === undefined
        ? null
        : {
            path: workspace.path,
            branch: workspace.branch,
            baseBranch: workspace.baseBranch,
            baseSha: workspace.baseSha,
            createdAt: workspace.createdAt,
          },
    lastCommand:
      command === undefined
        ? null
        : {
            status: command.status,
            resultCode: command.resultCode,
            resultMessage: command.resultMessage,
            createdAt: command.createdAt,
            processedAt: command.processedAt,
          },
    events:
      latest === undefined
        ? []
        : listRunEvents(db, latest.id, eventLimit).map((event) => ({
            sequence: event.sequence,
            kind: event.kind,
            payload: event.payloadJson,
            createdAt: event.createdAt,
          })),
  };
};
