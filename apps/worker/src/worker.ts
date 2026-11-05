import type { WorkerState } from '@ai-agent-manager/core';
import {
  createDatabase,
  resolveRuntimePaths,
  type DatabaseConnection,
  type RuntimePaths,
} from '@ai-agent-manager/database';
import {
  createExecutionService,
  type ExecutionService,
  type ExecutionServiceOptions,
} from './execution/execution-service.js';
import type { Logger } from './logger.js';

/** Execution settings; the database, logger and worktree root come from the worker. */
export type WorkerExecutionOptions = Omit<
  ExecutionServiceOptions,
  'db' | 'logger' | 'worktreeRoot'
> & {
  /** @internal Tests only; defaults to the resolved runtime worktree root. */
  worktreeRoot?: string;
};

/** Tables the execution service needs. Migrations are applied explicitly, never on startup. */
const executionTables = [
  'projects',
  'tasks',
  'security_settings',
  'workspaces',
  'task_runs',
  'run_events',
  'worker_commands',
  'worker_leases',
] as const;

const databaseMigrateCommand = 'pnpm --filter @ai-agent-manager/database db:migrate';

export type WorkerOptions = {
  logger: Logger;
  /** Resolves and validates runtime paths before any side effect. Defaults to the environment. */
  resolvePaths?: () => RuntimePaths;
  /** Opens the configured SQLite database. Defaults to the shared database package factory. */
  openDatabase?: (paths: RuntimePaths) => DatabaseConnection;
  /**
   * Enables the operator-initiated execution service (start requests, Stop, restart
   * reconciliation). Off unless given; there is no automatic queue processing either way.
   */
  execution?: WorkerExecutionOptions;
};

const openConfiguredDatabase = (paths: RuntimePaths): DatabaseConnection =>
  createDatabase({ path: paths.databasePath });

export type Worker = {
  readonly state: WorkerState;
  readonly connection: DatabaseConnection | undefined;
  readonly paths: RuntimePaths | undefined;
  readonly execution: ExecutionService | undefined;
  /** Opens the database. Synchronous; execution starts separately with `startExecution`. */
  start: () => void;
  /**
   * Starts the execution service when it is configured and the schema is migrated. Throws when
   * another worker holds the execution lease.
   */
  startExecution: () => Promise<void>;
  /** Stops active runs (recorded as interrupted), releases the lease and closes the database. */
  stop: () => Promise<void>;
};

export const createWorker = ({
  logger,
  resolvePaths = resolveRuntimePaths,
  openDatabase = openConfiguredDatabase,
  execution: executionOptions,
}: WorkerOptions): Worker => {
  let state: WorkerState = 'idle';
  let connection: DatabaseConnection | undefined;
  let paths: RuntimePaths | undefined;
  let execution: ExecutionService | undefined;

  const start = (): void => {
    if (state !== 'idle') {
      throw new Error(`The worker cannot start from the "${state}" state.`);
    }
    state = 'starting';
    logger.info('Starting worker.');
    try {
      paths = resolvePaths();
      logger.info(`Data root: ${paths.dataRoot}`);
      logger.info(`Worktree root: ${paths.worktreeRoot} (created on demand)`);
      connection = openDatabase(paths);
    } catch (error) {
      state = 'stopped';
      throw error;
    }
    logger.info(`Database opened at ${connection.path}.`);
    state = 'running';
    logger.info(`Worker started (pid ${process.pid}).`);
  };

  const startExecution = async (): Promise<void> => {
    if (executionOptions === undefined || state !== 'running' || connection === undefined) {
      return;
    }
    const statement = connection.sqlite.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    );
    const missing = executionTables.filter((name) => statement.get(name) === undefined);
    if (missing.length > 0) {
      logger.error(
        `Task execution is disabled: the database schema is not up to date. Run \`${databaseMigrateCommand}\` with the same AI_AGENT_MANAGER_* settings, then restart the worker.`,
      );
      return;
    }
    const service = createExecutionService({
      ...executionOptions,
      db: connection.db,
      logger,
      worktreeRoot: executionOptions.worktreeRoot ?? paths?.worktreeRoot ?? '',
    });
    await service.start();
    execution = service;
    logger.info(
      'Task execution is available for explicit operator start requests (Trusted Local Mode only; no automatic queue processing).',
    );
  };

  const stop = async (): Promise<void> => {
    if (state === 'stopping' || state === 'stopped') {
      return;
    }
    state = 'stopping';
    logger.info('Stopping worker.');
    try {
      if (execution !== undefined) {
        await execution.stop();
        logger.info('Execution service stopped.');
      }
    } catch (error) {
      logger.error('Stopping the execution service failed.', error);
    } finally {
      execution = undefined;
    }
    try {
      if (connection !== undefined) {
        connection.close();
        logger.info('Database connection closed.');
      }
    } finally {
      connection = undefined;
      state = 'stopped';
    }
    logger.info('Worker stopped.');
  };

  return {
    get state() {
      return state;
    },
    get connection() {
      return connection;
    },
    get paths() {
      return paths;
    },
    get execution() {
      return execution;
    },
    start,
    startExecution,
    stop,
  };
};
