import {
  acceptTrustedLocalInputSchema,
  activeTaskRunStatuses,
  evaluateTrustedLocalConsent,
  ExecutionError,
  projectIdSchema,
  securityControlSchema,
  taskIdSchema,
  trustedLocalDisclosure,
  truncateText,
  type AcceptTrustedLocalInput,
  type ExecutionErrorCode,
  type GitIntegrityResultStatus,
  type ProjectTrustState,
  type SecurityControl,
  type TaskAction,
  type TaskRunStatus,
  type TrustedLocalConsent,
} from '@ai-agent-manager/core';
import { and, asc, desc, eq, inArray, isNotNull, lt, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseConnection } from './client.js';
import {
  projects,
  runEvents,
  securitySettings,
  taskRuns,
  tasks,
  workerCommands,
  workerLeases,
  workspaces,
} from './schema.js';
import { transitionTask, type TaskRecord } from './tasks.js';

// Durable records of the first worker execution slice: operator consent, project trust, start
// commands, task runs, workspaces, bounded run events and the single-worker lease. Every
// multi-row change runs in one IMMEDIATE transaction so a status that is checked is the status
// that is changed, across the web and worker processes.

type Database = DatabaseConnection['db'];

export type TaskRunRecord = typeof taskRuns.$inferSelect;
export type WorkspaceRecord = typeof workspaces.$inferSelect;
export type RunEventRecord = typeof runEvents.$inferSelect;
export type WorkerCommandRecord = typeof workerCommands.$inferSelect;
export type WorkerLeaseRecord = typeof workerLeases.$inferSelect;
export type ProjectRecordWithTrust = typeof projects.$inferSelect;

const immediate = { behavior: 'immediate' } as const;

const activeStatuses: TaskRunStatus[] = [...activeTaskRunStatuses];

const riskListSchema = z.array(securityControlSchema);

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// Operator consent (SEC-02 settings)

/** The persisted Trusted Local consent; defaults to disabled when no settings row exists. */
export const getTrustedLocalConsent = (db: Database): TrustedLocalConsent => {
  const row = db.select().from(securitySettings).where(eq(securitySettings.id, 1)).get();
  if (row === undefined || !row.trustedLocalEnabled) {
    return { enabled: false, disclosureVersion: null, acceptedAt: null, acceptedRisks: [] };
  }
  const risks = riskListSchema.safeParse(parseJson(row.trustedLocalAcceptedRisksJson));
  return {
    enabled: true,
    disclosureVersion: row.trustedLocalDisclosureVersion,
    acceptedAt: row.trustedLocalAcceptedAt,
    // A corrupt risk list never widens consent: it reads as nothing accepted.
    acceptedRisks: risks.success ? risks.data : [],
  };
};

/**
 * Records the operator's explicit acceptance of the **current** disclosure and enables Trusted
 * Local Mode. The input must name the current disclosure version and every risk it lists.
 */
export const acceptTrustedLocal = (
  db: Database,
  { input, now }: { input: AcceptTrustedLocalInput; now: number },
): TrustedLocalConsent => {
  const parsed = acceptTrustedLocalInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ExecutionError('invalid_execution_input', 'The acceptance is invalid.');
  }
  if (parsed.data.disclosureVersion !== trustedLocalDisclosure.version) {
    throw new ExecutionError(
      'trusted_local_acceptance_stale',
      'The disclosure changed. Reload the page and read the current disclosure.',
    );
  }
  const accepted = new Set<SecurityControl>(parsed.data.acceptedRisks);
  const missing = trustedLocalDisclosure.acceptedRisks.filter((risk) => !accepted.has(risk));
  if (missing.length > 0 || accepted.size !== trustedLocalDisclosure.acceptedRisks.length) {
    throw new ExecutionError(
      'invalid_execution_input',
      'Every risk listed in the disclosure must be accepted explicitly.',
      { missing },
    );
  }
  const values = {
    trustedLocalEnabled: true,
    trustedLocalDisclosureVersion: trustedLocalDisclosure.version,
    trustedLocalAcceptedAt: now,
    trustedLocalAcceptedRisksJson: JSON.stringify([...trustedLocalDisclosure.acceptedRisks]),
    updatedAt: now,
  };
  db.insert(securitySettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: securitySettings.id, set: values })
    .run();
  return getTrustedLocalConsent(db);
};

