import { randomUUID } from 'node:crypto';
import { defaultRunTimeoutMs } from '@ai-agent-manager/core';
import {
  acquireWorkerLease,
  claimStartCommand,
  expirePendingCommands,
  finishTaskRun,
  listActiveTaskRuns,
  listPendingCommands,
  listStopRequestedRuns,
  recordGitIntegrity,
  releaseWorkerLease,
  renewWorkerLease,
  type DatabaseConnection,
} from '@ai-agent-manager/database';
import { gitIntegritySnapshotSchema, verifyGitIntegrity } from '@ai-agent-manager/git';
import { createRunExecutor, verifyAfterRun, type RunExecutorOptions } from './run-executor.js';

// The worker side of the first execution slice: it holds the single-worker lease, reconciles runs
// left active by a previous worker, and polls for **operator commands only** (explicit start
// requests and persisted stop intents). It never picks Queued tasks on its own: there is no
// scheduler and no automatic queue processing in this slice.

type Database = DatabaseConnection['db'];

export type ExecutionServiceOptions = Omit<RunExecutorOptions, 'workerInstanceId' | 'db'> & {
  db: Database;
  /** Interval for command and stop polling. */
  pollIntervalMs?: number;
  /** Start requests older than this are rejected instead of executed. */
  commandMaxAgeMs?: number;
  leaseTtlMs?: number;
  /** Mandatory run timeout (Trusted Local requires one). */
  runTimeoutMs?: number;
  workerInstanceId?: string;
};

export type ExecutionService = {
  readonly workerInstanceId: string;
  /** Acquires the lease and reconciles. Throws when another worker holds a live lease. */
  start: () => Promise<void>;
  /** Stops polling, stops active runs (recorded as interrupted) and releases the lease. */
  stop: () => Promise<void>;
  /** One polling pass; exposed for tests. */
  tick: () => Promise<void>;
  readonly activeRunCount: number;
};

export class WorkerLeaseUnavailableError extends Error {
  override name = 'WorkerLeaseUnavailableError';
}

export const createExecutionService = (options: ExecutionServiceOptions): ExecutionService => {
  const { db, logger } = options;
  const now = options.now ?? Date.now;
  const workerInstanceId = options.workerInstanceId ?? randomUUID();
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const commandMaxAgeMs = options.commandMaxAgeMs ?? 5 * 60 * 1000;
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const runTimeoutMs = options.runTimeoutMs ?? defaultRunTimeoutMs;
  const verify = options.verifyIntegrity ?? verifyGitIntegrity;
  const executor = createRunExecutor({ ...options, workerInstanceId });
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  let accepting = false;
  let lastLeaseRenewal = 0;

  /**
   * Runs that are still active but belong to another worker instance were interrupted by a crash
   * or restart. They are never resumed or retried. Their process groups are not signalled (the
   * PID may have been reused); the post-run integrity check is attempted from the stored baseline.
   */
  const reconcile = async (): Promise<void> => {
    for (const run of listActiveTaskRuns(db)) {
      if (run.workerInstanceId === workerInstanceId) continue;
      let baseline = null;
      if (run.gitIntegrityBaselineJson !== null) {
        try {
          const parsed = gitIntegritySnapshotSchema.safeParse(
            JSON.parse(run.gitIntegrityBaselineJson) as unknown,
          );
          baseline = parsed.success ? parsed.data : null;
        } catch {
          baseline = null;
        }
      }
      const integrity =
        run.gitIntegrityBaselineJson !== null && baseline === null
          ? {
              status: 'inconclusive' as const,
              resultJson: JSON.stringify({ status: 'inconclusive', error: 'baseline_unreadable' }),
            }
          : await verifyAfterRun(baseline, verify);
      if (integrity.status !== 'not_run') {
        recordGitIntegrity(db, run.id, { ...integrity, checkedAt: now() });
      }
      try {
        finishTaskRun(db, run.id, {
          status: 'interrupted',
          taskAction: 'interrupt',
          errorCode: 'worker_restarted',
          errorMessage: `The worker stopped while this run was ${run.status}. It is not resumed or retried automatically.${
            run.pid === null
              ? ''
              : ` The agent's process group (pid ${run.pid}) was not signalled after the restart and may still be running; check it manually.`
          }`,
          endedAt: now(),
        });
        logger.info(
          `Run ${run.id} was left ${run.status} by a previous worker; marked interrupted.`,
        );
      } catch (error) {
        logger.error(`Run ${run.id} could not be reconciled; it stays active.`, error);
      }
    }
  };

  const processCommands = (): void => {
    expirePendingCommands(db, { olderThan: now() - commandMaxAgeMs, now: now() });
    for (const command of listPendingCommands(db)) {
      if (!accepting) return;
      const result = claimStartCommand(db, {
        commandId: command.id,
        runId: randomUUID(),
        workerInstanceId,
        timeoutMs: runTimeoutMs,
        now: now(),
      });
      if (!result.claimed) {
        logger.info(`Start request ${command.id} rejected: ${result.code}.`);
        continue;
      }
      logger.info(`Start request ${command.id} claimed as run ${result.claim.run.id}.`);
      void executor.execute(result.claim);
    }
  };

  const tick = async (): Promise<void> => {
    if (ticking || !accepting) return;
    ticking = true;
    try {
      if (now() - lastLeaseRenewal >= leaseTtlMs / 3) {
        if (!renewWorkerLease(db, { ownerId: workerInstanceId, now: now(), ttlMs: leaseTtlMs })) {
          logger.error('The worker lease was lost; no new runs are accepted.');
          accepting = false;
          return;
        }
        lastLeaseRenewal = now();
      }
      for (const run of listStopRequestedRuns(db, workerInstanceId)) {
        executor.requestStop(run.id, 'operator');
      }
      processCommands();
    } catch (error) {
      logger.error('Execution polling failed.', error);
    } finally {
      ticking = false;
    }
  };

  const start = async (): Promise<void> => {
    const lease = acquireWorkerLease(db, {
      ownerId: workerInstanceId,
      pid: process.pid,
      now: now(),
      ttlMs: leaseTtlMs,
    });
    if (!lease.acquired) {
      throw new WorkerLeaseUnavailableError(
        `Another worker (pid ${lease.holder.pid}) holds the execution lease until ${new Date(lease.holder.expiresAt).toISOString()}.`,
      );
    }
    lastLeaseRenewal = now();
    await reconcile();
    accepting = true;
    timer = setInterval(() => void tick(), pollIntervalMs);
    timer.unref();
  };

  const stop = async (): Promise<void> => {
    accepting = false;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    await executor.stopAll('shutdown');
    releaseWorkerLease(db, workerInstanceId);
  };

  return {
    workerInstanceId,
    start,
    stop,
    tick,
    get activeRunCount() {
      return executor.activeCount;
    },
  };
};
