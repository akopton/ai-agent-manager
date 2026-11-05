import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { trustedLocalDisclosure } from '@ai-agent-manager/core';
import { applyMigrations, createDatabase } from '@ai-agent-manager/database';
import { PUT as trustRoute } from '@/app/api/projects/[projectId]/execution-trust/route';
import { GET as executionRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/execution/route';
import { POST as queueRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/queue/route';
import { POST as startRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/start/route';
import { POST as stopRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/stop/route';
import { POST as createTaskRoute } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as registerRoute } from '@/app/api/projects/route';
import { GET as settingsGet, PUT as settingsPut } from '@/app/api/settings/trusted-local/route';
import {
  executionSettingsResponseSchema,
  projectTrustResponseSchema,
  taskExecutionResponseSchema,
} from '@/lib/execution/contracts';
import { apiErrorResponseSchema, projectResponseSchema } from '@/lib/projects/contracts';
import { closeDatabase } from '@/lib/server/database';
import { taskResponseSchema } from '@/lib/tasks/contracts';
import {
  createFixtureDirectory,
  createRepository,
  git,
  removeFixtureDirectory,
  snapshot,
} from './fixtures';

const origin = 'http://127.0.0.1:3000';
const databaseVariable = 'AI_AGENT_MANAGER_DATABASE_PATH';

let directory = '';
let previousDatabasePath: string | undefined;

before(() => {
  directory = createFixtureDirectory();
  previousDatabasePath = process.env[databaseVariable];
  process.env[databaseVariable] = join(directory, 'data', 'database.sqlite');
  const connection = createDatabase({ path: process.env[databaseVariable] });
  try {
    applyMigrations(connection);
  } finally {
    connection.close();
  }
});

after(() => {
  closeDatabase();
  if (previousDatabasePath === undefined) {
    delete process.env[databaseVariable];
  } else {
    process.env[databaseVariable] = previousDatabasePath;
  }
  removeFixtureDirectory(directory);
});

const send = (
  method: 'POST' | 'PUT',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`${origin}${path}`, {
    method,
    headers: {
      host: '127.0.0.1:3000',
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = (path: string): Request =>
  new Request(`${origin}${path}`, { headers: { host: '127.0.0.1:3000' } });

const projectParams = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
const taskParams = (projectId: string, taskId: string) => ({
  params: Promise.resolve({ projectId, taskId }),
});

const errorCode = async (response: Response): Promise<string> =>
  apiErrorResponseSchema.parse(await response.json()).error.code;

const setUpQueuedTask = async (name: string) => {
  const root = createRepository(join(directory, name));
  const registered = await registerRoute(
    send('POST', '/api/projects', {
      path: root,
      name,
      defaultBaseBranch: 'main',
      remoteName: null,
    }),
  );
  assert.equal(registered.status, 201);
  const { project } = projectResponseSchema.parse(await registered.json());
  const created = await createTaskRoute(
    send('POST', `/api/projects/${project.id}/tasks`, {
      title: 'Run me',
      prompt: 'Do the thing.',
      agentRuntime: 'codex',
    }),
    projectParams(project.id),
  );
  const { task } = taskResponseSchema.parse(await created.json());
  await queueRoute(
    send('POST', `/api/projects/${project.id}/tasks/${task.id}/queue`),
    taskParams(project.id, task.id),
  );
  return { project, task, root };
};

test('start is refused without Trusted Local consent and project trust; nothing runs in the web process', async () => {
  const { project, task, root } = await setUpQueuedTask('consent repo');
  const before = snapshot(root);
  const path = `/api/projects/${project.id}/tasks/${task.id}/start`;

  const noConsent = await startRoute(send('POST', path), taskParams(project.id, task.id));
  assert.equal(noConsent.status, 409);
  assert.equal(await errorCode(noConsent), 'trusted_local_not_enabled');

  // A stale or partial acceptance is refused; nothing is enabled.
  const stale = await settingsPut(
    send('PUT', '/api/settings/trusted-local', {
      enabled: true,
      disclosureVersion: 'older-1',
      acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
    }),
  );
  assert.equal(await errorCode(stale), 'trusted_local_acceptance_stale');
  const partial = await settingsPut(
    send('PUT', '/api/settings/trusted-local', {
      enabled: true,
      disclosureVersion: trustedLocalDisclosure.version,
      acceptedRisks: ['network_denied'],
    }),
  );
  assert.equal(await errorCode(partial), 'invalid_execution_input');

  const accepted = await settingsPut(
    send('PUT', '/api/settings/trusted-local', {
      enabled: true,
      disclosureVersion: trustedLocalDisclosure.version,
      acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
    }),
  );
  assert.equal(accepted.status, 200);
  const settings = executionSettingsResponseSchema.parse(
    await (await settingsGet(get('/api/settings/trusted-local'))).json(),
  ).settings;
  assert.equal(settings.trustedLocal.current, true);

  const untrusted = await startRoute(send('POST', path), taskParams(project.id, task.id));
  assert.equal(await errorCode(untrusted), 'project_not_trusted');

  // Trust must name the registered repository identity.
  const wrongIdentity = await trustRoute(
    send('PUT', `/api/projects/${project.id}/execution-trust`, {
      trust: 'trusted_local',
      localPath: project.localPath,
      gitCommonDir: '/somewhere/else/.git',
    }),
    projectParams(project.id),
  );
  assert.equal(await errorCode(wrongIdentity), 'repository_changed');
  const trusted = await trustRoute(
    send('PUT', `/api/projects/${project.id}/execution-trust`, {
      trust: 'trusted_local',
      localPath: project.localPath,
      gitCommonDir: project.gitCommonDir,
    }),
    projectParams(project.id),
  );
  assert.equal(projectTrustResponseSchema.parse(await trusted.json()).trust.current, true);

  const started = await startRoute(send('POST', path), taskParams(project.id, task.id));
  assert.equal(started.status, 202);
  const { execution } = taskExecutionResponseSchema.parse(await started.json());
  assert.equal(execution.lastCommand?.status, 'pending');
  assert.equal(execution.runs.length, 0, 'the web process only records the request');

  const duplicate = await startRoute(send('POST', path), taskParams(project.id, task.id));
  assert.equal(await errorCode(duplicate), 'execution_already_requested');

  // No run is active, so there is nothing to stop.
  const stop = await stopRoute(
    send('POST', `/api/projects/${project.id}/tasks/${task.id}/stop`),
    taskParams(project.id, task.id),
  );
  assert.equal(await errorCode(stop), 'run_not_active');

  const view = await executionRoute(
    get(`/api/projects/${project.id}/tasks/${task.id}/execution`),
    taskParams(project.id, task.id),
  );
  assert.equal(
    taskExecutionResponseSchema.parse(await view.json()).execution.lastCommand?.status,
    'pending',
  );

  assert.deepEqual(snapshot(root), before, 'the web process never touches the repository');
  assert.equal(git(root, 'worktree', 'list').trim().split('\n').length, 1);

  // Disabling clears consent for everyone.
  await settingsPut(send('PUT', '/api/settings/trusted-local', { enabled: false }));
  const after = executionSettingsResponseSchema.parse(
    await (await settingsGet(get('/api/settings/trusted-local'))).json(),
  ).settings;
  assert.equal(after.trustedLocal.enabled, false);
});

test('execution routes reject cross-site requests and tasks of other projects', async () => {
  const first = await setUpQueuedTask('route repo a');
  const second = await setUpQueuedTask('route repo b');
  const crossSite = await startRoute(
    send('POST', `/api/projects/${first.project.id}/tasks/${first.task.id}/start`, undefined, {
      origin: 'https://evil.example',
    }),
    taskParams(first.project.id, first.task.id),
  );
  assert.equal(crossSite.status, 403);
  const settings = await settingsPut(
    send(
      'PUT',
      '/api/settings/trusted-local',
      { enabled: false },
      { origin: 'https://evil.example' },
    ),
  );
  assert.equal(settings.status, 403);
  const otherProject = await startRoute(
    send('POST', `/api/projects/${first.project.id}/tasks/${second.task.id}/start`),
    taskParams(first.project.id, second.task.id),
  );
  assert.equal(otherProject.status, 404);
  assert.equal(await errorCode(otherProject), 'task_not_found');
});