/** Disables Trusted Local Mode and clears the acceptance; re-enabling needs a new acceptance. */
export const disableTrustedLocal = (
  db: Database,
  { now }: { now: number },
): TrustedLocalConsent => {
  const values = {
    trustedLocalEnabled: false,
    trustedLocalDisclosureVersion: null,
    trustedLocalAcceptedAt: null,
    trustedLocalAcceptedRisksJson: null,
    updatedAt: now,
  };
  db.insert(securitySettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: securitySettings.id, set: values })
    .run();
  return getTrustedLocalConsent(db);
};

// ---------------------------------------------------------------------------------------------
// Project trust

export const toProjectTrustState = (project: ProjectRecordWithTrust): ProjectTrustState => ({
  localPath: project.localPath,
  gitCommonDir: project.gitCommonDir,
  executionTrust: project.executionTrust,
  trustedCommonDir: project.executionTrustedCommonDir,
  trustedAt: project.executionTrustedAt,
});

/**
 * Grants or revokes Trusted Local execution for a project. Granting requires the caller to pass
 * the repository identity it verified against the live repository; it must equal the registered
 * identity. Returns `undefined` for an unknown project.
 */
export const setProjectExecutionTrust = (
  db: Database,
  {
    projectId,
    trust,
    now,
  }: {
    projectId: string;
    trust: { trust: 'none' } | { trust: 'trusted_local'; localPath: string; gitCommonDir: string };
    now: number;
  },
): ProjectRecordWithTrust | undefined => {
  const id = projectIdSchema.safeParse(projectId);
  if (!id.success) {
    return undefined;
  }
  return db.transaction((tx) => {
    const project = tx.select().from(projects).where(eq(projects.id, id.data)).get();
    if (project === undefined) {
      return undefined;
    }
    if (trust.trust === 'none') {
      return tx
        .update(projects)
        .set({
          executionTrust: 'none',
          executionTrustedCommonDir: null,
          executionTrustedAt: null,
          updatedAt: now,
        })
        .where(eq(projects.id, project.id))
        .returning()
        .get();
    }
    if (trust.localPath !== project.localPath || trust.gitCommonDir !== project.gitCommonDir) {
      throw new ExecutionError(
        'repository_changed',
        'The repository identity differs from the registered project. Reload the page.',
      );
    }
    return tx
      .update(projects)
      .set({
        executionTrust: 'trusted_local',
        executionTrustedCommonDir: project.gitCommonDir,
        executionTrustedAt: now,
        updatedAt: now,
      })
      .where(eq(projects.id, project.id))
      .returning()
      .get();
  }, immediate);
};

// ---------------------------------------------------------------------------------------------
// Start commands

const findTask = (db: Database, id: string): TaskRecord | undefined =>
  db.select().from(tasks).where(eq(tasks.id, id)).get();

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';

/**
 * Records the operator's explicit request to execute one `Queued` task. Nothing runs here: the
 * worker claims the command, re-checks consent, trust and capacity, and only then starts. The
 * consent and trust checks here are early feedback; the worker's claim is authoritative.
 */
export const requestTaskExecution = (
  db: Database,
  { id, taskId, now }: { id: string; taskId: string; now: number },
): WorkerCommandRecord => {
  const parsedTask = taskIdSchema.safeParse(taskId);
  if (!parsedTask.success) {
    throw new ExecutionError('task_not_found', 'The task does not exist.');
  }
  try {
    return db.transaction((tx) => {
      const task = findTask(tx, parsedTask.data);
      if (task === undefined) {
        throw new ExecutionError('task_not_found', 'The task does not exist.');
      }
      if (task.status !== 'queued') {
        throw new ExecutionError('task_not_queued', 'Only a Queued task can be started.', {
          status: task.status,
        });
      }
      const project = tx.select().from(projects).where(eq(projects.id, task.projectId)).get();
      if (project === undefined) {
        throw new ExecutionError('project_not_found', 'The project does not exist.');
      }
      const consent = evaluateTrustedLocalConsent(
        getTrustedLocalConsent(tx),
        toProjectTrustState(project),
      );
      if (!consent.ok) {
        throw new ExecutionError(consent.code, consent.message);
      }
      return tx
        .insert(workerCommands)
        .values({ id, kind: 'start_task', taskId: task.id, status: 'pending', createdAt: now })
        .returning()
        .get();
    }, immediate);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ExecutionError(
        'execution_already_requested',
        'A start request for this task is already waiting for the worker.',
      );
    }
    throw error;
  }
};

