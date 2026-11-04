import { shutdownSignals, type ShutdownSignal } from '@ai-agent-manager/core';
import { createConsoleLogger, type Logger } from './logger.js';
import { createWorker, type Worker, type WorkerOptions } from './worker.js';

export type SignalSource = {
  on: (signal: ShutdownSignal, listener: () => void) => unknown;
  off: (signal: ShutdownSignal, listener: () => void) => unknown;
};

export type RunWorkerOptions = {
  logger?: Logger;
  openDatabase?: WorkerOptions['openDatabase'];
  signals?: SignalSource;
  /** Called after the worker has started and shutdown handlers are installed. */
  onStarted?: (worker: Worker) => void;
};

export type WorkerExit = { exitCode: number; signal?: ShutdownSignal };

// The worker has no recurring jobs yet; a single idle timer keeps the event loop alive until a
// shutdown signal arrives. It performs no work.
const keepAliveIntervalMs = 2 ** 31 - 1;

/**
 * Starts the worker, waits for SIGINT or SIGTERM, and resolves once shutdown has completed.
 */
export const runWorker = ({
  logger = createConsoleLogger(),
  openDatabase,
  signals = process,
  onStarted,
}: RunWorkerOptions = {}): Promise<WorkerExit> => {
  const worker = createWorker({ logger, openDatabase });

  try {
    worker.start();
  } catch (error) {
    logger.error('Worker failed to start.', error);
    return Promise.resolve({ exitCode: 1 });
  }

  return new Promise<WorkerExit>((resolve) => {
    const keepAlive = setInterval(() => {}, keepAliveIntervalMs);
    const listeners = new Map<ShutdownSignal, () => void>();

    const shutdown = (signal: ShutdownSignal): void => {
      if (worker.state !== 'running') {
        logger.info(`Received ${signal}; shutdown is already in progress.`);
        return;
      }
      logger.info(`Received ${signal}; shutting down gracefully.`);
      let exitCode = 0;
      try {
        worker.stop();
      } catch (error) {
        exitCode = 1;
        logger.error('Worker shutdown failed.', error);
      } finally {
        clearInterval(keepAlive);
        for (const [name, listener] of listeners) {
          signals.off(name, listener);
        }
        listeners.clear();
      }
      resolve({ exitCode, signal });
    };

    for (const signal of shutdownSignals) {
      const listener = (): void => shutdown(signal);
      listeners.set(signal, listener);
      signals.on(signal, listener);
    }

    onStarted?.(worker);
  });
};
