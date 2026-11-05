import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { applyMigrations, createDatabase } from '@ai-agent-manager/database';
import { GET as getProject } from '@/app/api/projects/[projectId]/route';
import { POST as previewRoute } from '@/app/api/projects/preview/route';
import { GET as listRoute, POST as registerRoute } from '@/app/api/projects/route';
import {
  apiErrorResponseSchema,
  projectDetailsSchema,
  projectListResponseSchema,
  projectResponseSchema,
  repositoryPreviewResponseSchema,
} from '@/lib/projects/contracts';
import { closeDatabase } from '@/lib/server/database';
import { createFixtureDirectory, createRepository, removeFixtureDirectory } from './fixtures';

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

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
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