/** Pending commands, oldest first. */
export const listPendingCommands = (db: Database, limit = 10): WorkerCommandRecord[] =>
  db
    .select()
    .from(workerCommands)
    .where(eq(workerCommands.status, 'pending'))
    .orderBy(asc(workerCommands.createdAt), asc(workerCommands.id))
    .limit(limit)
    .all();

/** The most recent command for a task, if any. */
export const findLatestTaskCommand = (
  db: Database,
  taskId: string,
): WorkerCommandRecord | undefined =>
  db
    .select()
    .from(workerCommands)
    .where(eq(workerCommands.taskId, taskId))
    .orderBy(desc(workerCommands.createdAt), desc(workerCommands.id))
    .limit(1)
    .get();

const rejectCommand = (
  db: Database,
  commandId: string,
  code: ExecutionErrorCode,
  message: string,
  now: number,
): void => {
  db.update(workerCommands)
    .set({ status: 'rejected', resultCode: code, resultMessage: message, processedAt: now })
    .where(and(eq(workerCommands.id, commandId), eq(workerCommands.status, 'pending')))
    .run();
};

/**
 * Rejects pending commands created before `olderThan`. A start request that waited for a stopped
 * worker is never executed silently when the worker comes back.
 */
export const expirePendingCommands = (
  db: Database,
  { olderThan, now }: { olderThan: number; now: number },
): number =>
  db
    .update(workerCommands)
    .set({
      status: 'rejected',
      resultCode: 'command_expired',
      resultMessage: 'The worker did not pick up this start request in time. Start it again.',
      processedAt: now,
    })
    .where(and(eq(workerCommands.status, 'pending'), lt(workerCommands.createdAt, olderThan)))
    .run().changes;

export type ClaimedRun = {
  run: TaskRunRecord;
  task: TaskRecord;
  project: ProjectRecordWithTrust;
  consent: TrustedLocalConsent;
};

export type ClaimResult =
  | { claimed: true; claim: ClaimedRun }
  | { claimed: false; code: ExecutionErrorCode; message: string };

/**
 * Atomically claims a pending start command (ARCHITECTURE §6): verifies the task is still
 * `Queued`, the persisted consent and project trust allow Trusted Local execution, no run of this
 * task is active and the runtime has a free slot; then creates the next attempt in `starting`,
 * transitions the task with the named `start` action and marks the command accepted. On any
 * refusal the command is rejected and nothing else changes.
 */
