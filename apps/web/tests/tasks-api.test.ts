import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Task } from '@ai-agent-manager/core';
import { applyMigrations, createDatabase } from '@ai-agent-manager/database';
import { DELETE as disconnectRoute } from '@/app/api/projects/[projectId]/route';
import { POST as queueRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/queue/route';
import { POST as returnRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/return-to-backlog/route';
import {
  GET as getTaskRoute,
  PATCH as updateRoute,
} from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import { GET as listRoute, POST as createRoute } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as registerRoute } from '@/app/api/projects/route';
import { apiErrorResponseSchema, projectResponseSchema } from '@/lib/projects/contracts';
import { closeDatabase } from '@/lib/server/database';
import { taskListResponseSchema, taskResponseSchema } from '@/lib/tasks/contracts';
import {
  createFixtureDirectory,
  createRepository,
  git,
  removeFixtureDirectory,
  snapshot,
} from './fixtures';

const origin = 'http://127.0.0.1:3000';
const databaseVariable = 'AI_AGENT_MANAGER_DATABASE_PATH';
const unknownId = '00000000-0000-4000-8000-00000000ffff';

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

const defaultHeaders = { host: '127.0.0.1:3000', origin };

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${origin}${path}`, { headers: { host: '127.0.0.1:3000', ...headers } });

const send = (
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`${origin}${path}`, {
    method,
    headers: {
      ...defaultHeaders,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

const projectParams = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

const taskParams = (projectId: string, taskId: string) => ({
  params: Promise.resolve({ projectId, taskId }),
});

const errorOf = async (response: Response) =>
  apiErrorResponseSchema.parse(await response.json()).error;

const registerProject = async (name: string) => {
  const root = createRepository(join(directory, name));
  git(root, 'branch', 'develop');
  const response = await registerRoute(
    send('POST', '/api/projects', {
      path: root,
      name,
      defaultBaseBranch: 'main',
      remoteName: null,
    }),
  );
  assert.equal(response.status, 201);
  return { root, project: projectResponseSchema.parse(await response.json()).project };
};

const createTask = async (projectId: string, body: Record<string, unknown> = {}): Promise<Task> => {
  const response = await createRoute(
    send('POST', `/api/projects/${projectId}/tasks`, {
      title: 'Add login',
      prompt: 'Implement the login form.',
      agentRuntime: 'claude',
      ...body,
    }),
    projectParams(projectId),
  );
  assert.equal(response.status, 201);
  return taskResponseSchema.parse(await response.json()).task;
};

const listTasks = async (projectId: string): Promise<Task[]> => {
  const response = await listRoute(
    get(`/api/projects/${projectId}/tasks`),
    projectParams(projectId),
  );
  assert.equal(response.status, 200);
  return taskListResponseSchema.parse(await response.json()).tasks;
};

const taskPath = (projectId: string, taskId: string) =>
  `/api/projects/${projectId}/tasks/${taskId}`;

test('creates tasks in Backlog with domain defaults and lists them per project', async () => {
  const { root, project } = await registerProject('create');
  const before = snapshot(root);
  assert.deepEqual(await listTasks(project.id), []);

  const task = await createTask(project.id, { title: '  Add login  ' });
  assert.equal(task.projectId, project.id);
  assert.equal(task.title, 'Add login');
  assert.equal(task.status, 'backlog');
  assert.equal(task.modelId, null);
  assert.equal(task.baseBranch, null);
  assert.equal(task.priority, 'normal');
  assert.equal(task.urgent, false);
  assert.equal(task.queuedAt, null);

  const explicit = await createTask(project.id, {
    agentRuntime: 'codex',
    modelId: 'gpt-5.1-codex',
    baseBranch: 'develop',
    priority: 'critical',
    urgent: true,
  });
  assert.equal(explicit.agentRuntime, 'codex');
  assert.equal(explicit.modelId, 'gpt-5.1-codex');
  assert.equal(explicit.baseBranch, 'develop');
  assert.equal(explicit.priority, 'critical');
  assert.equal(explicit.urgent, true);
  assert.equal(explicit.status, 'backlog');

  assert.deepEqual(
    (await listTasks(project.id)).map(({ id }) => id).sort(),
    [task.id, explicit.id].sort(),
  );
  const response = await getTaskRoute(
    get(taskPath(project.id, task.id)),
    taskParams(project.id, task.id),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(taskResponseSchema.parse(await response.json()).task, task);

  assert.deepEqual(snapshot(root), before, 'Creating tasks must not change the repository');
});

test('rejects invalid task input at the API boundary without writing anything', async () => {
  const { project } = await registerProject('invalid');
  const path = `/api/projects/${project.id}/tasks`;
  const valid = { title: 'T', prompt: 'P', agentRuntime: 'claude' };
  for (const body of [
    {},
    { ...valid, title: '   ' },
    { ...valid, prompt: '' },
    { ...valid, prompt: 'x'.repeat(50_001) },
    { ...valid, title: 'x'.repeat(201) },
    { ...valid, agentRuntime: 'gemini' },
    { ...valid, modelId: '' },
    { ...valid, priority: 'urgent' },
    { ...valid, urgent: 'yes' },
    { ...valid, baseBranch: '' },
    { ...valid, status: 'queued' },
    { ...valid, projectId: unknownId },
    { ...valid, queuedAt: 1 },
  ]) {
    const response = await createRoute(send('POST', path, body), projectParams(project.id));
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    const error = await errorOf(response);
    assert.equal(error.code, 'invalid_request');
    assert.ok(error.details !== undefined && 'fields' in error.details);
  }

  const missingBranch = await createRoute(
    send('POST', path, { ...valid, baseBranch: 'does-not-exist' }),
    projectParams(project.id),
  );
  assert.equal(missingBranch.status, 422);
  assert.equal((await errorOf(missingBranch)).code, 'base_branch_not_found');

  const form = await createRoute(
    send('POST', path, 'title=x', { 'content-type': 'application/x-www-form-urlencoded' }),
    projectParams(project.id),
  );
  assert.equal(form.status, 415);
  const malformed = await createRoute(send('POST', path, '{'), projectParams(project.id));
  assert.equal(malformed.status, 400);

  assert.deepEqual(await listTasks(project.id), []);
});

test('guards every task route with the Host and Origin checks', async () => {
  const { project } = await registerProject('guards');
  const task = await createTask(project.id);
  const path = taskPath(project.id, task.id);

  const foreignHost = await listRoute(
    get(`/api/projects/${project.id}/tasks`, { host: 'evil.example:3000' }),
    projectParams(project.id),
  );
  assert.equal(foreignHost.status, 403);
  assert.equal((await errorOf(foreignHost)).code, 'forbidden_host');
  const foreignHostTask = await getTaskRoute(
    get(path, { host: 'evil.example' }),
    taskParams(project.id, task.id),
  );
  assert.equal(foreignHostTask.status, 403);

  const rejectedHeaders: Record<string, string>[] = [
    { host: 'evil.example:3000' },
    { origin: 'http://evil.example' },
    { origin: '' },
  ];
  for (const headers of rejectedHeaders) {
    const responses = [
      await createRoute(
        send('POST', `/api/projects/${project.id}/tasks`, { title: 'x' }, headers),
        projectParams(project.id),
      ),
      await updateRoute(
        send('PATCH', path, { title: 'Hacked' }, headers),
        taskParams(project.id, task.id),
      ),
      await queueRoute(
        send('POST', `${path}/queue`, undefined, headers),
        taskParams(project.id, task.id),
      ),
      await returnRoute(
        send('POST', `${path}/return-to-backlog`, undefined, headers),
        taskParams(project.id, task.id),
      ),
    ];
    for (const response of responses) {
      assert.equal(response.status, 403);
      assert.match((await errorOf(response)).code, /^forbidden_(host|origin)$/);
    }
  }

  const [unchanged] = await listTasks(project.id);
  assert.deepEqual(unchanged, task);
});

test('scopes task lookups and mutations to the project in the URL', async () => {
  const { project: first } = await registerProject('scope-a');
  const { project: second } = await registerProject('scope-b');
  const task = await createTask(first.id);

  // The task exists, but not in the second project: it is reported as missing there.
  const wrongProject = taskParams(second.id, task.id);
  const wrongPath = taskPath(second.id, task.id);
  for (const response of [
    await getTaskRoute(get(wrongPath), wrongProject),
    await updateRoute(send('PATCH', wrongPath, { title: 'Moved' }), wrongProject),
    await queueRoute(send('POST', `${wrongPath}/queue`), wrongProject),
    await returnRoute(send('POST', `${wrongPath}/return-to-backlog`), wrongProject),
  ]) {
    assert.equal(response.status, 404);
    assert.equal((await errorOf(response)).code, 'task_not_found');
  }
  assert.deepEqual(await listTasks(second.id), []);

  // Unknown and malformed project or task IDs.
  for (const [projectId, taskId, code] of [
    [unknownId, task.id, 'project_not_found'],
    ['not-a-uuid', task.id, 'project_not_found'],
    [first.id, unknownId, 'task_not_found'],
    [first.id, 'not-a-uuid', 'task_not_found'],
  ] as const) {
    const response = await getTaskRoute(
      get(taskPath(projectId, taskId)),
      taskParams(projectId, taskId),
    );
    assert.equal(response.status, 404);
    assert.equal((await errorOf(response)).code, code);
    const queued = await queueRoute(
      send('POST', `${taskPath(projectId, taskId)}/queue`),
      taskParams(projectId, taskId),
    );
    assert.equal(queued.status, 404);
  }
  for (const projectId of [unknownId, 'not-a-uuid']) {
    const list = await listRoute(get(`/api/projects/${projectId}/tasks`), projectParams(projectId));
    assert.equal(list.status, 404);
    assert.equal((await errorOf(list)).code, 'project_not_found');
    const created = await createRoute(
      send('POST', `/api/projects/${projectId}/tasks`, {
        title: 'T',
        prompt: 'P',
        agentRuntime: 'codex',
      }),
      projectParams(projectId),
    );
    assert.equal(created.status, 404);
    assert.equal((await errorOf(created)).code, 'project_not_found');
  }

  const [unchanged] = await listTasks(first.id);
  assert.deepEqual(unchanged, task);
});

test('queues and returns tasks through named actions and rejects illegal transitions', async () => {
  const { root, project } = await registerProject('lifecycle');
  const before = snapshot(root);
  const task = await createTask(project.id);
  const params = taskParams(project.id, task.id);
  const path = taskPath(project.id, task.id);

  const notQueued = await returnRoute(send('POST', `${path}/return-to-backlog`), params);
  assert.equal(notQueued.status, 409);
  assert.equal((await errorOf(notQueued)).code, 'illegal_transition');

  const queuedResponse = await queueRoute(send('POST', `${path}/queue`), params);
  assert.equal(queuedResponse.status, 200);
  const queued = taskResponseSchema.parse(await queuedResponse.json()).task;
  assert.equal(queued.status, 'queued');
  assert.notEqual(queued.queuedAt, null);

  const again = await queueRoute(send('POST', `${path}/queue`), params);
  assert.equal(again.status, 409);
  const againError = await errorOf(again);
  assert.equal(againError.code, 'illegal_transition');
  assert.deepEqual(againError.details, { action: 'queue', status: 'queued' });

  // Queued tasks can be reprioritized, but their content is locked.
  const content = await updateRoute(send('PATCH', path, { title: 'Changed' }), params);
  assert.equal(content.status, 409);
  assert.equal((await errorOf(content)).code, 'task_not_editable');
  const reprioritized = await updateRoute(
    send('PATCH', path, { priority: 'high', urgent: true }),
    params,
  );
  assert.equal(reprioritized.status, 200);
  const reprioritizedTask = taskResponseSchema.parse(await reprioritized.json()).task;
  assert.equal(reprioritizedTask.priority, 'high');
  assert.equal(reprioritizedTask.urgent, true);
  assert.equal(reprioritizedTask.status, 'queued');

  const returnedResponse = await returnRoute(send('POST', `${path}/return-to-backlog`), params);
  assert.equal(returnedResponse.status, 200);
  const returned = taskResponseSchema.parse(await returnedResponse.json()).task;
  assert.equal(returned.status, 'backlog');
  assert.equal(returned.queuedAt, null);
  assert.equal(returned.priority, 'high');

  // A status cannot be set through the edit route.
  const statusEdit = await updateRoute(send('PATCH', path, { status: 'done' }), params);
  assert.equal(statusEdit.status, 400);
  assert.equal((await errorOf(statusEdit)).code, 'invalid_request');

  assert.deepEqual(snapshot(root), before, 'Queueing must not change the repository');
});

test('edits Backlog tasks, resets the model on runtime change and validates updates', async () => {
  const { project } = await registerProject('editing');
  const task = await createTask(project.id, { modelId: 'opus' });
  const params = taskParams(project.id, task.id);
  const path = taskPath(project.id, task.id);

  for (const body of [{}, { title: '' }, { agentRuntime: 'other' }, { projectId: unknownId }]) {
    const response = await updateRoute(send('PATCH', path, body), params);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const missingBranch = await updateRoute(send('PATCH', path, { baseBranch: 'nope' }), params);
  assert.equal(missingBranch.status, 422);
  assert.equal((await errorOf(missingBranch)).code, 'base_branch_not_found');

  const response = await updateRoute(
    send('PATCH', path, {
      title: 'Add logout',
      prompt: 'Implement logout.',
      agentRuntime: 'codex',
      baseBranch: 'develop',
    }),
    params,
  );
  assert.equal(response.status, 200);
  const updated = taskResponseSchema.parse(await response.json()).task;
  assert.equal(updated.title, 'Add logout');
  assert.equal(updated.prompt, 'Implement logout.');
  assert.equal(updated.agentRuntime, 'codex');
  assert.equal(updated.modelId, null, 'switching the runtime resets the model to Default');
  assert.equal(updated.baseBranch, 'develop');
  assert.equal(updated.status, 'backlog');

  const reset = await updateRoute(send('PATCH', path, { baseBranch: null }), params);
  assert.equal(taskResponseSchema.parse(await reset.json()).task.baseBranch, null);
});

test('keeps tasks across requests and application restarts', async () => {
  const { project } = await registerProject('restart');
  const backlog = await createTask(project.id, { title: 'Stays in Backlog' });
  const queued = await createTask(project.id, { title: 'Gets queued', priority: 'low' });
  await queueRoute(
    send('POST', `${taskPath(project.id, queued.id)}/queue`),
    taskParams(project.id, queued.id),
  );
  const beforeRestart = await listTasks(project.id);

  // A restart: the shared connection is dropped and reopened from the same SQLite file.
  closeDatabase();
  const afterRestart = await listTasks(project.id);
  assert.deepEqual(afterRestart, beforeRestart);
  assert.equal(afterRestart.find(({ id }) => id === backlog.id)?.status, 'backlog');
  assert.equal(afterRestart.find(({ id }) => id === queued.id)?.status, 'queued');
});

test('keeps disconnect blocked while the project has tasks', async () => {
  const { root, project } = await registerProject('dependents');
  const before = snapshot(root);
  await createTask(project.id);

  const response = await disconnectRoute(
    send('DELETE', `/api/projects/${project.id}`),
    projectParams(project.id),
  );
  assert.equal(response.status, 409);
  const error = await errorOf(response);
  assert.equal(error.code, 'project_has_dependents');
  assert.deepEqual(error.details, {
    dependents: [{ table: 'tasks', column: 'project_id', count: 1 }],
  });
  assert.equal((await listTasks(project.id)).length, 1);
  assert.deepEqual(snapshot(root), before);
});
