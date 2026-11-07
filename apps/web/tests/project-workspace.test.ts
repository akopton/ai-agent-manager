import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  addConversationNote,
  createConversation,
  createTask,
  insertProject,
  listRecentProjects,
  setProjectSourceAccess,
  taskRuns,
  transitionTask,
  updateProject,
  workerCommands,
} from '@ai-agent-manager/database';
import { ProjectWorkspaceLinks } from '@/components/projects/project-workspace-nav';
import { RecentProjects } from '@/components/projects/recent-projects';
import { activeMainNavKey } from '@/lib/navigation';
import {
  activeProjectSection,
  projectWorkspaceLinks,
  readWorkspaceMemory,
  rememberWorkspaceLocation,
  workspaceMemoryKey,
} from '@/lib/projects/workspace-navigation';
import { createFixtureDirectory, createMigratedDatabase, removeFixtureDirectory } from './fixtures';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1);
const root = `/projects/${projectId}`;

test('workspace sections retain existing URLs and scope nested routes to their project', () => {
  for (const project of [projectId, id(2)]) {
    const base = `/projects/${project}`;
    assert.deepEqual(
      projectWorkspaceLinks(project).map((link) => link.href),
      [base, `${base}/board`, `${base}/conversations`, `${base}/settings`],
    );
    for (const [path, section] of [
      ['', 'overview'],
      ['/board', 'kanban'],
      ['/tasks/new', 'kanban'],
      [`/tasks/${id(3)}`, 'kanban'],
      [`/tasks/${id(3)}/edit`, 'kanban'],
      [`/tasks/${id(3)}/review`, 'kanban'],
      ['/conversations', 'conversations'],
      ['/conversations/new', 'conversations'],
      [`/conversations/${id(4)}`, 'conversations'],
      ['/settings', 'settings'],
      ['/edit', 'settings'],
    ] as const) {
      assert.equal(activeProjectSection(project, base + path), section);
      assert.equal(activeMainNavKey(base + path), 'projects');
      assert.equal(activeProjectSection(id(9), base + path), undefined);
    }
    assert.equal(activeProjectSection(project, `${base}/boardwalk`), undefined);
  }
  assert.equal(activeMainNavKey('/settings'), 'settings');
  assert.equal(activeMainNavKey('/conversations'), 'conversations');
});

test('workspace remembers board query and last conversation per project without replacing list URLs', () => {
  let memory = rememberWorkspaceLocation(
    projectId,
    {},
    `${root}/board`,
    'view=archived&filter=failed',
  );
  memory = rememberWorkspaceLocation(projectId, memory, `${root}/conversations/${id(4)}`, '');
  memory = rememberWorkspaceLocation(projectId, memory, `${root}/settings`, '');
  memory = rememberWorkspaceLocation(projectId, memory, `${root}/conversations`, '');
  memory = rememberWorkspaceLocation(projectId, memory, `${root}/conversations/new`, '');
  assert.equal(memory.board, `${root}/board?view=archived&filter=failed`);
  assert.equal(memory.conversation, `${root}/conversations/${id(4)}`);
  assert.deepEqual(readWorkspaceMemory(projectId, JSON.stringify(memory)), memory);
  const other = rememberWorkspaceLocation(id(2), {}, `/projects/${id(2)}/board`, '');
  assert.equal(other.board, `/projects/${id(2)}/board`);
  assert.notEqual(workspaceMemoryKey(projectId), workspaceMemoryKey(id(2)));
  assert.equal(projectWorkspaceLinks(projectId)[2].href, `${root}/conversations`);
});

test('corrupt, external, cross-project and non-detail browser destinations are rejected', () => {
  for (const stored of ['bad json', 'null', '[]', '{"board":4}']) {
    assert.deepEqual(readWorkspaceMemory(projectId, stored), {});
  }
  for (const destination of [
    'https://example.invalid',
    '//example.invalid',
    `/projects/${id(2)}/board`,
    `${root}/board/../settings`,
    `${root}/board#other`,
    `${root}/conversations/new`,
    `${root}/conversations/${id(4)}?other=1`,
    `${root}/conversations/${id(4)}/extra`,
  ]) {
    const memory = readWorkspaceMemory(
      projectId,
      JSON.stringify({ board: destination, conversation: destination }),
    );
    assert.equal(memory.board, undefined, destination);
    assert.equal(memory.conversation, undefined, destination);
  }
});

