import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { applyMigrations, createDatabase } from '@ai-agent-manager/database';
import {
  DELETE as disconnectRoute,
  GET as getProject,
  PATCH as updateRoute,
} from '@/app/api/projects/[projectId]/route';
import { POST as previewRoute } from '@/app/api/projects/preview/route';
import { GET as listRoute, POST as registerRoute } from '@/app/api/projects/route';
import {
  apiErrorResponseSchema,
  disconnectProjectResponseSchema,
  projectDetailsSchema,
  projectListResponseSchema,
  projectResponseSchema,
  repositoryPreviewResponseSchema,
} from '@/lib/projects/contracts';
import { closeDatabase } from '@/lib/server/database';
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
  // The route handlers open the configured database; point it at a disposable file.
  process.env[databaseVariable] = join(directory, 'data', 'database.sqlite');
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

const get = (path: string, host = '127.0.0.1:3000'): Request =>
  new Request(`${origin}${path}`, { headers: { host } });

const send = (
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`${origin}${path}`, {
    method,
    headers: { host: '127.0.0.1:3000', origin, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  send('POST', path, body, headers);

const patch = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  send('PATCH', path, body, headers);

const del = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${origin}${path}`, {
    method: 'DELETE',
    headers: { host: '127.0.0.1:3000', origin, ...headers },
  });

const params = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

const errorCode = async (response: Response): Promise<string> =>
  apiErrorResponseSchema.parse(await response.json()).error.code;

test('reports an unmigrated database, then recovers once migrations are applied', async () => {
  const notReady = listRoute(get('/api/projects'));
  assert.equal(notReady.status, 503);
  assert.equal(await errorCode(notReady), 'database_not_ready');

  const connection = createDatabase({ path: process.env[databaseVariable] });
  try {
    applyMigrations(connection);
  } finally {
    connection.close();
  }

  const ready = listRoute(get('/api/projects'));
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  assert.deepEqual(projectListResponseSchema.parse(await ready.json()), { projects: [] });
});

test('rejects foreign hosts, foreign origins, non-JSON, and invalid bodies', async () => {
  const foreignHost = listRoute(get('/api/projects', 'evil.example:3000'));
  assert.equal(foreignHost.status, 403);
  assert.equal(await errorCode(foreignHost), 'forbidden_host');

  const body = { path: '/tmp' };
  for (const headers of [{ origin: 'http://evil.example' }, { origin: '' }]) {
    const response = await previewRoute(post('/api/projects/preview', body, headers));
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), 'forbidden_origin');
  }

  const form = await registerRoute(
    post('/api/projects', 'path=/tmp', { 'content-type': 'application/x-www-form-urlencoded' }),
  );
  assert.equal(form.status, 415);

  const malformed = await registerRoute(post('/api/projects', '{'));
  assert.equal(malformed.status, 400);
  assert.equal(await errorCode(malformed), 'invalid_request');

  const invalid = await registerRoute(post('/api/projects', { path: '', name: 'x' }));
  assert.equal(invalid.status, 400);
  const parsed = apiErrorResponseSchema.parse(await invalid.json());
  assert.equal(parsed.error.code, 'invalid_request');
  assert.ok(parsed.error.details !== undefined && 'fields' in parsed.error.details);

  const tooLarge = await previewRoute(post('/api/projects/preview', { path: 'x'.repeat(70_000) }));
  assert.equal(tooLarge.status, 413);

  const projects = projectListResponseSchema.parse(
    await listRoute(get('/api/projects')).json(),
  ).projects;
  assert.deepEqual(projects, []);
});

test('previews, registers, lists, and shows a project; duplicates conflict', async () => {
  const root = createRepository(join(directory, 'repo'));

  const missing = await previewRoute(
    post('/api/projects/preview', { path: join(directory, 'missing') }),
  );
  assert.equal(missing.status, 422);
  assert.equal(await errorCode(missing), 'path_not_found');

  const previewResponse = await previewRoute(post('/api/projects/preview', { path: root }));
  assert.equal(previewResponse.status, 200);
  const { preview } = repositoryPreviewResponseSchema.parse(await previewResponse.json());
  assert.equal(preview.path, root);

  const registered = await registerRoute(
    post('/api/projects', {
      path: preview.path,
      name: '  Fixture  ',
      defaultBaseBranch: preview.suggestedBaseBranch,
      remoteName: preview.suggestedRemoteName,
    }),
  );
  assert.equal(registered.status, 201);
  const { project } = projectResponseSchema.parse(await registered.json());
  assert.equal(project.name, 'Fixture');
  assert.equal(project.localPath, root);

  const list = projectListResponseSchema.parse(await listRoute(get('/api/projects')).json());
  assert.deepEqual(list.projects, [project]);

  const detailsResponse = await getProject(get(`/api/projects/${project.id}`), params(project.id));
  assert.equal(detailsResponse.status, 200);
  const details = projectDetailsSchema.parse(await detailsResponse.json());
  assert.equal(details.repository.status, 'available');

  const duplicate = await registerRoute(
    post('/api/projects', {
      path: root,
      name: 'Again',
      defaultBaseBranch: 'main',
      remoteName: null,
    }),
  );
  assert.equal(duplicate.status, 409);
  const duplicateError = apiErrorResponseSchema.parse(await duplicate.json()).error;
  assert.equal(duplicateError.code, 'project_already_registered');
  assert.equal(duplicateError.details?.projectId, project.id);

  for (const id of ['00000000-0000-4000-8000-00000000ffff', 'not-a-uuid']) {
    const response = await getProject(get(`/api/projects/${id}`), params(id));
    assert.equal(response.status, 404);
    assert.equal(await errorCode(response), 'project_not_found');
  }
});

test('updates and disconnects a project; guards both mutations', async () => {
  const root = createRepository(join(directory, 'editable'));
  git(root, 'branch', 'develop');
  git(root, 'remote', 'add', 'origin', '../origin.git');
  const registered = await registerRoute(
    post('/api/projects', {
      path: root,
      name: 'Editable',
      defaultBaseBranch: 'main',
      remoteName: null,
    }),
  );
  const { project } = projectResponseSchema.parse(await registered.json());
  const path = `/api/projects/${project.id}`;
  const before = snapshot(root);

  // Request guards: foreign Host or Origin, missing Origin, non-JSON, malformed and invalid bodies.
  const rejectedHeaders: Record<string, string>[] = [
    { host: 'evil.example:3000' },
    { origin: 'http://evil.example' },
    { origin: '' },
  ];
  for (const headers of rejectedHeaders) {
    const update = await updateRoute(patch(path, { name: 'Hacked' }, headers), params(project.id));
    assert.equal(update.status, 403);
    const removal = await disconnectRoute(del(path, headers), params(project.id));
    assert.equal(removal.status, 403);
    assert.match(await errorCode(removal), /^forbidden_(host|origin)$/);
  }
  const form = await updateRoute(
    patch(path, 'name=x', { 'content-type': 'application/x-www-form-urlencoded' }),
    params(project.id),
  );
  assert.equal(form.status, 415);
  const malformed = await updateRoute(patch(path, '{'), params(project.id));
  assert.equal(malformed.status, 400);
  for (const body of [
    {},
    { name: '' },
    { priority: 1000 },
    { priority: '1' },
    { localPath: '/elsewhere' },
    { gitCommonDir: '/elsewhere/.git' },
    { instructions: 'x'.repeat(10_001) },
  ]) {
    const response = await updateRoute(patch(path, body), params(project.id));
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(await errorCode(response), 'invalid_request');
  }

  // Branch and remote must exist in the repository.
  const missingBranch = await updateRoute(
    patch(path, { defaultBaseBranch: 'nope' }),
    params(project.id),
  );
  assert.equal(missingBranch.status, 422);
  assert.equal(await errorCode(missingBranch), 'base_branch_not_found');
  const missingRemote = await updateRoute(patch(path, { remoteName: 'nope' }), params(project.id));
  assert.equal(missingRemote.status, 422);
  assert.equal(await errorCode(missingRemote), 'remote_not_found');

  const unchanged = projectDetailsSchema.parse(
    await (await getProject(get(path), params(project.id))).json(),
  ).project;
  assert.deepEqual(unchanged, project);

  const updatedResponse = await updateRoute(
    patch(path, {
      name: ' Edited ',
      priority: -2,
      instructions: 'Use pnpm.',
      defaultBaseBranch: 'develop',
      remoteName: 'origin',
    }),
    params(project.id),
  );
  assert.equal(updatedResponse.status, 200);
  assert.equal(updatedResponse.headers.get('cache-control'), 'no-store');
  const updated = projectResponseSchema.parse(await updatedResponse.json()).project;
  assert.equal(updated.name, 'Edited');
  assert.equal(updated.priority, -2);
  assert.equal(updated.instructions, 'Use pnpm.');
  assert.equal(updated.defaultBaseBranch, 'develop');
  assert.equal(updated.remoteName, 'origin');
  assert.equal(updated.id, project.id);
  assert.equal(updated.localPath, project.localPath);
  assert.equal(updated.gitCommonDir, project.gitCommonDir);

  const unknownId = '00000000-0000-4000-8000-00000000ffff';
  const unknownUpdate = await updateRoute(
    patch(`/api/projects/${unknownId}`, { name: 'X' }),
    params(unknownId),
  );
  assert.equal(unknownUpdate.status, 404);

  // Disconnect removes the record only; the repository can be registered again.
  const removed = await disconnectRoute(del(path), params(project.id));
  assert.equal(removed.status, 200);
  assert.deepEqual(disconnectProjectResponseSchema.parse(await removed.json()), {
    disconnected: { id: project.id, name: 'Edited' },
  });
  const again = await disconnectRoute(del(path), params(project.id));
  assert.equal(again.status, 404);
  assert.equal(await errorCode(again), 'project_not_found');
  const invalidId = await disconnectRoute(del('/api/projects/not-a-uuid'), params('not-a-uuid'));
  assert.equal(invalidId.status, 404);

  assert.deepEqual(snapshot(root), before, 'API operations must not change the repository');

  const reRegistered = await registerRoute(
    post('/api/projects', {
      path: root,
      name: 'Editable again',
      defaultBaseBranch: 'main',
      remoteName: 'origin',
    }),
  );
  assert.equal(reRegistered.status, 201);
  assert.notEqual(projectResponseSchema.parse(await reRegistered.json()).project.id, project.id);
});
