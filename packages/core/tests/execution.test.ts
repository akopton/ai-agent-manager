import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateTrustedLocalConsent,
  isRunReviewEligible,
  redactSecrets,
  securityControls,
  trustedLocalDisclosure,
  type ProjectTrustState,
  type TrustedLocalConsent,
} from '../src/index.js';

const consent: TrustedLocalConsent = {
  enabled: true,
  disclosureVersion: trustedLocalDisclosure.version,
  acceptedAt: 1,
  acceptedRisks: [...securityControls],
};

const project: ProjectTrustState = {
  localPath: '/repos/app',
  gitCommonDir: '/repos/app/.git',
  executionTrust: 'trusted_local',
  trustedCommonDir: '/repos/app/.git',
  trustedAt: 2,
};

const code = (decision: ReturnType<typeof evaluateTrustedLocalConsent>) =>
  decision.ok ? 'ok' : decision.code;

test('the disclosure accepts every strict control as a risk; Strict is never selected', () => {
  assert.deepEqual([...trustedLocalDisclosure.acceptedRisks], [...securityControls]);
  assert.equal(code(evaluateTrustedLocalConsent(consent, project)), 'ok');
});

test('consent comes only from persisted operator state', () => {
  assert.equal(
    code(evaluateTrustedLocalConsent({ ...consent, enabled: false }, project)),
    'trusted_local_not_enabled',
  );
  assert.equal(
    code(evaluateTrustedLocalConsent({ ...consent, acceptedAt: null }, project)),
    'trusted_local_not_enabled',
  );
  assert.equal(
    code(evaluateTrustedLocalConsent({ ...consent, disclosureVersion: 'old-1' }, project)),
    'trusted_local_acceptance_stale',
  );
  assert.equal(
    code(evaluateTrustedLocalConsent({ ...consent, acceptedRisks: ['network_denied'] }, project)),
    'trusted_local_acceptance_stale',
  );
  assert.equal(
    code(evaluateTrustedLocalConsent(consent, { ...project, executionTrust: 'none' })),
    'project_not_trusted',
  );
  // Same path, replaced repository: trust was granted for another common Git directory.
  assert.equal(
    code(evaluateTrustedLocalConsent(consent, { ...project, gitCommonDir: '/repos/other/.git' })),
    'project_not_trusted',
  );
  assert.equal(
    code(evaluateTrustedLocalConsent(consent, { ...project, trustedAt: null })),
    'project_not_trusted',
  );
});

test('only a completed run with a clean integrity check is review-eligible', () => {
  assert.equal(isRunReviewEligible({ status: 'completed', gitIntegrityStatus: 'clean' }), true);
  for (const gitIntegrityStatus of ['violation', 'inconclusive', 'not_run'] as const) {
    assert.equal(isRunReviewEligible({ status: 'completed', gitIntegrityStatus }), false);
  }
  for (const status of ['failed', 'stopped', 'interrupted', 'running'] as const) {
    assert.equal(isRunReviewEligible({ status, gitIntegrityStatus: 'clean' }), false);
  }
});

test('common credential shapes are masked before persistence', () => {
  const text = [
    'key sk-abcdefghijklmnopqrstuvwxyz012345',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'API_KEY=supersecretvalue',
    'remote https://user:pass@example.com/repo.git',
  ].join('\n');
  const redacted = redactSecrets(text);
  for (const secret of [
    'sk-abcdef',
    'ghp_abcdef',
    'abcdefghijklmnopqrstuvwxyz\n',
    'supersecretvalue',
    'user:pass',
  ]) {
    assert.ok(!redacted.includes(secret), `${secret} leaked: ${redacted}`);
  }
  assert.match(redacted, /API_KEY=\*\*\*/);
  assert.match(redacted, /https:\/\/\*\*\*@example\.com/);
  assert.equal(redactSecrets('plain output'), 'plain output');
});
