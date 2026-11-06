import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  TaskError,
  taskSchema,
  type CreateTaskInput,
  type TaskErrorCode,
} from '@ai-agent-manager/core';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  applyMigrations,
  countTasksByProjectAndStatus,
  createDatabase,
  createTask,
  deleteProject,
  findProjectById,
  findTaskById,
  insertProject,
  listProjectTasks,
  ProjectHasDependentsError,
  transitionTask,
  updateTask,
  type DatabaseConnection,
  type NewProjectRecord,
} from '../src/index.js';

const projectA = '00000000-0000-4000-8000-00000000000a';
const projectB = '00000000-0000-4000-8000-00000000000b';
const taskId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const project = (id: string, name: string): NewProjectRecord => ({
  id,
  name,
  localPath: `/repos/${name}`,
  gitCommonDir: `/repos/${name}/.git`,
  remoteName: 'origin',
  defaultBaseBranch: 'main',
  createdAt: 1_000,
  updatedAt: 1_000,
});

const input = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  projectId: projectA,
  title: 'Add login',
  prompt: 'Implement the login form.',
  agentRuntime: 'claude',
  ...overrides,
});

const withDatabase = (run: (connection: DatabaseConnection, path: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-tasks-'));
  const path = join(directory, 'database.sqlite');
  const connection = createDatabase({ path });
  try {
    applyMigrations(connection);
    insertProject(connection.db, project(projectA, 'website'));
    insertProject(connection.db, project(projectB, 'api'));
    run(connection, path);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

const throwsTaskError = (run: () => unknown, code: TaskErrorCode): TaskError => {
  let caught: unknown;
  assert.throws(run, (error: unknown) => {
    caught = error;
    return error instanceof TaskError && error.code === code;
  });
  assert.ok(caught instanceof TaskError);
  return caught;
};

test('creates a task in Backlog with defaults and reloads it from SQLite', () => {
  withDatabase(({ db }, path) => {
    const created = createTask(db, {
      id: taskId(1),
      input: input({ title: '  Add login ' }),
      now: 5,
    });
    assert.deepEqual(created, {
      id: taskId(1),
      projectId: projectA,
      title: 'Add login',
      prompt: 'Implement the login form.',
      agentRuntime: 'claude',
      modelId: null,
      baseBranch: null,
      priority: 'normal',
      urgent: false,
      status: 'backlog',
      queuedAt: null,
      createdAt: 5,
      updatedAt: 5,
      archivedAt: null,
    });
    assert.deepEqual(taskSchema.parse(created), created);

    const explicit = createTask(db, {
      id: taskId(2),
      input: input({
        agentRuntime: 'codex',
        modelId: 'gpt-5.1-codex',
        baseBranch: 'release/1.0',
        priority: 'critical',
        urgent: true,
      }),
      now: 6,
    });

    const reopened = createDatabase({ path });
    try {
      assert.deepEqual(findTaskById(reopened.db, taskId(1)), created);
      assert.deepEqual(listProjectTasks(reopened.db, projectA), [created, explicit]);
    } finally {
      reopened.close();
    }
  });
});

test('rejects invalid input and unknown projects without writing anything', () => {
  withDatabase(({ db }) => {
    throwsTaskError(
      () => createTask(db, { id: 'task-1', input: input(), now: 1 }),
      'invalid_task_input',
    );
    const error = throwsTaskError(
      () => createTask(db, { id: taskId(1), input: input({ title: ' ' }), now: 1 }),
      'invalid_task_input',
    );
    assert.deepEqual(error.details, {
      issues: [{ path: 'title', message: 'Enter a task title.' }],
    });
    throwsTaskError(
      () =>
        createTask(db, {
          id: taskId(1),
          input: { ...input(), status: 'queued' } as CreateTaskInput,
          now: 1,
        }),
      'invalid_task_input',
    );
    throwsTaskError(
      () =>
        createTask(db, {
          id: taskId(1),
          input: input({ projectId: '00000000-0000-4000-8000-00000000ffff' }),
          now: 1,
        }),
      'project_not_found',
    );
    assert.deepEqual(listProjectTasks(db, projectA), []);
    assert.equal(findTaskById(db, 'not-a-uuid'), undefined);
  });
});

test('enforces the project foreign key and the stored value constraints in SQLite', () => {
  withDatabase(({ sqlite }) => {
    const insert = sqlite.prepare(
      `INSERT INTO tasks (id, project_id, title, prompt, agent_runtime, status, queued_at, created_at, updated_at)
       VALUES (?, ?, 'T', 'P', ?, ?, ?, 1, 1)`,
    );
    assert.throws(
      () =>
        insert.run(taskId(1), '00000000-0000-4000-8000-00000000ffff', 'claude', 'backlog', null),
      /FOREIGN KEY/,
    );
    assert.throws(() => insert.run(taskId(1), projectA, 'gemini', 'backlog', null), /CHECK/);
    assert.throws(() => insert.run(taskId(1), projectA, 'claude', 'In Progress', null), /CHECK/);
    assert.throws(() => insert.run(taskId(1), projectA, 'claude', 'queued', null), /CHECK/);
    insert.run(taskId(1), projectA, 'claude', 'queued', 10);
    assert.throws(() => sqlite.exec(`UPDATE tasks SET priority = 'urgent'`), /CHECK/);
    assert.throws(() => sqlite.exec(`UPDATE tasks SET urgent = 2`), /CHECK/);

    // RESTRICT: neither deleting nor re-keying a referenced project is possible, even in raw SQL.
    assert.throws(
      () => sqlite.prepare('DELETE FROM projects WHERE id = ?').run(projectA),
      /FOREIGN KEY/,
    );
    assert.throws(
      () => sqlite.prepare("UPDATE projects SET id = 'x' WHERE id = ?").run(projectA),
      /FOREIGN KEY/,
    );
  });
});

test('refuses to disconnect a project with tasks and keeps both the project and its tasks', () => {
  withDatabase(({ db }) => {
    const task = createTask(db, { id: taskId(1), input: input(), now: 1 });
    assert.throws(
      () => deleteProject(db, projectA),
      (error: unknown) => {
        assert.ok(error instanceof ProjectHasDependentsError);
        assert.deepEqual(error.dependents, [{ table: 'tasks', column: 'project_id', count: 1 }]);
        return true;
      },
    );
    assert.notEqual(findProjectById(db, projectA), undefined);
    assert.deepEqual(findTaskById(db, taskId(1)), task);

    // A project without tasks can still be disconnected.
    assert.equal(deleteProject(db, projectB)?.id, projectB);
  });
});

test('lists only the tasks of the requested project', () => {
  withDatabase(({ db }) => {
    createTask(db, { id: taskId(3), input: input(), now: 3 });
    createTask(db, { id: taskId(2), input: input({ projectId: projectB }), now: 2 });
    createTask(db, { id: taskId(1), input: input(), now: 3 });
    assert.deepEqual(
      listProjectTasks(db, projectA).map(({ id }) => id),
      [taskId(1), taskId(3)],
    );
    assert.deepEqual(
      listProjectTasks(db, projectB).map(({ id }) => id),
      [taskId(2)],
    );
    assert.deepEqual(listProjectTasks(db, '00000000-0000-4000-8000-00000000ffff'), []);
  });
});

test('counts tasks per project and status', () => {
  withDatabase(({ db }) => {
    assert.deepEqual(countTasksByProjectAndStatus(db), []);
    createTask(db, { id: taskId(1), input: input(), now: 1 });
    createTask(db, { id: taskId(2), input: input(), now: 2 });
    createTask(db, { id: taskId(3), input: input({ projectId: projectB }), now: 3 });
    transitionTask(db, { id: taskId(2), action: 'queue', now: 4 });
    const counts = countTasksByProjectAndStatus(db).sort((a, b) =>
      `${a.projectId}${a.status}`.localeCompare(`${b.projectId}${b.status}`),
    );
    assert.deepEqual(counts, [
      { projectId: projectA, status: 'backlog', count: 1 },
      { projectId: projectA, status: 'queued', count: 1 },
      { projectId: projectB, status: 'backlog', count: 1 },
    ]);
  });
});

test('walks the lifecycle through named transitions and tracks the queue time', () => {
  withDatabase(({ db }) => {
    const id = taskId(1);
    createTask(db, { id, input: input(), now: 1 });
    const step = (action: Parameters<typeof transitionTask>[1]['action'], now: number) =>
      transitionTask(db, { id, action, now });

    assert.deepEqual(pick(step('queue', 2)), { status: 'queued', queuedAt: 2, updatedAt: 2 });
    assert.deepEqual(pick(step('return_to_backlog', 3)), {
      status: 'backlog',
      queuedAt: null,
      updatedAt: 3,
    });
    step('queue', 4);
    assert.deepEqual(pick(step('start', 5)), { status: 'in_progress', queuedAt: 4, updatedAt: 5 });
    assert.deepEqual(pick(step('complete_execution', 6)), {
      status: 'review',
      queuedAt: 4,
      updatedAt: 6,
    });
    assert.deepEqual(pick(step('request_changes', 7)), {
      status: 'queued',
      queuedAt: 7,
      updatedAt: 7,
    });
    step('start', 8);
    assert.equal(step('stop', 9).status, 'stopped');
    assert.equal(step('resume', 10).status, 'queued');
    step('start', 11);
    assert.equal(step('interrupt', 12).status, 'interrupted');
    assert.equal(step('retry', 13).status, 'queued');
    step('start', 14);
    assert.equal(step('fail', 15).status, 'failed');
    assert.equal(step('retry', 16).status, 'queued');
    step('start', 17);
    step('complete_execution', 18);
    const done = step('mark_done', 19);
    assert.deepEqual(pick(done), { status: 'done', queuedAt: 16, updatedAt: 19 });
    assert.deepEqual(findTaskById(db, id), done);
  });
});

const pick = ({
  status,
  queuedAt,
  updatedAt,
}: {
  status: string;
  queuedAt: number | null;
  updatedAt: number;
}) => ({
  status,
  queuedAt,
  updatedAt,
});

test('rejects illegal transitions and unknown tasks without changing anything', () => {
  withDatabase(({ db }) => {
    const created = createTask(db, { id: taskId(1), input: input(), now: 1 });
    for (const action of [
      'start',
      'complete_execution',
      'stop',
      'retry',
      'discard',
      'mark_done',
    ] as const) {
      const error = throwsTaskError(
        () => transitionTask(db, { id: taskId(1), action, now: 2 }),
        'illegal_transition',
      );
      assert.deepEqual(error.details, { action, status: 'backlog' });
    }
    assert.deepEqual(findTaskById(db, taskId(1)), created);

    transitionTask(db, { id: taskId(1), action: 'queue', now: 2 });
    transitionTask(db, { id: taskId(1), action: 'start', now: 3 });
    transitionTask(db, { id: taskId(1), action: 'fail', now: 4 });
    throwsTaskError(
      () => transitionTask(db, { id: taskId(1), action: 'resume', now: 5 }),
      'illegal_transition',
    );
    const discarded = transitionTask(db, { id: taskId(1), action: 'discard', now: 5 });
    for (const action of ['queue', 'retry', 'request_changes', 'mark_done'] as const) {
      throwsTaskError(
        () => transitionTask(db, { id: taskId(1), action, now: 6 }),
        'illegal_transition',
      );
    }
    assert.deepEqual(findTaskById(db, taskId(1)), discarded);

    throwsTaskError(
      () => transitionTask(db, { id: taskId(9), action: 'queue', now: 1 }),
      'task_not_found',
    );
    throwsTaskError(
      () => transitionTask(db, { id: '../x', action: 'queue', now: 1 }),
      'task_not_found',
    );
    throwsTaskError(
      () => transitionTask(db, { id: taskId(1), action: 'approve' as 'queue', now: 1 }),
      'invalid_task_input',
    );
  });
});

test('edits content only in Backlog, reprioritizes in Queued and resets the model on runtime change', () => {
  withDatabase(({ db }) => {
    const id = taskId(1);
    createTask(db, { id, input: input({ modelId: 'opus' }), now: 1 });

    const edited = updateTask(db, {
      id,
      input: { title: ' Renamed ', baseBranch: 'develop' },
      now: 2,
    });
    assert.equal(edited.title, 'Renamed');
    assert.equal(edited.baseBranch, 'develop');
    assert.equal(edited.modelId, 'opus');
    assert.equal(edited.updatedAt, 2);

    const switched = updateTask(db, { id, input: { agentRuntime: 'codex' }, now: 3 });
    assert.equal(switched.agentRuntime, 'codex');
    assert.equal(switched.modelId, null);
    const explicit = updateTask(db, {
      id,
      input: { agentRuntime: 'claude', modelId: 'sonnet' },
      now: 4,
    });
    assert.equal(explicit.modelId, 'sonnet');
    assert.equal(updateTask(db, { id, input: { baseBranch: null }, now: 5 }).baseBranch, null);

    transitionTask(db, { id, action: 'queue', now: 6 });
    const reprioritized = updateTask(db, { id, input: { priority: 'high', urgent: true }, now: 7 });
    assert.deepEqual(
      {
        status: reprioritized.status,
        priority: reprioritized.priority,
        urgent: reprioritized.urgent,
      },
      { status: 'queued', priority: 'high', urgent: true },
    );
    const error = throwsTaskError(
      () => updateTask(db, { id, input: { prompt: 'Changed' }, now: 8 }),
      'task_not_editable',
    );
    assert.deepEqual(error.details, { status: 'queued' });

    transitionTask(db, { id, action: 'start', now: 9 });
    throwsTaskError(
      () => updateTask(db, { id, input: { priority: 'low' }, now: 10 }),
      'task_not_editable',
    );
    assert.deepEqual(findTaskById(db, id), {
      ...reprioritized,
      status: 'in_progress',
      updatedAt: 9,
    });

    throwsTaskError(() => updateTask(db, { id, input: {}, now: 11 }), 'invalid_task_input');
    throwsTaskError(
      () => updateTask(db, { id, input: { status: 'done' } as never, now: 11 }),
      'invalid_task_input',
    );
    throwsTaskError(
      () => updateTask(db, { id: taskId(9), input: { title: 'X' }, now: 11 }),
      'task_not_found',
    );
  });
});

test('a conflicting command from another connection sees the committed status', () => {
  withDatabase(({ db }, path) => {
    const id = taskId(1);
    createTask(db, { id, input: input(), now: 1 });
    transitionTask(db, { id, action: 'queue', now: 2 });

    const worker = createDatabase({ path });
    try {
      // The worker claims the task; the user's "return to Backlog" from the same Queued state loses.
      assert.equal(
        transitionTask(worker.db, { id, action: 'start', now: 3 }).status,
        'in_progress',
      );
      throwsTaskError(
        () => transitionTask(db, { id, action: 'return_to_backlog', now: 4 }),
        'illegal_transition',
      );
      throwsTaskError(
        () => transitionTask(db, { id, action: 'start', now: 4 }),
        'illegal_transition',
      );
      throwsTaskError(
        () => updateTask(db, { id, input: { priority: 'low' }, now: 4 }),
        'task_not_editable',
      );
      assert.deepEqual(pick(findTaskById(worker.db, id) ?? assert.fail()), {
        status: 'in_progress',
        queuedAt: 2,
        updatedAt: 3,
      });
    } finally {
      worker.close();
    }
  });
});

test('does not change the task while another connection holds the write lock', () => {
  withDatabase(({ db, sqlite }, path) => {
    const id = taskId(1);
    createTask(db, { id, input: input(), now: 1 });

    const other = createDatabase({ path });
    try {
      other.sqlite.exec('BEGIN IMMEDIATE');
      sqlite.pragma('busy_timeout = 0');
      assert.throws(
        () => transitionTask(db, { id, action: 'queue', now: 2 }),
        /SQLITE_BUSY|locked/,
      );
      other.sqlite.exec('COMMIT');
      sqlite.pragma('busy_timeout = 5000');
      assert.equal(transitionTask(db, { id, action: 'queue', now: 3 }).queuedAt, 3);
    } finally {
      other.close();
    }
  });
});

test('rolls a transition back with the enclosing transaction', () => {
  withDatabase(({ db }) => {
    const id = taskId(1);
    createTask(db, { id, input: input(), now: 1 });
    transitionTask(db, { id, action: 'queue', now: 2 });
    assert.throws(
      () =>
        db.transaction((tx) => {
          assert.equal(transitionTask(tx, { id, action: 'start', now: 3 }).status, 'in_progress');
          throw new Error('Capacity reservation failed');
        }),
      /Capacity reservation failed/,
    );
    assert.equal(findTaskById(db, id)?.status, 'queued');
  });
});

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

test('upgrades a project-only database without touching existing projects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-tasks-upgrade-'));
  try {
    // Recreate the previous migration history: only 0000_foundation and 0001_projects.
    const previous = join(directory, 'migrations');
    cpSync(migrationsFolder, previous, { recursive: true });
    const journalPath = join(previous, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter(
      ({ tag }) => tag === '0000_foundation' || tag === '0001_projects',
    );
    assert.equal(journal.entries.length, 2);
    writeFileSync(journalPath, JSON.stringify(journal));

    const path = join(directory, 'database.sqlite');
    const connection = createDatabase({ path });
    try {
      migrate(connection.db, { migrationsFolder: previous });
      // Raw SQL: the current Drizzle schema has columns that the old schema does not.
      const old = project(projectA, 'website');
      connection.sqlite
        .prepare(
          'INSERT INTO projects (id, name, local_path, git_common_dir, remote_name, default_base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          old.id,
          old.name,
          old.localPath,
          old.gitCommonDir,
          old.remoteName,
          old.defaultBaseBranch,
          old.createdAt,
          old.updatedAt,
        );
      const tableExists = connection.sqlite.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
      );
      assert.equal(tableExists.get(), undefined);

      applyMigrations(connection);
      assert.notEqual(tableExists.get(), undefined);
      assert.deepEqual(findProjectById(connection.db, projectA), {
        ...old,
        priority: 0,
        instructions: '',
        // Added by 0003_execution with safe defaults: no project is trusted by an upgrade.
        executionTrust: 'none',
        executionTrustedCommonDir: null,
        executionTrustedAt: null,
      });
      assert.equal(
        connection.sqlite
          .prepare('SELECT count(*) AS count FROM __drizzle_migrations')
          .pluck()
          .get(),
        9,
      );
      assert.deepEqual(connection.sqlite.pragma('foreign_key_check'), []);
      assert.deepEqual(
        connection.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND sql IS NOT NULL ORDER BY name",
          )
          .pluck()
          .all(),
        ['tasks_project_id_status_idx', 'tasks_status_queued_at_idx'],
      );
      assert.equal(
        createTask(connection.db, { id: taskId(1), input: input(), now: 1 }).status,
        'backlog',
      );
    } finally {
      connection.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
