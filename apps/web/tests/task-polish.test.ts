import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { taskActions, taskStatuses, taskTransitions } from '@ai-agent-manager/core';

import { LifecycleButton } from '@/components/tasks/lifecycle-button';
import { TaskBoard } from '@/components/tasks/task-board';
import { TaskEditLink } from '@/components/tasks/task-edit-link';
import { TaskHeader } from '@/components/tasks/task-header';
import { TaskOrigin } from '@/components/tasks/task-origin';
import { taskEditability } from '@/lib/tasks/actions';

const projectId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';

test('lifecycle controls use their domain destination and share the actual column indicator token', () => {
  const board = render(createElement(TaskBoard, { tasks: [], projectDefaultBranch: 'main' }));
  for (const action of taskActions) {
    const status = taskTransitions[action].to;
    const html = render(createElement(LifecycleButton, { action, disabled: true }, action));
    assert.ok(html.includes(`data-destination-status="${status}"`));
    const style = /style="([^"]+)"/.exec(html)?.[1];
    assert.ok(style);
    assert.ok(board.includes(`data-task-status="${status}" style="${style}"`));
    assert.ok(html.includes('disabled=""'));
    assert.ok(html.includes('focus-visible:'));
    assert.ok(
      html.includes(
        `data-variant="${action === 'stop' || action === 'discard' ? 'destructive' : 'lifecycle'}"`,
      ),
    );
    assert.doesNotMatch(style, /primary|accent/);
  }
});

test('lower Edit access uses the same restrictions as the header for every status', () => {
  for (const status of taskStatuses) {
    const editability = taskEditability(status);
    const html = render(createElement(TaskEditLink, { projectId, taskId, editability }));
    assert.equal(html.includes('/edit'), editability.content || editability.priority);
    if (editability.priority && !editability.content) assert.match(html, /Change priority/);
  }
  assert.equal(
    render(
      createElement(TaskEditLink, {
        projectId,
        taskId,
        editability: { content: false, priority: false },
      }),
    ),
    '',
  );
  const page = readFileSync(
    new URL('../app/projects/[projectId]/tasks/[taskId]/page.tsx', import.meta.url),
    'utf8',
  );
  assert.equal(page.match(/<TaskEditLink/g)?.length, 2);
  assert.ok(page.lastIndexOf('<TaskEditLink') > page.indexOf('{task.prompt}'));
});

test('origin links the exact reply, bounds plain historical text and handles unavailable sources', () => {
  const origin = {
    conversationId: taskId,
    conversationTitle: 'Planning',
    sourceMessageId: projectId,
    excerpt: '<script>alert(1)</script>' + 'x'.repeat(700) + 'END-MARKER',
  };
  const html = render(createElement(TaskOrigin, { projectId, origin }));
  assert.ok(html.includes(`/conversations/${taskId}#message-${projectId}`));
  assert.match(html, /Historical conversation content/);
  assert.doesNotMatch(html, /END-MARKER|<script>/);
  const legacy = render(
    createElement(TaskOrigin, {
      projectId,
      origin: { ...origin, sourceMessageId: null, excerpt: null },
    }),
  );
  assert.match(legacy, /Open conversation/);
  assert.doesNotMatch(legacy, /#message-/);
  const unavailable = render(
    createElement(TaskOrigin, {
      projectId,
      origin: { ...origin, conversationTitle: null, sourceMessageId: null, excerpt: null },
    }),
  );
  assert.match(unavailable, /no longer available/);
  assert.doesNotMatch(unavailable, /href=/);
});

test('task header separates long identity content from a dedicated responsive action column', () => {
  for (const title of ['Short task', 'A deliberately long task title '.repeat(8)]) {
    for (const count of [1, 3, 5]) {
      const html = render(
        createElement(TaskHeader, {
          title,
          badges: 'Status and metadata',
          actions: Array.from({ length: count }, (_, index) =>
            createElement(
              'button',
              { key: index, disabled: index === 0 },
              index === 0 ? 'Return to Backlog' : 'Start execution',
            ),
          ),
        }),
      );
      assert.match(html, /grid-cols-1/);
      assert.match(html, /lg:grid-cols-\[minmax\(0,1fr\)_24rem\]/);
      assert.match(html, /data-task-header-actions="true" aria-label="Task actions" role="group"/);
      assert.ok(html.indexOf('</h1>') < html.indexOf('data-task-header-actions'));
      assert.equal(html.match(/<button/g)?.length, count);
      assert.match(html, /lg:min-h-40/);
    }
  }
});
