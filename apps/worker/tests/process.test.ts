import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { shutdownSignals } from '@ai-agent-manager/core';
import { withTemporaryDirectory } from './helpers.js';

const workerDirectory = fileURLToPath(new URL('../', import.meta.url));
const startupTimeoutMs = 15_000;

type RunningWorker = { child: ChildProcess; output: () => string; exited: Promise<number | null> };

// Runs the worker entry point directly with Node (no tsx CLI wrapper) so signals reach it.
const spawnWorker = (databasePath: string): RunningWorker => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=@ai-agent-manager/source', 'src/main.ts'],
    {
      cwd: workerDirectory,
      env: { ...process.env, AI_AGENT_MANAGER_DATABASE_PATH: databasePath },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { child, output: () => output, exited };
};

const waitForOutput = async (worker: RunningWorker, text: string): Promise<void> => {
  const deadline = Date.now() + startupTimeoutMs;
  while (!worker.output().includes(text)) {
    if (worker.child.exitCode !== null) {
      throw new Error(`Worker exited before printing "${text}":\n${worker.output()}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for "${text}":\n${worker.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

for (const signal of shutdownSignals) {
  test(`worker process starts independently and exits cleanly on ${signal}`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const databasePath = join(directory, 'data', 'database.sqlite');
      const worker = spawnWorker(databasePath);
      try {
        await waitForOutput(worker, 'Worker started');
        assert.equal(existsSync(databasePath), true);
        assert.ok(worker.output().includes(`Database opened at ${databasePath}.`));

        worker.child.kill(signal);
        assert.equal(await worker.exited, 0);
        assert.equal(worker.child.signalCode, null);
        assert.ok(worker.output().includes(`Received ${signal}; shutting down gracefully.`));
        assert.ok(worker.output().includes('Database connection closed.'));
        assert.ok(worker.output().includes('Worker stopped.'));
      } finally {
        if (worker.child.exitCode === null && worker.child.signalCode === null) {
          worker.child.kill('SIGKILL');
          await worker.exited;
        }
      }
    });
  });
}
