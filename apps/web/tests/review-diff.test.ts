import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { DiffView } from '@/components/review/diff-view';
import { parseUnifiedDiff } from '@/lib/review/diff';
import { describeFileChange, taskReviewDiffUrl } from '@/lib/review/format';
import type { ChangedFileView } from '@/lib/review/contracts';

const patch = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = <script>alert(1)</script>;',
  ' export { a };',
  '@@ -10,2 +11,2 @@ function tail() {',
  ' keep',
  '-old',
  '+new',
  '\\ No newline at end of file',
  '',
].join('\n');

test('parses hunks with old and new line numbers', () => {
  const parsed = parseUnifiedDiff(patch);
  assert.equal(parsed.meta.length, 4);
  assert.equal(parsed.hunks.length, 2);
  assert.equal(parsed.additions, 3);
  assert.equal(parsed.deletions, 2);
  assert.deepEqual(
    parsed.hunks[0]?.rows.map((row) => [row.type, row.oldLine, row.newLine, row.text]),
    [
      ['context', 1, 1, 'const a = 1;'],
      ['deletion', 2, null, 'const b = 2;'],
      ['addition', null, 2, 'const b = 3;'],
      ['addition', null, 3, 'const c = <script>alert(1)</script>;'],
      ['context', 3, 4, 'export { a };'],
    ],
  );
  assert.deepEqual(
    parsed.hunks[1]?.rows.map((row) => [row.type, row.oldLine, row.newLine]),
    [
      ['context', 10, 11],
      ['deletion', 11, null],
      ['addition', null, 12],
      ['note', null, null],
    ],
  );
});

test('handles new files, empty patches and mode-only changes', () => {
  const created = parseUnifiedDiff(
    'diff --git a/hello.txt b/hello.txt\nnew file mode 100644\n--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+Hello\n',
  );
  assert.deepEqual(created.hunks[0]?.rows, [
    { type: 'addition', oldLine: null, newLine: 1, text: 'Hello' },
  ]);
  assert.deepEqual(parseUnifiedDiff(''), { meta: [], hunks: [], additions: 0, deletions: 0 });
  const mode = parseUnifiedDiff('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n');
  assert.equal(mode.hunks.length, 0);
  assert.equal(mode.meta.length, 3);
});

test('renders diff text escaped, with line numbers and +/- markers', () => {
  const html = renderToStaticMarkup(createElement(DiffView, { patch }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /aria-label="Added line"/);
  assert.match(html, /aria-label="Removed line"/);
  assert.match(html, /@@ -10,2 \+11,2 @@/);
  const modeOnly = renderToStaticMarkup(
    createElement(DiffView, { patch: 'diff --git a/x b/x\nold mode 100644\nnew mode 100755\n' }),
  );
  assert.match(modeOnly, /new mode 100755/);
  assert.match(modeOnly, /No content lines changed/);
});

test('labels untracked files and encodes diff paths', () => {
  const file = { tracked: false, change: 'added' } as Pick<ChangedFileView, 'tracked' | 'change'>;
  assert.equal(describeFileChange(file as ChangedFileView), 'Untracked');
  assert.equal(describeFileChange({ ...file, tracked: true } as ChangedFileView), 'Added');
  assert.equal(
    taskReviewDiffUrl('p', 't', 'dir with space/a&b?.txt'),
    '/api/projects/p/tasks/t/review/diff?path=dir+with+space%2Fa%26b%3F.txt',
  );
});
