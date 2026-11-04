import type { WorkerState } from '@ai-agent-manager/core';
import { createDatabase, type DatabaseConnection } from '@ai-agent-manager/database';
import type { Logger } from './logger.js';

export type WorkerOptions = {
  logger: Logger;
  /** Opens the configured SQLite database. Defaults to the shared database package factory. */
  openDatabase?: () => DatabaseConnection;
};

export type Worker = {
  readonly state: WorkerState;
  readonly connection: DatabaseConnection | undefined;
  start: () => void;
  stop: () => void;
};

export const createWorker = ({ logger, openDatabase = createDatabase }: WorkerOptions): Worker => {
  let state: WorkerState = 'idle';
  let connection: DatabaseConnection | undefined;

  const start = (): void => {
    if (state !== 'idle') {
      throw new Error(`The worker cannot start from the "${state}" state.`);
    }
    state = 'starting';
    logger.info('Starting worker.');
    try {
      connection = openDatabase();
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
    start,
    stop,
  };
};
