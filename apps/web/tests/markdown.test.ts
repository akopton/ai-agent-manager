import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkdown } from '@/lib/conversations/markdown';

// Markdown subset for AI replies: structure is parsed into data; nothing is treated as HTML.

test('parses code blocks, headings, lists, quotes and paragraphs', () => {
  const blocks = parseMarkdown(
    [
      '# Plan',
      '',
      'Intro with `code` and **bold** and *em*.',
      '',
      '- one',
      '- two',
      '',
      '3. three',
      '4. four',
      '',
      '> quoted',
      '',
      '```ts',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '',
      '---',
    ].join('\n'),
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['heading', 'paragraph', 'list', 'list', 'quote', 'code', 'rule'],
  );
  const code = blocks[5];
  assert.ok(code?.type === 'code');
  assert.equal(code.language, 'ts');
  assert.equal(code.text, 'const a = 1;\n\nconst b = 2;');
  const ordered = blocks[3];
  assert.ok(ordered?.type === 'list' && ordered.ordered);
  assert.equal(ordered.start, 3);
});

test('keeps unterminated code blocks and plain text intact', () => {
  const [block] = parseMarkdown('```\nno end');
  assert.ok(block?.type === 'code');
  assert.equal(block.text, 'no end');
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ type: 'text', text: '2 * 3 * 4' }]);
  assert.deepEqual(parseInline('snake_case_name'), [{ type: 'text', text: 'snake_case_name' }]);
});

test('only http(s) links become links; HTML stays text', () => {
  assert.deepEqual(parseInline('[docs](https://example.com/x)'), [
    { type: 'link', href: 'https://example.com/x', children: [{ type: 'text', text: 'docs' }] },
  ]);
  assert.deepEqual(parseInline('[x](javascript:alert(1))'), [
    { type: 'text', text: '[x](javascript:alert(1)' },
    { type: 'text', text: ')' },
  ]);
  const [paragraph] = parseMarkdown('<b>bold</b>');
  assert.deepEqual(paragraph, {
    type: 'paragraph',
    children: [{ type: 'text', text: '<b>bold</b>' }],
  });
});