export const claimStartCommand = (
  db: Database,
  {
    commandId,
    runId,
    workerInstanceId,
    timeoutMs,
    now,
  }: { commandId: string; runId: string; workerInstanceId: string; timeoutMs: number; now: number },
): ClaimResult =>
  db.transaction((tx) => {
    const command = tx.select().from(workerCommands).where(eq(workerCommands.id, commandId)).get();
    if (command === undefined || command.status !== 'pending') {
      return { claimed: false, code: 'task_not_queued', message: 'The command is not pending.' };
    }
    const refuse = (code: ExecutionErrorCode, message: string): ClaimResult => {
      rejectCommand(tx, commandId, code, message, now);
      return { claimed: false, code, message };
    };
    const task = findTask(tx, command.taskId);
    if (task === undefined) {
      return refuse('task_not_found', 'The task does not exist.');
    }
    if (task.status !== 'queued') {
      return refuse('task_not_queued', 'The task is no longer Queued.');
    }
    const project = tx.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (project === undefined) {
      return refuse('project_not_found', 'The project does not exist.');
    }
    const consent = getTrustedLocalConsent(tx);
    const decision = evaluateTrustedLocalConsent(consent, toProjectTrustState(project));
    if (!decision.ok) {
      return refuse(decision.code, decision.message);
    }
    const activeForTask = tx
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(and(eq(taskRuns.taskId, task.id), inArray(taskRuns.status, activeStatuses)))
      .get();
    if (activeForTask !== undefined) {
      return refuse('task_run_active', 'This task already has an active run.');
    }
    const activeForRuntime = tx
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(
        and(eq(taskRuns.agentRuntime, task.agentRuntime), inArray(taskRuns.status, activeStatuses)),
      )
      .get();
    if (activeForRuntime !== undefined) {
      return refuse(
        'runtime_busy',
        `Another ${task.agentRuntime === 'claude' ? 'Claude Code' : 'Codex'} run is active. Only one run per agent runtime is allowed.`,
      );
    }
    const previous = tx
      .select({ attempt: max(taskRuns.attempt) })
      .from(taskRuns)
      .where(eq(taskRuns.taskId, task.id))
      .get();
    const run = tx
      .insert(taskRuns)
      .values({
        id: runId,
        taskId: task.id,
        attempt: (previous?.attempt ?? 0) + 1,
        agentRuntime: task.agentRuntime,
        requestedModelId: task.modelId,
        status: 'starting',
        securityMode: 'trusted_local',
        disclosureVersion: consent.disclosureVersion,
        acceptedRisksJson: JSON.stringify(consent.acceptedRisks),
        timeoutMs,
        workerInstanceId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const started = transitionTask(tx, { id: task.id, action: 'start', now });
    tx.update(workerCommands)
      .set({ status: 'accepted', runId: run.id, processedAt: now })
      .where(eq(workerCommands.id, commandId))
      .run();
    return { claimed: true, claim: { run, task: started, project, consent } };
  }, immediate);

// ---------------------------------------------------------------------------------------------
// Runs and workspaces

export const findTaskRun = (db: Database, runId: string): TaskRunRecord | undefined =>
  db.select().from(taskRuns).where(eq(taskRuns.id, runId)).get();

/** All runs of a task, newest attempt first. */
export const listTaskRuns = (db: Database, taskId: string): TaskRunRecord[] =>
  db
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.taskId, taskId))
    .orderBy(desc(taskRuns.attempt))
    .all();

/** Runs that hold capacity (pending, starting, running, stopping). */
export const listActiveTaskRuns = (db: Database): TaskRunRecord[] =>
  db.select().from(taskRuns).where(inArray(taskRuns.status, activeStatuses)).all();

/** Active runs of this worker instance whose stop was requested. */
export const listStopRequestedRuns = (db: Database, workerInstanceId: string): TaskRunRecord[] =>
  db
    .select()
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.workerInstanceId, workerInstanceId),
        inArray(taskRuns.status, activeStatuses),
        isNotNull(taskRuns.stopRequestedAt),
      ),
    )
    .all();

/** Run fields the worker may update while a run is active. Status changes use named helpers. */
export type TaskRunProgress = Partial<
  Pick<
    TaskRunRecord,
    | 'workspaceId'
    | 'launchProfileId'
    | 'cliVersion'
    | 'authorizationId'
    | 'controlAssessmentJson'
    | 'acceptedRisksJson'
    | 'safeguardsJson'
    | 'processContainment'
    | 'pid'
    | 'sessionId'
    | 'effectiveModelId'
    | 'gitIntegrityBaselineJson'
    | 'startedAt'
  >
> & { status?: 'running' | 'stopping' };

export const updateTaskRunProgress = (
  db: Database,
  runId: string,
  changes: TaskRunProgress,
  now: number,
): TaskRunRecord | undefined =>
  db
    .update(taskRuns)
    .set({ ...changes, updatedAt: now })
    .where(and(eq(taskRuns.id, runId), inArray(taskRuns.status, activeStatuses)))
    .returning()
    .get();

export type NewWorkspace = Omit<typeof workspaces.$inferInsert, 'status' | 'updatedAt'>;

