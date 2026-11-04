import type { WorkerState } from '@ai-agent-manager/core';
import {
  createDatabase,
  resolveRuntimePaths,
  type DatabaseConnection,
  type RuntimePaths,
} from '@ai-agent-manager/database';
import type { Logger } from './logger.js';

export type WorkerOptions = {
  logger: Logger;
  /** Resolves and validates runtime paths before any side effect. Defaults to the environment. */
  resolvePaths?: () => RuntimePaths;
  /** Opens the configured SQLite database. Defaults to the shared database package factory. */
  openDatabase?: (paths: RuntimePaths) => DatabaseConnection;
};

const openConfiguredDatabase = (paths: RuntimePaths): DatabaseConnection =>
  createDatabase({ path: paths.databasePath });

export type Worker = {
  readonly state: WorkerState;
  readonly connection: DatabaseConnection | undefined;
  readonly paths: RuntimePaths | undefined;
  start: () => void;
  stop: () => void;
};

export const createWorker = ({
  logger,
  resolvePaths = resolveRuntimePaths,
  openDatabase = openConfiguredDatabase,
}: WorkerOptions): Worker => {
  let state: WorkerState = 'idle';
  let connection: DatabaseConnection | undefined;
  let paths: RuntimePaths | undefined;

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

  const stop = (): void => {
    if (state === 'stopping' || state === 'stopped') {
      return;
    }
    state = 'stopping';
    logger.info('Stopping worker.');
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
    start,
    stop,
  };
};
