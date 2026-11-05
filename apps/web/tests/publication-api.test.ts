import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { trustedLocalDisclosure, type GitIntegrityResultStatus } from '@ai-agent-manager/core';
import {
  acceptTrustedLocal,
  applyMigrations,
  claimPublication,
  claimStartCommand,
  completePublicationCommit,
  createDatabase,
  failPublication,
  findProjectById,
  findTaskById,
  finishTaskRun,
  listTaskPublications,
  listTaskReviews,
  recordGitIntegrity,
  recordPublicationCommitObject,
  recordRunWorkspace,
  requestTaskExecution,
  setProjectExecutionTrust,
  startPublicationPush,
} from '@ai-agent-manager/database';
import { createTaskWorktree } from '@ai-agent-manager/git';
import { POST as approveRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/review/approve/route';
import { POST as requestChangesRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/review/request-changes/route';
import { POST as retryPushRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/review/retry-push/route';
import { GET as reviewRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/review/route';
import { POST as queueRoute } from '@/app/api/projects/[projectId]/tasks/[taskId]/queue/route';
import { POST as createTaskRoute } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as registerRoute } from '@/app/api/projects/route';
import { apiErrorResponseSchema, projectResponseSchema } from '@/lib/projects/contracts';
import {
  publicationResponseSchema,
  taskReviewResponseSchema,
  type TaskReviewView,
} from '@/lib/review/contracts';
import { closeDatabase, getDatabase } from '@/lib/server/database';
import { taskResponseSchema } from '@/lib/tasks/contracts';
import {
  createFixtureDirectory,
  createRepository,
  git,
  removeFixtureDirectory,
  snapshot,
  writeFile,
} from './fixtures';

// Approve & Push in the web process (M6-03): the review page shows the destination and readiness,
// and the approve route records an approval bound to a fresh review snapshot. The web process never
// stages, commits or pushes; that is the worker's job (tested in apps/worker). Disposable
// repositories and local bare remotes only; no agent runs.

const origin = 'http://127.0.0.1:3000';
const databaseVariable = 'AI_AGENT_MANAGER_DATABASE_PATH';

let directory = '';
let worktreeRoot = '';
let previousDatabasePath: string | undefined;

before(() => {
  directory = createFixtureDirectory();
  worktreeRoot = join(directory, 'worktrees');
  previousDatabasePath = process.env[databaseVariable];
  process.env[databaseVariable] = join(directory, 'data', 'database.sqlite');
  const connection = createDatabase({ path: process.env[databaseVariable] });
  try {
    applyMigrations(connection);
  } finally {
    connection.close();
  }
  acceptTrustedLocal(getDatabase(), {
    input: {
      disclosureVersion: trustedLocalDisclosure.version,
      acceptedRisks: [...trustedLocalDisclosure.acceptedRisks],
    },
    now: 1,
  });
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

const post = (path: string, body?: unknown): Request =>
  new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${origin}${path}`, { headers: { host: '127.0.0.1:3000', ...headers } });

const taskParams = (projectId: string, taskId: string) => ({
  params: Promise.resolve({ projectId, taskId }),
});

const errorCode = async (response: Response): Promise<string> =>
  apiErrorResponseSchema.parse(await response.json()).error.code;

type Fixture = {
  projectId: string;
  taskId: string;
  runId: string;
  root: string;
  worktree: string;
};

const registerProject = async (
  name: string,
  seed?: (root: string) => void,
  { withRemote = true }: { withRemote?: boolean } = {},
) => {
  const root = createRepository(join(directory, name));
  if (seed !== undefined) {
    seed(root);
    git(root, 'add', '--all');
    git(root, 'commit', '--quiet', '-m', 'Seed');
  }
  if (withRemote) {
    const remote = join(directory, `${name}.git`);
    git(directory, 'init', '--quiet', '--bare', remote);
    git(root, 'remote', 'add', 'origin', remote);
  }
  const registered = await registerRoute(
    post('/api/projects', {
      path: root,
      name,
      defaultBaseBranch: 'main',
      remoteName: withRemote ? 'origin' : null,
    }),
  );
  assert.equal(registered.status, 201);
  const { project } = projectResponseSchema.parse(await registered.json());
  return { projectId: project.id, root };
};

const createQueuedTask = async (projectId: string, title = 'Agent task'): Promise<string> => {
  const created = await createTaskRoute(
    post(`/api/projects/${projectId}/tasks`, {
      title,
      prompt: 'Change things.',
      agentRuntime: 'codex',
    }),
    { params: Promise.resolve({ projectId }) },
  );
  const { task } = taskResponseSchema.parse(await created.json());
  await queueRoute(
    post(`/api/projects/${projectId}/tasks/${task.id}/queue`),
    taskParams(projectId, task.id),
  );
  return task.id;
};

/** Claims a run and creates its worktree the way the worker does; leaves the run active. */
const startRun = async (projectId: string, root: string, taskId: string) => {
  const db = getDatabase();
  const project = findProjectById(db, projectId);
  assert.ok(project);
  setProjectExecutionTrust(db, {
    projectId,
    trust: {
      trust: 'trusted_local',
      localPath: project.localPath,
      gitCommonDir: project.gitCommonDir,
    },
    now: 2,
  });
  const commandId = randomUUID();
  const runId = randomUUID();
  requestTaskExecution(db, { id: commandId, taskId, now: 3 });
  const claim = claimStartCommand(db, {
    commandId,
    runId,
    workerInstanceId: 'review-test',
    timeoutMs: 60_000,
    now: 4,
  });
  assert.equal(claim.claimed, true);
  const worktree = await createTaskWorktree({
    repositoryPath: root,
    baseBranch: 'main',
    taskId,
    worktreeRoot,
  });
  recordRunWorkspace(db, {
    runId,
    workspace: {
      id: randomUUID(),
      taskId,
      generation: 1,
      repositoryRoot: worktree.repository.root,
      gitCommonDir: worktree.repository.commonDir,
      worktreeRoot,
      path: worktree.path,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      baseSha: worktree.baseCommit,
      createdAt: 5,
    },
  });
  return { runId, worktree: worktree.path };
};

const finishRun = (runId: string, integrity: GitIntegrityResultStatus = 'clean'): void => {
  const db = getDatabase();
  recordGitIntegrity(db, runId, {
    status: integrity,
    resultJson:
      integrity === 'clean'
        ? JSON.stringify({ findings: [], totalFindings: 0 })
        : JSON.stringify({
            findings: [
              { code: 'branch_ref_changed', disposition: 'violation', subject: 'refs/heads/x' },
            ],
            totalFindings: 1,
          }),
    checkedAt: 6,
  });
  const finished = finishTaskRun(db, runId, {
    status: 'completed',
    taskAction: integrity === 'clean' ? 'complete_execution' : 'fail',
    exitCode: 0,
    errorCode: integrity === 'clean' ? null : `git_integrity_${integrity}`,
    summary: 'Done. I changed some files.',
    endedAt: 7,
  });
  assert.ok(finished);
};

const setUpRun = async (
  name: string,
  {
    seed,
    change,
    integrity = 'clean',
    withRemote = true,
  }: {
    seed?: (root: string) => void;
    change?: (worktree: string) => void;
    integrity?: GitIntegrityResultStatus;
    withRemote?: boolean;
  } = {},
): Promise<Fixture> => {
  const { projectId, root } = await registerProject(name, seed, { withRemote });
  const taskId = await createQueuedTask(projectId);
  const { runId, worktree } = await startRun(projectId, root, taskId);
  change?.(worktree);
  finishRun(runId, integrity);
  return { projectId, taskId, runId, root, worktree };
};

const fetchReview = async (projectId: string, taskId: string): Promise<TaskReviewView> => {
  const response = await reviewRoute(
    get(`/api/projects/${projectId}/tasks/${taskId}/review`),
    taskParams(projectId, taskId),
  );
  assert.equal(response.status, 200);
  return taskReviewResponseSchema.parse(await response.json()).review;
};

const agentChanges = (worktree: string): void => {
  writeFile(join(worktree, 'README.md'), 'fixture\nchanged by agent\n');
  writeFile(join(worktree, 'hello.txt'), 'Hello from the agent\n');
  writeFile(join(worktree, 'build', 'output.js'), 'ignored\n');
};

const seedIgnore = (root: string): void => writeFile(join(root, '.gitignore'), 'build/\n');

/** The approval body exactly as the page would send it for what it shows. */
const approvalBody = (review: TaskReviewView, overrides: Record<string, unknown> = {}) => {
  assert.ok(review.run);
  assert.equal(review.changes.state, 'available');
  assert.ok(review.changes.state === 'available');
  assert.ok(review.publication.destination);
  return {
    requestId: randomUUID(),
    runId: review.run.id,
    revision: review.changes.revision,
    remoteName: review.publication.destination.remoteName,
    branch: review.publication.destination.branch,
    confirmed: true,
    ...overrides,
  };
};

const approve = (fixture: Fixture, body: unknown, headers: Record<string, string> = {}) =>
  approveRoute(
    new Request(
      `${origin}/api/projects/${fixture.projectId}/tasks/${fixture.taskId}/review/approve`,
      {
        method: 'POST',
        headers: { host: '127.0.0.1:3000', origin, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
    ),
    taskParams(fixture.projectId, fixture.taskId),
  );

const branchAt = (root: string, branch: string): string =>
  git(root, 'rev-parse', `refs/heads/${branch}`).trim();

test('the review shows the destination, commit message and readiness without mutating anything', async () => {
  const fixture = await setUpRun('ready repo', { seed: seedIgnore, change: agentChanges });
  const repositoryBefore = snapshot(fixture.root);
  const worktreeBefore = snapshot(fixture.worktree);
  const review = await fetchReview(fixture.projectId, fixture.taskId);
  const { publication } = review;
  assert.deepEqual(publication.readiness, { ready: true, reasons: [] });
  assert.equal(publication.destination?.remoteName, 'origin');
  assert.equal(publication.destination?.remoteUrl, join(directory, 'ready repo.git'));
  assert.equal(publication.destination?.branch, review.workspace?.branch);
  assert.equal(publication.destination?.remoteRef, `refs/heads/${review.workspace?.branch}`);
  assert.match(
    publication.commitMessage ?? '',
    new RegExp(`^Agent task\n\nAI Agent Manager task: ${fixture.taskId}\n`),
  );
  assert.equal(publication.current, null);
  assert.deepEqual(publication.history, []);
  // Page loads never stage, commit, push or record anything.
  await fetchReview(fixture.projectId, fixture.taskId);
  assert.deepEqual(snapshot(fixture.root), repositoryBefore);
  assert.deepEqual(snapshot(fixture.worktree), worktreeBefore);
  assert.deepEqual(listTaskPublications(getDatabase(), fixture.taskId), []);
});

test('approving records a snapshot-bound approval, commits nothing and deduplicates requests', async () => {
  const fixture = await setUpRun('approve repo', { seed: seedIgnore, change: agentChanges });
  const review = await fetchReview(fixture.projectId, fixture.taskId);
  const branch = review.workspace?.branch ?? '';
  const base = review.workspace?.baseSha ?? '';
  const repositoryBefore = snapshot(fixture.root);
  const body = approvalBody(review);

  const created = await approve(fixture, body);
  assert.equal(created.status, 201);
  const { publication, task } = publicationResponseSchema.parse(await created.json());
  assert.equal(task.status, 'review', 'an approval alone never marks the task Done');
  assert.equal(publication.status, 'approved');
  assert.equal(publication.commitSha, null);
  assert.equal(publication.remoteName, 'origin');
  assert.equal(publication.branch, branch);
  assert.deepEqual(
    publication.files.map(({ path }) => path),
    ['README.md', 'hello.txt'],
    'tracked and untracked changes; ignored files are excluded',
  );
  assert.match(publication.snapshotHash, /^[0-9a-f]{64}$/);

  // Nothing was staged, committed or pushed by the web process.
  assert.equal(branchAt(fixture.root, branch), base);
  assert.deepEqual(snapshot(fixture.root), repositoryBefore);
  assert.match(git(fixture.worktree, 'status', '--porcelain'), /^\?\? hello\.txt$/m);
  assert.equal(git(join(directory, 'approve repo.git'), 'for-each-ref').trim(), '');

  // Double click: the same request ID returns the same approval.
  const repeated = await approve(fixture, body);
  assert.equal(repeated.status, 200);
  assert.equal(
    publicationResponseSchema.parse(await repeated.json()).publication.id,
    publication.id,
  );
  // A second, separate approval is refused while the first is active.
  const second = await approve(fixture, { ...body, requestId: randomUUID() });
  assert.equal(second.status, 409);
  assert.equal(await errorCode(second), 'publication_in_progress');
  // Request Changes is refused too.
  const changes = await requestChangesRoute(
    post(`/api/projects/${fixture.projectId}/tasks/${fixture.taskId}/review/request-changes`, {
      runId: body.runId,
      revision: body.revision,
      feedback: 'Please change more.',
    }),
    taskParams(fixture.projectId, fixture.taskId),
  );
  assert.equal(changes.status, 409);
  assert.equal(await errorCode(changes), 'publication_in_progress');
  assert.deepEqual(listTaskReviews(getDatabase(), fixture.taskId), []);
  assert.equal(listTaskPublications(getDatabase(), fixture.taskId).length, 1);

  const after = await fetchReview(fixture.projectId, fixture.taskId);
  assert.equal(after.publication.current?.id, publication.id);
  assert.deepEqual(after.publication.readiness.reasons, ['publication_active']);
});

test('concurrent approvals of the same review produce exactly one approval', async () => {
  const fixture = await setUpRun('concurrent repo', { seed: seedIgnore, change: agentChanges });
  const review = await fetchReview(fixture.projectId, fixture.taskId);
  const responses = await Promise.all(
    [1, 2, 3, 4].map(() => approve(fixture, approvalBody(review))),
  );
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409]);
  assert.equal(listTaskPublications(getDatabase(), fixture.taskId).length, 1);
});

test('stale reviews and tampered destinations are refused before anything is recorded', async () => {
  const fixture = await setUpRun('stale repo', { seed: seedIgnore, change: agentChanges });
  const review = await fetchReview(fixture.projectId, fixture.taskId);
  const cases: Array<[Record<string, unknown>, number, string]> = [
    [{ revision: 'not-the-revision' }, 409, 'review_changes_changed'],
    [{ runId: randomUUID() }, 409, 'review_run_changed'],
    [{ remoteName: 'upstream' }, 409, 'publication_target_changed'],
    [{ branch: 'main' }, 409, 'publication_target_changed'],
    [{ confirmed: false }, 400, 'invalid_request'],
    [{ path: '/etc' }, 400, 'invalid_request'],
    [{ commitMessage: 'Injected' }, 400, 'invalid_request'],
  ];
  for (const [overrides, status, code] of cases) {
    const response = await approve(fixture, approvalBody(review, overrides));
    assert.equal(response.status, status, JSON.stringify(overrides));
    assert.equal(await errorCode(response), code, JSON.stringify(overrides));
  }
  const crossSite = await approve(fixture, approvalBody(review), {
    origin: 'https://evil.example',
  });
  assert.equal(crossSite.status, 403);

  // A file added after the page was loaded changes the revision: a fresh review is required.
  writeFileSync(join(fixture.worktree, 'late.txt'), 'added after review\n');
  const late = await approve(fixture, approvalBody(review));
  assert.equal(late.status, 409);
  assert.equal(await errorCode(late), 'review_changes_changed');
  assert.deepEqual(listTaskPublications(getDatabase(), fixture.taskId), []);

  // Approving the fresh review works and includes the new file.
  const fresh = await fetchReview(fixture.projectId, fixture.taskId);
  const accepted = await approve(fixture, approvalBody(fresh));
  assert.equal(accepted.status, 201);
  assert.ok(
    publicationResponseSchema
      .parse(await accepted.json())
      .publication.files.some(({ path }) => path === 'late.txt'),
  );
});

test('approval requires a configured remote and a publishable change set', async () => {
  const noRemote = await setUpRun('no remote repo', { change: agentChanges, withRemote: false });
  const review = await fetchReview(noRemote.projectId, noRemote.taskId);
  assert.equal(review.publication.destination, null);
  assert.ok(review.publication.readiness.reasons.includes('no_remote'));
  assert.ok(review.run && review.changes.state === 'available');
  const refused = await approve(noRemote, {
    requestId: randomUUID(),
    runId: review.run.id,
    revision: review.changes.revision,
    remoteName: 'origin',
    branch: review.workspace?.branch,
    confirmed: true,
  });
  assert.equal(refused.status, 409);
  assert.equal(await errorCode(refused), 'publication_remote_missing');

  const empty = await setUpRun('empty repo');
  const emptyReview = await fetchReview(empty.projectId, empty.taskId);
  assert.ok(emptyReview.publication.readiness.reasons.includes('no_changes'));
  const blocked = await approve(empty, approvalBody(emptyReview));
  assert.equal(blocked.status, 409);
  assert.equal(await errorCode(blocked), 'publication_blocked');

  // The agent committed despite instructions (and the integrity check missed nothing here because
  // the test records it as clean): the branch moved, so only files can be approved, not commits.
  const committed = await setUpRun('committed repo', {
    change: (worktree) => {
      writeFile(join(worktree, 'hello.txt'), 'hi\n');
      git(worktree, 'add', 'hello.txt');
      git(worktree, 'commit', '--quiet', '-m', 'Agent commit');
    },
  });
  const committedReview = await fetchReview(committed.projectId, committed.taskId);
  assert.ok(committedReview.publication.readiness.reasons.includes('unexpected_commits'));
  const refusedCommit = await approve(committed, approvalBody(committedReview));
  assert.equal(await errorCode(refusedCommit), 'publication_blocked');

  const violation = await setUpRun('violation repo', {
    change: agentChanges,
    integrity: 'violation',
  });
  const violationReview = await fetchReview(violation.projectId, violation.taskId);
  assert.ok(violationReview.publication.readiness.reasons.includes('not_review_eligible'));
});

test('retry push is offered only for a committed, unpushed publication', async () => {
  const fixture = await setUpRun('retry repo', { seed: seedIgnore, change: agentChanges });
  const review = await fetchReview(fixture.projectId, fixture.taskId);
  const created = await approve(fixture, approvalBody(review));
  const { publication } = publicationResponseSchema.parse(await created.json());
  const db = getDatabase();
  const retry = (publicationId: string) =>
    retryPushRoute(
      post(`/api/projects/${fixture.projectId}/tasks/${fixture.taskId}/review/retry-push`, {
        publicationId,
      }),
      taskParams(fixture.projectId, fixture.taskId),
    );

  // Not yet committed: retry is refused.
  const early = await retry(publication.id);
  assert.equal(early.status, 409);
  assert.equal(await errorCode(early), 'push_retry_not_allowed');

  // Simulate the worker: commit recorded, push failed.
  claimPublication(db, {
    id: publication.id,
    operationId: randomUUID(),
    workerInstanceId: 'w',
    now: 10,
  });
  recordPublicationCommitObject(db, {
    id: publication.id,
    commitSha: 'c'.repeat(40),
    treeSha: 't'.repeat(40),
    now: 11,
  });
  completePublicationCommit(db, { id: publication.id, now: 12 });
  startPublicationPush(db, { id: publication.id, operationId: randomUUID(), now: 13 });
  failPublication(db, {
    id: publication.id,
    stage: 'push',
    errorCode: 'push_authentication_failed',
    errorMessage: 'Git could not authenticate with the remote.',
    now: 14,
  });
  const failedView = await fetchReview(fixture.projectId, fixture.taskId);
  assert.equal(failedView.publication.current?.canRetryPush, true);
  assert.deepEqual(failedView.publication.readiness.reasons, ['push_pending']);
  assert.equal(findTaskById(db, fixture.taskId)?.status, 'review', 'a failed push is not Done');
  // A new approval is refused: only the push may be retried.
  const again = await approve(fixture, approvalBody(review));
  assert.equal(await errorCode(again), 'publication_push_pending');

  const accepted = await retry(publication.id);
  assert.equal(accepted.status, 200);
  assert.equal(
    publicationResponseSchema.parse(await accepted.json()).publication.status,
    'push_requested',
  );
  const unknown = await retry(randomUUID());
  assert.equal(unknown.status, 404);
});

test('publication routes never import agent execution or run Git mutations themselves', () => {
  for (const path of ['lib/server/publication.ts', 'lib/server/publication-view.ts']) {
    const source = readFileSync(join(import.meta.dirname, '..', path), 'utf8');
    assert.doesNotMatch(source, /@ai-agent-manager\/(?:agents|orchestrator)/);
    assert.doesNotMatch(source, /node:child_process|spawn\(|execFile/);
    assert.doesNotMatch(
      source,
      /commitReviewSnapshot|pushTaskBranch|requestTaskExecution|claimStartCommand|transitionTask/,
    );
  }
  for (const route of ['review/approve/route.ts', 'review/retry-push/route.ts']) {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'app/api/projects/[projectId]/tasks/[taskId]', route),
      'utf8',
    );
    assert.deepEqual(source.match(/export const (\w+)/g), ['export const POST']);
  }
});
