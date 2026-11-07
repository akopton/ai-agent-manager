import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ConversationError,
  conversationMessageMaxLength,
  conversationMessageSchema,
  conversationSchema,
  type ConversationErrorCode,
} from '@ai-agent-manager/core';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  addConversationNote,
  countConversationsByProject,
  createConversation,
  createDatabase,
  applyMigrations,
  deleteProject,
  findProjectConversation,
  insertProject,
  listConversationMessages,
  listProjectConversations,
  ProjectHasDependentsError,
  updateConversation,
  type DatabaseConnection,
  type NewProjectRecord,
} from '../src/index.js';

const projectA = '00000000-0000-4000-8000-00000000000a';
const projectB = '00000000-0000-4000-8000-00000000000b';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const conversationA = id(101);
const conversationB = id(102);

const project = (projectId: string, name: string): NewProjectRecord => ({
  id: projectId,
  name,
  localPath: `/repos/${name}`,
  gitCommonDir: `/repos/${name}/.git`,
  remoteName: 'origin',
  defaultBaseBranch: 'main',
  createdAt: 1_000,
  updatedAt: 1_000,
});

const withDatabase = (run: (connection: DatabaseConnection, path: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-conversations-'));
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

const throwsConversationError = (run: () => unknown, code: ConversationErrorCode): void => {
  assert.throws(run, (error: unknown) => error instanceof ConversationError && error.code === code);
};

const scopeA = { projectId: projectA, conversationId: conversationA };

const createA = (db: DatabaseConnection['db']) =>
  createConversation(db, {
    id: conversationA,
    input: { projectId: projectA, title: 'Auth redesign' },
    now: 2_000,
  });

const note = (
  db: DatabaseConnection['db'],
  n: number,
  content: string,
  scope = scopeA,
  now = 3_000 + n,
) =>
  addConversationNote(db, {
    scope,
    id: id(500 + n),
    input: { requestId: id(900 + n), content },
    now,
  });

const countRows = (db: DatabaseConnection['db'], table: string): number =>
  db.get<{ count: number }>(sql`SELECT count(*) AS count FROM ${sql.identifier(table)}`)?.count ??
  -1;

test('creates a conversation with defaults and an empty history', () => {
  withDatabase(({ db }) => {
    const created = createA(db);
    assert.deepEqual(conversationSchema.parse(created), {
      id: conversationA,
      projectId: projectA,
      title: 'Auth redesign',
      agentRuntime: 'claude',
      modelId: null,
      languageMode: 'pl_technical_en',
      revision: 1,
      createdAt: 2_000,
      updatedAt: 2_000,
      lastMessageAt: null,
    });
    assert.deepEqual(listConversationMessages(db, scopeA), []);
  });
});

test('stores explicit settings and rejects invalid input or an unknown project', () => {
  withDatabase(({ db }) => {
    const created = createConversation(db, {
      id: conversationA,
      input: {
        projectId: projectA,
        title: 'Plan',
        agentRuntime: 'codex',
        modelId: ' gpt-example ',
        languageMode: 'en',
      },
      now: 1,
    });
    assert.equal(created.agentRuntime, 'codex');
    assert.equal(created.modelId, 'gpt-example');
    assert.equal(created.languageMode, 'en');

    throwsConversationError(
      () =>
        createConversation(db, {
          id: id(1),
          input: { projectId: projectA, title: 'T', languageMode: 'de' as 'en' },
          now: 1,
        }),
      'invalid_conversation_input',
    );
    throwsConversationError(
      () =>
        createConversation(db, { id: 'nope', input: { projectId: projectA, title: 'T' }, now: 1 }),
      'invalid_conversation_input',
    );
    throwsConversationError(
      () =>
        createConversation(db, { id: id(2), input: { projectId: id(999), title: 'T' }, now: 1 }),
      'project_not_found',
    );
    assert.equal(countRows(db, 'conversations'), 1);
  });
});

test('never returns a conversation or its messages through another project', () => {
  withDatabase(({ db }) => {
    createA(db);
    note(db, 1, 'Private note of project A');
    const wrongScope = { projectId: projectB, conversationId: conversationA };

    assert.equal(findProjectConversation(db, wrongScope), undefined);
    assert.equal(listConversationMessages(db, wrongScope), undefined);
    assert.deepEqual(listProjectConversations(db, projectB), []);
    throwsConversationError(
      () =>
        updateConversation(db, { scope: wrongScope, input: { revision: 1, title: 'X' }, now: 1 }),
      'conversation_not_found',
    );
    throwsConversationError(() => note(db, 2, 'Injected', wrongScope), 'conversation_not_found');
    throwsConversationError(
      () => note(db, 3, 'Malformed', { projectId: 'x', conversationId: conversationA }),
      'conversation_not_found',
    );
    assert.equal(findProjectConversation(db, scopeA)?.title, 'Auth redesign');
    assert.equal(listConversationMessages(db, scopeA)?.length, 1);
  });
});

test('lists a project conversations newest first with message counts', () => {
  withDatabase(({ db }) => {
    createA(db);
    createConversation(db, {
      id: conversationB,
      input: { projectId: projectA, title: 'Test strategy' },
      now: 2_500,
    });
    createConversation(db, { id: id(103), input: { projectId: projectB, title: 'API' }, now: 1 });
    assert.deepEqual(
      listProjectConversations(db, projectA).map(({ title, messageCount }) => [
        title,
        messageCount,
      ]),
      [
        ['Test strategy', 0],
        ['Auth redesign', 0],
      ],
    );
    note(db, 1, 'First');
    note(db, 2, 'Second');
    assert.deepEqual(
      listProjectConversations(db, projectA).map(({ title, messageCount }) => [
        title,
        messageCount,
      ]),
      [
        ['Auth redesign', 2],
        ['Test strategy', 0],
      ],
    );
    assert.deepEqual(
      countConversationsByProject(db).sort((a, b) => a.projectId.localeCompare(b.projectId)),
      [
        { projectId: projectA, count: 2, lastUpdatedAt: 3_002 },
        { projectId: projectB, count: 1, lastUpdatedAt: 1 },
      ],
    );
  });
});

test('updates settings with a revision check and resets the model when the runtime changes', () => {
  withDatabase(({ db }) => {
    createA(db);
    const first = updateConversation(db, {
      scope: scopeA,
      input: { revision: 1, title: ' Auth v2 ', modelId: 'claude-example', languageMode: 'pl' },
      now: 5_000,
    });
    assert.equal(first.title, 'Auth v2');
    assert.equal(first.modelId, 'claude-example');
    assert.equal(first.languageMode, 'pl');
    assert.equal(first.revision, 2);
    assert.equal(first.updatedAt, 5_000);
    assert.equal(first.createdAt, 2_000);

    // A stale tab still holds revision 1: nothing is written.
    throwsConversationError(
      () => updateConversation(db, { scope: scopeA, input: { revision: 1, title: 'Old' }, now: 6 }),
      'conversation_changed',
    );
    assert.equal(findProjectConversation(db, scopeA)?.title, 'Auth v2');

    const switched = updateConversation(db, {
      scope: scopeA,
      input: { revision: 2, agentRuntime: 'codex' },
      now: 6_000,
    });
    assert.equal(switched.agentRuntime, 'codex');
    assert.equal(switched.modelId, null);
    assert.equal(switched.revision, 3);

    throwsConversationError(
      () => updateConversation(db, { scope: scopeA, input: { revision: 3 }, now: 7 }),
      'invalid_conversation_input',
    );
    throwsConversationError(
      () =>
        updateConversation(db, {
          scope: scopeA,
          input: { revision: 3, agentRuntime: 'gemini' as 'codex' },
          now: 7,
        }),
      'invalid_conversation_input',
    );
  });
});

test('saves notes in a deterministic order and keeps history after the database is reopened', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-conversations-reopen-'));
  const path = join(directory, 'database.sqlite');
  try {
    const first = createDatabase({ path });
    try {
      applyMigrations(first);
      insertProject(first.db, project(projectA, 'website'));
      createA(first.db);
      // Identical timestamps must not make the order ambiguous.
      note(first.db, 1, 'Zażółć gęślą jaźń — first', scopeA, 4_000);
      note(first.db, 2, '# Second\n\n- `item`', scopeA, 4_000);
      note(first.db, 3, 'third', scopeA, 3_999);
    } finally {
      first.close();
    }

    const second = createDatabase({ path });
    try {
      const messages = listConversationMessages(second.db, scopeA) ?? [];
      assert.deepEqual(
        messages.map(({ sequence, role, kind, content }) => [sequence, role, kind, content]),
        [
          [1, 'user', 'note', 'Zażółć gęślą jaźń — first'],
          [2, 'user', 'note', '# Second\n\n- `item`'],
          [3, 'user', 'note', 'third'],
        ],
      );
      for (const message of messages) {
        conversationMessageSchema.parse(message);
      }
      const conversation = findProjectConversation(second.db, scopeA);
      assert.equal(conversation?.lastMessageAt, 3_999);
      assert.equal(conversation?.revision, 1, 'notes do not change the settings revision');
    } finally {
      second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects empty, oversized and invalid notes without writing anything', () => {
  withDatabase(({ db }) => {
    createA(db);
    for (const content of ['', '   \n\t', 'a\0b', 'x'.repeat(conversationMessageMaxLength + 1)]) {
      throwsConversationError(() => note(db, 1, content), 'invalid_conversation_input');
    }
    throwsConversationError(
      () =>
        addConversationNote(db, {
          scope: scopeA,
          id: id(1),
          input: { requestId: 'not-a-uuid', content: 'x' },
          now: 1,
        }),
      'invalid_conversation_input',
    );
    throwsConversationError(
      () =>
        addConversationNote(db, {
          scope: scopeA,
          id: id(1),
          input: { requestId: id(2), content: 'x', role: 'assistant' } as never,
          now: 1,
        }),
      'invalid_conversation_input',
    );
    assert.equal(countRows(db, 'conversation_messages'), 0);
    assert.equal(findProjectConversation(db, scopeA)?.updatedAt, 2_000);
  });
});

test('deduplicates a repeated request and rejects a reused request ID for other content', () => {
  withDatabase(({ db }) => {
    createA(db);
    createConversation(db, {
      id: conversationB,
      input: { projectId: projectA, title: 'Other' },
      now: 1,
    });
    const first = note(db, 1, 'Only once');
    assert.equal(first.created, true);
    const repeated = addConversationNote(db, {
      scope: scopeA,
      id: id(777),
      input: { requestId: id(901), content: '  Only once \n' },
      now: 9_999,
    });
    assert.equal(repeated.created, false);
    assert.equal(repeated.message.id, first.message.id);
    assert.equal(countRows(db, 'conversation_messages'), 1);

    throwsConversationError(
      () =>
        addConversationNote(db, {
          scope: scopeA,
          id: id(778),
          input: { requestId: id(901), content: 'Different' },
          now: 1,
        }),
      'conversation_request_conflict',
    );
    throwsConversationError(
      () =>
        addConversationNote(db, {
          scope: { projectId: projectA, conversationId: conversationB },
          id: id(779),
          input: { requestId: id(901), content: 'Only once' },
          now: 1,
        }),
      'conversation_request_conflict',
    );
    assert.equal(countRows(db, 'conversation_messages'), 1);
  });
});

test('database constraints reject unknown roles, kinds, settings and notes without a request', () => {
  withDatabase(({ db }) => {
    createA(db);
    const insertMessage = (role: string, kind: string, requestId: string | null) =>
      db.run(sql`INSERT INTO conversation_messages
        (id, conversation_id, sequence, role, kind, content, request_id, created_at)
        VALUES (${id(Math.floor(Math.random() * 1e9))}, ${conversationA}, 1, ${role}, ${kind}, 'x', ${requestId}, 1)`);
    assert.throws(() => insertMessage('system', 'note', id(1)));
    assert.throws(() => insertMessage('user', 'reply', id(1)));
    assert.throws(() => insertMessage('assistant', 'note', id(1)));
    assert.throws(() => insertMessage('user', 'note', null));
    assert.throws(() =>
      db.run(sql`INSERT INTO conversation_messages
        (id, conversation_id, sequence, role, kind, content, request_id, created_at)
        VALUES (${id(5)}, ${id(999)}, 1, 'user', 'note', 'x', ${id(6)}, 1)`),
    );
    assert.throws(() =>
      db.run(sql`UPDATE conversations SET language_mode = 'de' WHERE id = ${conversationA}`),
    );
    assert.throws(() =>
      db.run(sql`UPDATE conversations SET agent_runtime = 'gemini' WHERE id = ${conversationA}`),
    );
    note(db, 1, 'one');
    assert.throws(
      () =>
        db.run(sql`INSERT INTO conversation_messages
          (id, conversation_id, sequence, role, kind, content, request_id, created_at)
          VALUES (${id(7)}, ${conversationA}, 1, 'user', 'note', 'dup', ${id(8)}, 1)`),
      (error: unknown) => error instanceof Error && /UNIQUE/.test(String(error.cause)),
    );
  });
});

test('a project with conversations cannot be disconnected', () => {
  withDatabase(({ db }) => {
    createA(db);
    assert.throws(
      () => deleteProject(db, projectA),
      (error: unknown) =>
        error instanceof ProjectHasDependentsError &&
        error.dependents.some(({ table }) => table === 'conversations'),
    );
    assert.notEqual(findProjectConversation(db, scopeA), undefined);
  });
});

test('conversation commands never touch task, execution, review or publication records', () => {
  withDatabase(({ db }) => {
    const tables = [
      'tasks',
      'task_runs',
      'worker_commands',
      'workspaces',
      'reviews',
      'publications',
      'git_operations',
      'task_recoveries',
      'workspace_cleanups',
      'run_events',
    ];
    const before = tables.map((table) => countRows(db, table));
    createA(db);
    note(db, 1, 'Please implement the login form and push it.');
    updateConversation(db, {
      scope: scopeA,
      input: { revision: 1, agentRuntime: 'codex' },
      now: 9,
    });
    assert.deepEqual(
      tables.map((table) => countRows(db, table)),
      before,
    );
  });
});

test('adds the conversation tables additively to a database migrated before C1', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-conversations-upgrade-'));
  const migrations = mkdtempSync(join(tmpdir(), 'ai-agent-manager-conversations-migrations-'));
  try {
    // Replay only the migrations that existed before C1 (later ones depend on it), then upgrade.
    const source = fileURLToPath(new URL('../migrations/', import.meta.url));
    cpSync(source, migrations, { recursive: true });
    const journalPath = join(migrations, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter(({ tag }) => tag < '0008_conversations');
    writeFileSync(journalPath, JSON.stringify(journal));
    assert.ok(readdirSync(migrations).includes('0008_conversations.sql'));

    const connection = createDatabase({ path: join(directory, 'database.sqlite') });
    try {
      migrate(connection.db, { migrationsFolder: migrations });
      insertProject(connection.db, project(projectA, 'website'));
      const tasksBefore = connection.db.all(
        sql`SELECT sql FROM sqlite_master WHERE name = 'tasks'`,
      );
      applyMigrations(connection);
      assert.deepEqual(
        connection.db.all(sql`SELECT sql FROM sqlite_master WHERE name = 'tasks'`),
        tasksBefore,
      );
      createA(connection.db);
      note(connection.db, 1, 'After upgrade');
      assert.equal(listConversationMessages(connection.db, scopeA)?.length, 1);
    } finally {
      connection.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(migrations, { recursive: true, force: true });
  }
});