/** Records a created task worktree and links it to the run, in one transaction. */
export const recordRunWorkspace = (
  db: Database,
  { runId, workspace }: { runId: string; workspace: NewWorkspace },
): WorkspaceRecord =>
  db.transaction((tx) => {
    const record = tx
      .insert(workspaces)
      .values({ ...workspace, status: 'retained', updatedAt: workspace.createdAt })
      .returning()
      .get();
    tx.update(taskRuns)
      .set({ workspaceId: record.id, updatedAt: workspace.createdAt })
      .where(eq(taskRuns.id, runId))
      .run();
    return record;
  }, immediate);

export const findWorkspace = (db: Database, id: string): WorkspaceRecord | undefined =>
  db.select().from(workspaces).where(eq(workspaces.id, id)).get();

/** Workspaces of a task, newest generation first. */
export const listTaskWorkspaces = (db: Database, taskId: string): WorkspaceRecord[] =>
  db
    .select()
    .from(workspaces)
    .where(eq(workspaces.taskId, taskId))
    .orderBy(desc(workspaces.generation))
    .all();

/**
 * Persists a stop intent for the task's active run (ARCHITECTURE §7.3: persist first, then
 * signal). The worker that owns the run reads it and stops the process group.
 */
export const requestRunStop = (
  db: Database,
  { taskId, now }: { taskId: string; now: number },
): TaskRunRecord =>
  db.transaction((tx) => {
    const run = tx
      .select()
      .from(taskRuns)
      .where(and(eq(taskRuns.taskId, taskId), inArray(taskRuns.status, activeStatuses)))
      .get();
    if (run === undefined) {
      throw new ExecutionError('run_not_active', 'This task has no active run to stop.');
    }
    if (run.stopRequestedAt !== null) {
      return run;
    }
    return tx
      .update(taskRuns)
      .set({ stopRequestedAt: now, updatedAt: now })
      .where(eq(taskRuns.id, run.id))
      .returning()
      .get();
  }, immediate);

export type GitIntegrityRecord = {
  status: GitIntegrityResultStatus;
  /** Bounded, value-free comparison summary (JSON). */
  resultJson: string | null;
  checkedAt: number;
};

/** Stores the post-run Git integrity result. Allowed for active and finished runs. */
export const recordGitIntegrity = (
  db: Database,
  runId: string,
  integrity: GitIntegrityRecord,
): void => {
  db.update(taskRuns)
    .set({
      gitIntegrityStatus: integrity.status,
      gitIntegrityResultJson: integrity.resultJson,
      gitIntegrityCheckedAt: integrity.checkedAt,
      updatedAt: integrity.checkedAt,
    })
    .where(eq(taskRuns.id, runId))
    .run();
};

export type RunFinish = {
  status: Extract<TaskRunStatus, 'completed' | 'stopped' | 'failed' | 'interrupted'>;
  /** The named task transition; `undefined` leaves the task unchanged. */
  taskAction: Extract<TaskAction, 'complete_execution' | 'stop' | 'fail' | 'interrupt'>;
  exitCode?: number | null;
  signal?: string | null;
  lingeringProcesses?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  summary?: string | null;
  sessionId?: string | null;
  effectiveModelId?: string | null;
  endedAt: number;
};

/**
 * Ends an active run and applies the matching named task transition in one transaction. A run
 * that is no longer active is left unchanged (returns `undefined`), so a run is finished once.
 */
export const finishTaskRun = (
  db: Database,
  runId: string,
  finish: RunFinish,
): { run: TaskRunRecord; task: TaskRecord } | undefined =>
  db.transaction((tx) => {
    const run = tx
      .update(taskRuns)
      .set({
        status: finish.status,
        exitCode: finish.exitCode ?? null,
        signal: finish.signal ?? null,
        lingeringProcesses: finish.lingeringProcesses ?? null,
        errorCode: finish.errorCode ?? null,
        errorMessage:
          finish.errorMessage === undefined || finish.errorMessage === null
            ? null
            : truncateText(finish.errorMessage, 2_000),
        summary:
          finish.summary === undefined || finish.summary === null
            ? null
            : truncateText(finish.summary, 4_000),
        ...(finish.sessionId === undefined ? {} : { sessionId: finish.sessionId }),
        ...(finish.effectiveModelId === undefined
          ? {}
          : { effectiveModelId: finish.effectiveModelId }),
        endedAt: finish.endedAt,
        updatedAt: finish.endedAt,
      })
      .where(and(eq(taskRuns.id, runId), inArray(taskRuns.status, activeStatuses)))
      .returning()
      .get();
    if (run === undefined) {
      return undefined;
    }
    const task = transitionTask(tx, {
      id: run.taskId,
      action: finish.taskAction,
      now: finish.endedAt,
    });
    return { run, task };
  }, immediate);

