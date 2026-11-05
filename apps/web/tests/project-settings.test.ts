import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  disconnectedProjectsUrl,
  readDisconnectedName,
  savedProjectUrl,
  wasProjectSaved,
} from '@/lib/projects/feedback';
import { buildProjectUpdate, noRemote, settingsValuesFromProject } from '@/lib/projects/settings';

const project = {
  name: 'Website',
  priority: 0,
  instructions: 'Use pnpm.',
  defaultBaseBranch: 'main',
  remoteName: 'origin',
};

test('starts the settings form from the stored project', () => {
  assert.deepEqual(settingsValuesFromProject(project), {
    name: 'Website',
    priority: '0',
    instructions: 'Use pnpm.',
    defaultBaseBranch: 'main',
    remoteName: 'origin',
  });
  assert.equal(settingsValuesFromProject({ ...project, remoteName: null }).remoteName, noRemote);
});

test('sends only changed settings and nothing when the form is unchanged', () => {
  const values = settingsValuesFromProject(project);
  assert.deepEqual(buildProjectUpdate(project, values), { ok: true, update: null });
  // Whitespace-only edits normalize to the stored values.
  assert.deepEqual(
    buildProjectUpdate(project, { ...values, name: ' Website ', instructions: 'Use pnpm.\n' }),
    { ok: true, update: null },
  );
  assert.deepEqual(
    buildProjectUpdate(project, {
      ...values,
      name: 'Site',
      priority: ' -5 ',
      remoteName: noRemote,
    }),
    { ok: true, update: { name: 'Site', priority: -5, remoteName: null } },
  );
  assert.deepEqual(
    buildProjectUpdate(
      { ...project, remoteName: null },
      { ...values, remoteName: 'upstream', defaultBaseBranch: 'develop', instructions: '' },
    ),
    {
      ok: true,
      update: { remoteName: 'upstream', defaultBaseBranch: 'develop', instructions: '' },
    },
  );
});

test('reports invalid settings per field', () => {
  const values = settingsValuesFromProject(project);
  for (const priority of ['', '1.5', 'abc', '101', '-101', '1e2']) {
    const result = buildProjectUpdate(project, { ...values, priority });
    assert.equal(result.ok, false, priority);
    assert.ok(!result.ok && result.fields.priority !== undefined);
  }
  const result = buildProjectUpdate(project, {
    ...values,
    name: '  ',
    instructions: 'x'.repeat(10_001),
    defaultBaseBranch: '',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && Object.keys(result.fields).sort(), [
    'defaultBaseBranch',
    'instructions',
    'name',
  ]);
});

test('builds and reads one-time success messages from the URL', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(savedProjectUrl(id), `/projects/${id}?saved=1`);
  assert.equal(wasProjectSaved({ saved: '1' }), true);
  for (const saved of [undefined, '0', ['1']]) {
    assert.equal(wasProjectSaved({ saved }), false);
  }

  const url = new URL(disconnectedProjectsUrl('My & “Site”'), 'http://127.0.0.1:3000');
  assert.equal(url.pathname, '/projects');
  assert.equal(
    readDisconnectedName({ disconnected: url.searchParams.get('disconnected') ?? '' }),
    'My & “Site”',
  );
  for (const disconnected of [undefined, '', '  ', ['a', 'b'], 'x'.repeat(101)]) {
    assert.equal(readDisconnectedName({ disconnected }), undefined);
  }
});
