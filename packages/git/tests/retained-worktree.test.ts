import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { isProcessGroupAlive } from '../src/index.js';

// The process-group probe used before a recovered attempt (TM-01). It only sends signal 0.

test('invalid process IDs never address other groups and read as possibly alive', () => {
  for (const pid of [0, 1, -5, 1.5, Number.NaN]) {
    assert.equal(isProcessGroupAlive(pid), true, String(pid));
  }
});

test('a live detached process group is reported; an ended one is not', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  assert.ok(child.pid !== undefined);
  try {
    assert.equal(isProcessGroupAlive(child.pid), true);
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
  assert.equal(isProcessGroupAlive(child.pid), false);
});