// ---------------------------------------------------------------------------------------------
// Run events

/** Per-run limits for persisted events; events beyond them are counted in `events_dropped`. */
export const runEventLimits = Object.freeze({ maxEvents: 2_000, maxPayloadBytes: 8 * 1024 });

/**
 * Appends one normalized event. The caller must already have redacted and bounded the payload;
 * an oversized payload is replaced by a marker. Returns `false` when the event was dropped.
 */
export const appendRunEvent = (
  db: Database,
  event: { runId: string; sequence: number; kind: string; payload: unknown; createdAt: number },
): boolean => {
  if (event.sequence > runEventLimits.maxEvents) {
    db.update(taskRuns)
      .set({ eventsDropped: sql`${taskRuns.eventsDropped} + 1` })
      .where(eq(taskRuns.id, event.runId))
      .run();
    return false;
  }
  let payloadJson = JSON.stringify(event.payload ?? {});
  if (Buffer.byteLength(payloadJson) > runEventLimits.maxPayloadBytes) {
    payloadJson = JSON.stringify({ omitted: 'payload_too_large' });
  }
  db.insert(runEvents)
    .values({
      runId: event.runId,
      sequence: event.sequence,
      kind: truncateText(event.kind, 64),
      payloadJson,
      createdAt: event.createdAt,
    })
    .onConflictDoNothing()
    .run();
  return true;
};

/** The last `limit` events of a run, in sequence order. */
export const listRunEvents = (db: Database, runId: string, limit = 200): RunEventRecord[] =>
  db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(desc(runEvents.sequence))
    .limit(limit)
    .all()
    .reverse();

/** The next free event sequence of a run (after a restart, events continue after the last). */
export const nextRunEventSequence = (db: Database, runId: string): number =>
  (db
    .select({ last: max(runEvents.sequence) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .get()?.last ?? 0) + 1;

// ---------------------------------------------------------------------------------------------
// Single-worker lease

export type LeaseResult =
  { acquired: true; lease: WorkerLeaseRecord } | { acquired: false; holder: WorkerLeaseRecord };

/** Acquires the worker lease when it is free or expired. Never takes over a live lease. */
export const acquireWorkerLease = (
  db: Database,
  { ownerId, pid, now, ttlMs }: { ownerId: string; pid: number; now: number; ttlMs: number },
): LeaseResult =>
  db.transaction((tx) => {
    const current = tx.select().from(workerLeases).where(eq(workerLeases.id, 1)).get();
    if (current !== undefined && current.ownerId !== ownerId && current.expiresAt > now) {
      return { acquired: false, holder: current };
    }
    const values = { ownerId, pid, acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs };
    const lease = tx
      .insert(workerLeases)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: workerLeases.id, set: values })
      .returning()
      .get();
    return { acquired: true, lease };
  }, immediate);

/** Extends the lease. Returns `false` when another owner holds it (the caller must stop work). */
export const renewWorkerLease = (
  db: Database,
  { ownerId, now, ttlMs }: { ownerId: string; now: number; ttlMs: number },
): boolean =>
  db
    .update(workerLeases)
    .set({ heartbeatAt: now, expiresAt: now + ttlMs })
    .where(and(eq(workerLeases.id, 1), eq(workerLeases.ownerId, ownerId)))
    .run().changes === 1;

/** Releases the lease if this owner holds it. */
export const releaseWorkerLease = (db: Database, ownerId: string): void => {
  db.delete(workerLeases)
    .where(and(eq(workerLeases.id, 1), eq(workerLeases.ownerId, ownerId)))
    .run();
};
