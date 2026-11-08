import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { WorkspaceContent } from '@/components/workspace-content';
import { PageContent } from '@/components/page-content';
import { ProjectContent, projectContentWidth } from '@/components/projects/project-content';
import {
  isProjectConversationsPath,
  isProjectWorkspacePath,
  pageGutterClassName,
} from '@/lib/layout';

const root = '/projects/00000000-0000-4000-8000-000000000001';

test('all routes share outer geometry while project forms limit only internal content', () => {
  for (const [path, width] of [
    [root, 'workspace'],
    [`${root}/board`, 'workspace'],
    [`${root}/conversations`, 'workspace'],
    [`${root}/conversations/new`, 'workspace'],
    [`${root}/conversations/topic`, 'workspace'],
    [`${root}/tasks/task`, 'reading'],
    [`${root}/tasks/task/edit`, 'reading'],
    [`${root}/tasks/task/review`, 'reading'],
    [`${root}/tasks/new`, 'reading'],
    [`${root}/settings`, 'form'],
  ] as const) {
    assert.equal(projectContentWidth(path), width);
    assert.equal(isProjectWorkspacePath(path), true);
    assert.equal(isProjectConversationsPath(path), path.includes('/conversations'));
    const html = render(
      createElement(
        PathnameContext.Provider,
        { value: path },
        createElement(
          WorkspaceContent,
          null,
          createElement('header', null, 'Shared navigation'),
          createElement(ProjectContent, null, createElement('form', null, 'Content')),
        ),
      ),
    );
    const outer = html.slice(0, html.indexOf('>'));
    assert.match(outer, /id="main-content" tabindex="-1"/);
    assert.ok(outer.includes(pageGutterClassName));
    assert.doesNotMatch(outer, /max-w-/);
    assert.ok(html.includes(`data-content-width="${width}"`));
    assert.ok(html.indexOf('Shared navigation') < html.indexOf('data-content-width'));
    assert.match(html, /<form>Content<\/form>/);
    assert.match(outer, /md:overflow-hidden/);
    assert.ok(
      html.includes(
        `data-project-viewport="${path.includes('/conversations') ? 'conversation-panes' : 'page'}"`,
      ),
    );
    if (!path.includes('/conversations'))
      assert.match(html, /aria-label="Project content" tabindex="0"/);
  }
  const form = render(createElement(PageContent, { width: 'form' }, 'Global settings'));
  assert.match(form, /max-w-3xl/);
});

test('global registration and settings retain their own page scrolling outside the project shell', () => {
  for (const path of ['/', '/projects', '/projects/new', '/settings', '/conversations']) {
    assert.equal(isProjectWorkspacePath(path), false);
    const html = render(
      createElement(
        PathnameContext.Provider,
        { value: path },
        createElement(WorkspaceContent, null, 'Global content'),
      ),
    );
    assert.match(html, /md:overflow-y-auto/);
    assert.doesNotMatch(html, /md:overflow-hidden/);
  }
});
