import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  previewProjectRequestSchema,
  projectIdSchema,
  projectNameSchema,
  registerProjectRequestSchema,
  repositoryPathInputSchema,
} from '../src/index.js';

test('trims repository path input and rejects empty, oversized, and null-byte paths', () => {
  assert.equal(
    repositoryPathInputSchema.parse('  /Users/me/repos/my project  '),
    '/Users/me/repos/my project',
  );
  for (const value of ['', '   ', 'x'.repeat(4097), '/repo\0/x', 42, null, undefined]) {
    assert.equal(repositoryPathInputSchema.safeParse(value).success, false);
  }
});

test('validates project names and identifiers', () => {
  assert.equal(projectNameSchema.parse('  Website  '), 'Website');
  for (const value of ['', '  ', 'x'.repeat(101)]) {
    assert.equal(projectNameSchema.safeParse(value).success, false);
  }
  assert.equal(projectIdSchema.safeParse('6f1c0f3e-6a1e-4a7c-9a55-2f1f1d7c9b10').success, true);
  for (const value of ['', 'project-1', '../etc', '6f1c0f3e6a1e4a7c9a552f1f1d7c9b10']) {
    assert.equal(projectIdSchema.safeParse(value).success, false);
  }
});

test('requires a complete registration request and rejects unknown fields', () => {
  const request = {
    path: '/repo',
    name: 'Repo',
    defaultBaseBranch: 'main',
    remoteName: null,
  };
  assert.deepEqual(registerProjectRequestSchema.parse(request), request);
  assert.equal(
    registerProjectRequestSchema.parse({ ...request, remoteName: ' origin ' }).remoteName,
    'origin',
  );
  for (const invalid of [
    { ...request, defaultBaseBranch: '' },
    { ...request, remoteName: '' },
    { ...request, name: '' },
    { path: '/repo', name: 'Repo', defaultBaseBranch: 'main' },
    { ...request, localPath: '/other' },
  ]) {
    assert.equal(registerProjectRequestSchema.safeParse(invalid).success, false);
  }
  assert.equal(
    previewProjectRequestSchema.safeParse({ path: '/repo', extra: true }).success,
    false,
  );
});
