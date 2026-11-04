import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { shutdownSignals, workerStateSchema } from '@ai-agent-manager/core';
import {
  createDatabase,
  resolveRuntimePaths,
  type DatabaseConnection,
} from '@ai-agent-manager/database';
import { runWorker, type SignalSource } from '../src/run-worker.js';
import { createWorker } from '../src/worker.js';
import { createRecordingLogger, withTemporaryDirectory } from './helpers.js';

test('imports shared contracts from the core package', () => {
  assert.deepEqual(shutdownSignals, ['SIGINT', 'SIGTERM']);
  assert.equal(workerStateSchema.parse('running'), 'running');
});

test('opens the configured database on start and closes it on stop', async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, 'database.sqlite');
    const logger = createRecordingLogger();
    const worker = createWorker({ logger, openDatabase: () => createDatabase({ path }) });
    assert.equal(worker.state, 'idle');

    worker.start();
    assert.equal(worker.state, 'running');
    assert.equal(existsSync(path), true);
    const connection = worker.connection;
    assert.ok(connection);
    assert.equal(connection.path, path);
    assert.equal(connection.sqlite.open, true);
    assert.throws(() => worker.start(), /cannot start/);

    worker.stop();
    assert.equal(worker.state, 'stopped');
    assert.equal(connection.sqlite.open, false);
    assert.equal(worker.connection, undefined);
    worker.stop();
    assert.ok(logger.messages.includes('Database connection closed.'));
  });
});

test('uses AI_AGENT_MANAGER_DATABASE_PATH through the database package by default', async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, 'env', 'database.sqlite');
    const previous = process.env.AI_AGENT_MANAGER_DATABASE_PATH;
    process.env.AI_AGENT_MANAGER_DATABASE_PATH = path;
    try {
      const worker = createWorker({ logger: createRecordingLogger() });
      worker.start();
      assert.equal(worker.connection?.path, path);
      worker.stop();
      assert.equal(existsSync(path), true);
    } finally {
      if (previous === undefined) {
        delete process.env.AI_AGENT_MANAGER_DATABASE_PATH;
      } else {
        process.env.AI_AGENT_MANAGER_DATABASE_PATH = previous;
      }
    }
  });
});

test('derives the database from AI_AGENT_MANAGER_DATA_ROOT and defers the worktree root', async () => {
  await withTemporaryDirectory((directory) => {
    const dataRoot = join(directory, 'Application Support', 'agent manager');
    const worker = createWorker({
      logger: createRecordingLogger(),
      resolvePaths: () =>
        resolveRuntimePaths({ environment: { AI_AGENT_MANAGER_DATA_ROOT: dataRoot } }),
    });
    worker.start();
    try {
      assert.equal(worker.paths?.dataRoot, dataRoot);
      assert.equal(worker.connection?.path, join(dataRoot, 'database.sqlite'));
      assert.equal(existsSync(join(dataRoot, 'database.sqlite')), true);
      assert.equal(existsSync(join(dataRoot, 'worktrees')), false);
    } finally {
      worker.stop();
    }
  });
});

test('rejects invalid runtime configuration before opening the database', async () => {
  let opened = false;
  const exit = await runWorker({
    logger: createRecordingLogger(),
    signals: new EventEmitter(),
    resolvePaths: () =>
      resolveRuntimePaths({ environment: { AI_AGENT_MANAGER_WORKTREE_ROOT: 'relative' } }),
    openDatabase: () => {
      opened = true;
      throw new Error('Unexpected database access');
    },
  });
  assert.deepEqual(exit, { exitCode: 1 });
  assert.equal(opened, false);
});

for (const signal of shutdownSignals) {
  test(`shuts down gracefully on ${signal} and removes its signal handlers`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const signals = new EventEmitter();
      const logger = createRecordingLogger();
      let connection: DatabaseConnection | undefined;

      const exit = await runWorker({
        logger,
        signals: signals satisfies SignalSource,
        openDatabase: () => {
          connection = createDatabase({ path: join(directory, 'database.sqlite') });
          return connection;
        },
        onStarted: (worker) => {
          assert.equal(worker.state, 'running');
          for (const name of shutdownSignals) {
            assert.equal(signals.listenerCount(name), 1);
          }
          signals.emit(signal);
          signals.emit(signal);
        },
      });

      assert.deepEqual(exit, { exitCode: 0, signal });
      assert.equal(connection?.sqlite.open, false);
      for (const name of shutdownSignals) {
        assert.equal(signals.listenerCount(name), 0);
      }
      assert.ok(logger.messages.includes(`Received ${signal}; shutting down gracefully.`));
      assert.ok(logger.messages.includes('Database connection closed.'));
    });
  });
}

test('reports a startup failure without installing signal handlers', async () => {
  const signals = new EventEmitter();
  const logger = createRecordingLogger();
  const exit = await runWorker({
    logger,
    signals,
    openDatabase: () => {
      throw new Error('Cannot open database');
    },
  });
  assert.deepEqual(exit, { exitCode: 1 });
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.ok(logger.messages.includes('ERROR Worker failed to start.'));
});
