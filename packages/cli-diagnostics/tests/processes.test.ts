import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  inspectTrackedProcess,
  isProcessAlive,
  terminateTrackedProcess,
} from '../src/processes.js';

const nonce = (): string => randomBytes(16).toString('hex');

test('never signals a live process whose command line lacks the nonce', async () => {
  const self = { pid: process.pid, nonce: nonce(), kind: 'unrelated' };
  assert.equal(await inspectTrackedProcess(self), 'pid_reused');
  assert.equal(await terminateTrackedProcess(self), 'not_running');
  assert.equal(isProcessAlive(process.pid), true);
});

test('terminates exactly the tagged process and reports a gone PID as not running', async () => {
  const tag = nonce();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', `aam-test-${tag}`], {
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  assert.ok(child.pid !== undefined);
  const tracked = { pid: child.pid, nonce: tag, kind: 'test' };
  // `ps` may briefly show the pre-exec command line right after spawn.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await inspectTrackedProcess(tracked)) === 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await inspectTrackedProcess(tracked), 'running');
  assert.equal(await terminateTrackedProcess(tracked), 'terminated');
  await exited;
  assert.equal(await inspectTrackedProcess(tracked), 'gone');
  assert.equal(await terminateTrackedProcess(tracked), 'not_running');
});

test('a short nonce cannot authorize a kill', async () => {
  const self = { pid: process.pid, nonce: 'node', kind: 'unrelated' };
  assert.equal(await inspectTrackedProcess(self), 'unverifiable');
  assert.equal(await terminateTrackedProcess(self), 'unverifiable');
  assert.equal(isProcessAlive(process.pid), true);
});