test('rendered navigation has one active accessible link, wraps and exposes keyboard focus', () => {
  const markup = renderToStaticMarkup(
    createElement(ProjectWorkspaceLinks, {
      projectId,
      pathname: `${root}/tasks/${id(3)}/review`,
      memory: {
        board: `${root}/board?view=archived`,
        conversation: `${root}/conversations/${id(4)}`,
      },
    }),
  );
  assert.equal((markup.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(markup, /Project workspace/);
  assert.match(
    markup,
    /<a(?=[^>]*href="[^"]+board\?view=archived")(?=[^>]*aria-current="page")[^>]*>/,
  );
  assert.match(markup, /flex-wrap/);
  assert.match(markup, /focus-visible:ring/);
  assert.match(markup, new RegExp(`href="${root}/conversations/${id(4)}"`));
});

test('settings consolidate validated controls; existing deep-link pages remain in place', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const settings = read('app/projects/[projectId]/settings/page.tsx');
  for (const component of ['EditProjectForm', 'ProjectTrustCard', 'ProjectSourceAccessCard']) {
    assert.match(settings, new RegExp(`<${component}`));
  }
  const global = read('app/settings/page.tsx');
  for (const component of [
    'AccentThemeSelector',
    'TrustedLocalSettings',
    'ConversationAiSettings',
  ]) {
    assert.match(global, new RegExp(`<${component}`));
    assert.doesNotMatch(settings, new RegExp(`<${component}`));
  }
  const conversation = read('app/projects/[projectId]/conversations/[conversationId]/page.tsx');
  assert.doesNotMatch(conversation, /<ProjectSourceAccessCard/);
  assert.match(conversation, /settings#source-sharing/);
  assert.match(conversation, /<ConversationHistory/);
  assert.match(conversation, /<MessageComposer/);
  assert.match(conversation, /<TaskProposalsPanel/);
  assert.match(read('app/projects/[projectId]/edit/page.tsx'), /redirect\(/);
  for (const path of ['page.tsx', 'edit/page.tsx', 'review/page.tsx']) {
    assert.ok(read(`app/projects/[projectId]/tasks/[taskId]/${path}`).length > 0);
  }
});

test('recent activity orders actual mutations, limits to two and never creates execution work', () => {
  const directory = createFixtureDirectory();
  const connection = createMigratedDatabase(directory);
  const { db } = connection;
  try {
    assert.deepEqual(listRecentProjects(db), []);
    for (const n of [1, 2, 3]) {
      insertProject(db, {
        id: id(n),
        name: `Project ${n}`,
        localPath: `/fixture/${n}`,
        gitCommonDir: `/fixture/${n}/.git`,
        defaultBaseBranch: 'main',
        createdAt: n * 100,
        updatedAt: n * 100,
      });
      if (n === 1) assert.equal(listRecentProjects(db).length, 1);
    }
    assert.deepEqual(
      listRecentProjects(db).map((p) => p.id),
      [id(3), id(2)],
    );
    updateProject(db, id(1), { name: 'Renamed' }, 400);
    assert.equal(listRecentProjects(db)[0]?.activity, 'Project settings updated');
    const task = createTask(db, {
      id: id(10),
      input: {
        projectId: id(2),
        title: 'Task',
        prompt: 'Fixture',
        agentRuntime: 'codex',
        modelId: null,
        baseBranch: null,
        priority: 'normal',
        urgent: false,
      },
      now: 500,
    });
    assert.equal(listRecentProjects(db)[0]?.activity, 'Task created');
    transitionTask(db, { id: task.id, action: 'queue', now: 600 });
    assert.equal(listRecentProjects(db)[0]?.activity, 'Task updated');
    const conversation = createConversation(db, {
      id: id(11),
      input: {
        projectId: id(3),
        title: 'Plan',
        agentRuntime: 'claude',
        modelId: null,
        languageMode: 'en',
        contextMode: 'general',
      },
      now: 700,
    });
    assert.equal(listRecentProjects(db)[0]?.activity, 'Conversation created');
    addConversationNote(db, {
      scope: { projectId: id(3), conversationId: conversation.id },
      id: id(12),
      input: { requestId: id(13), content: 'A local note' },
      now: 800,
    });
    assert.equal(listRecentProjects(db)[0]?.activity, 'Conversation updated');
    setProjectSourceAccess(db, { projectId: id(1), input: { access: 'none' }, now: 900 });
    assert.equal(listRecentProjects(db)[0]?.id, id(1));
    assert.equal(listRecentProjects(db)[0]?.activityAt, 900);
    // A finished run wins ties against the task's review transition at the same instant.
    db.insert(taskRuns)
      .values({
        id: id(14),
        taskId: task.id,
        attempt: 1,
        agentRuntime: 'codex',
        status: 'completed',
        securityMode: 'trusted_local',
        timeoutMs: 1000,
        workerInstanceId: 'fixture',
        createdAt: 500,
        updatedAt: 1000,
        endedAt: 1000,
      })
      .run();
    assert.equal(listRecentProjects(db)[0]?.activity, 'Task execution completed');
    const changes = () => connection.sqlite.prepare('SELECT total_changes() AS count').get();
    const before = changes();
    const recent = listRecentProjects(db);
    assert.deepEqual(listRecentProjects(db), recent);
    assert.deepEqual(changes(), before);
    assert.equal(db.select().from(workerCommands).all().length, 0);
    assert.equal(db.select().from(taskRuns).all().length, 1);
    assert.equal(recent.length, 2);
  } finally {
    connection.close();
    removeFixtureDirectory(directory);
  }
});

test('recent projects render empty/single/two states with workspace links and timestamps', () => {
  assert.match(
    renderToStaticMarkup(createElement(RecentProjects, { projects: [] })),
    /No projects yet/,
  );
  for (const count of [1, 2]) {
    const projects = Array.from({ length: count }, (_, i) => ({
      id: id(i + 1),
      name: `Project ${i}`,
      activity: 'Project added',
      activityAt: 1000,
    }));
    const html = renderToStaticMarkup(createElement(RecentProjects, { projects }));
    assert.equal((html.match(/<li /g) ?? []).length, count);
    assert.equal((html.match(/<time /g) ?? []).length, count);
    assert.match(html, new RegExp(`href="${root}"`));
  }
});
