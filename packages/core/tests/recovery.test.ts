import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessPriorProcess,
  discardTaskInputSchema,
  recoverTaskInputSchema,
  recoveryKindForStatus,
  resolveTaskTransition,
  taskDiscardSourceStatuses,
  taskRecoveryKinds,
  taskRecoverySourceStatuses,
  taskStatuses,
} from '../src/index.js';

test('TM-01 recovery eligibility: Retry from Failed, Resume from Stopped and Interrupted', () => {
  assert.deepEqual(
    Object.fromEntries(taskStatuses.map((status) => [status, recoveryKindForStatus(status)])),
    {
      backlog: null,
      queued: null,
      in_progress: null,
      review: null,
      done: null,
      stopped: 'resume',
      interrupted: 'resume',
      failed: 'retry',
      discarded: null,
    },
  );
  // Never wider than the domain's named transitions, and both lead to Queued.
  for (const kind of taskRecoveryKinds) {
    for (const status of taskRecoverySourceStatuses[kind]) {
      assert.equal(resolveTaskTransition(kind, status), 'queued', `${kind} from ${status}`);
    }
  }
  assert.deepEqual([...taskDiscardSourceStatuses], ['review', 'stopped', 'interrupted', 'failed']);
  for (const status of taskDiscardSourceStatuses) {
    assert.equal(resolveTaskTransition('discard', status), 'discarded');
  }
});

test('the prior process is ruled out only when no launch can have happened', () => {
  const base = { status: 'failed', pid: null, authorizationId: null, errorCode: null } as const;
  assert.equal(assessPriorProcess(base), 'not_launched');
  assert.equal(assessPriorProcess({ ...base, pid: 123 }), 'process_group');
  // Authorized and finished by its own worker: the worker knows nothing was launched.
  assert.equal(assessPriorProcess({ ...base, authorizationId: 'a' }), 'not_launched');
  assert.equal(
    assessPriorProcess({
      ...base,
      status: 'interrupted',
      authorizationId: 'a',
      errorCode: 'worker_restarted',
    }),
    'unknown',
  );
});

test('recovery and discard inputs are strict', () => {
  const runId = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(recoverTaskInputSchema.parse({ runId }), { runId, processStopConfirmed: false });
  assert.equal(recoverTaskInputSchema.safeParse({ runId, kind: 'retry' }).success, false);
  assert.equal(discardTaskInputSchema.safeParse({ runId }).success, false);
  assert.equal(discardTaskInputSchema.safeParse({ runId, confirmed: false }).success, false);
  assert.equal(discardTaskInputSchema.safeParse({ runId, confirmed: true }).success, true);
});
