import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  previewProjectRequestSchema,
  projectIdSchema,
  projectInstructionsSchema,
  projectNameSchema,
  projectPrioritySchema,
  registerProjectRequestSchema,
  repositoryPathInputSchema,
  updateProjectRequestSchema,
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

test('validates project priority and instructions', () => {
  for (const value of [-100, 0, 7, 100]) {
    assert.equal(projectPrioritySchema.parse(value), value);
  }
  for (const value of [-101, 101, 1.5, '1', null, Number.NaN]) {
    assert.equal(projectPrioritySchema.safeParse(value).success, false, String(value));
  }
  assert.equal(projectInstructionsSchema.parse('  Use pnpm.\n'), 'Use pnpm.');
  assert.equal(projectInstructionsSchema.parse(''), '');
  assert.equal(projectInstructionsSchema.safeParse('x'.repeat(10_001)).success, false);
});

test('accepts partial project updates and rejects identity fields or empty updates', () => {
  assert.deepEqual(updateProjectRequestSchema.parse({ name: '  Renamed ' }), { name: 'Renamed' });
  assert.deepEqual(
    updateProjectRequestSchema.parse({
      priority: -5,
      instructions: 'Run tests.',
      defaultBaseBranch: 'develop',
      remoteName: null,
    }),
    { priority: -5, instructions: 'Run tests.', defaultBaseBranch: 'develop', remoteName: null },
  );
  for (const value of [
    {},
    { name: '' },
    { defaultBaseBranch: ' ' },
    { remoteName: '' },
    { localPath: '/elsewhere' },
    { gitCommonDir: '/elsewhere/.git' },
    { id: '6f1c0f3e-6a1e-4a7c-9a55-2f1f1d7c9b10' },
    { name: 'Ok', path: '/elsewhere' },
  ]) {
    assert.equal(updateProjectRequestSchema.safeParse(value).success, false, JSON.stringify(value));
  }
});
