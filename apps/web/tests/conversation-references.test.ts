import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferencePreviews } from '@/components/conversations/conversation-references';
import { resolveConversationTab } from '@/lib/conversations/workspace';

test('shared reference previews expose bounded text, source anchors and labelled removal', () => {
  const sourceId = '00000000-0000-4000-8000-000000000001';
  const references = [
    { sourceId, role: 'user', kind: 'note', preview: '<instructions>quoted note</instructions>' },
    {
      sourceId: sourceId.replace(/1$/, '2'),
      role: 'assistant',
      kind: 'chat',
      preview: 'Earlier reply',
    },
  ] as const;
  const html = renderToStaticMarkup(
    createElement(ReferencePreviews, { references, onRemove: () => {} }),
  );
  assert.match(html, /aria-label="Selected references"/);
  assert.match(html, /tab=notes#note-/);
  assert.match(html, /tab=chat#message-/);
  assert.match(html, /&lt;instructions&gt;quoted note/);
  assert.match(html, /aria-label="Remove reference to saved note"/);
  assert.match(html, /aria-label="Remove reference to AI reply"/);
  const sent = renderToStaticMarkup(createElement(ReferencePreviews, { references }));
  assert.match(sent, /aria-label="Sent references"/);
  assert.doesNotMatch(sent, /<button/);
  assert.equal(resolveConversationTab('chat', `#note-${sourceId}`), 'notes');
});

test('historical references retain snapshot text while unavailable sources lose their live links', () => {
  const html = renderToStaticMarkup(
    createElement(ReferencePreviews, {
      references: [
        {
          sourceId: '00000000-0000-4000-8000-000000000001',
          role: 'user',
          kind: 'note',
          preview: 'Original snapshot survives deletion',
          sourceAvailable: false,
        },
      ],
    }),
  );
  assert.match(html, /Source unavailable · Snapshot retained/);
  assert.match(html, /Original snapshot survives deletion/);
  assert.doesNotMatch(html, /href=/);
  const unsent = renderToStaticMarkup(
    createElement(ReferencePreviews, {
      references: [
        {
          sourceId: '00000000-0000-4000-8000-000000000001',
          role: 'user',
          kind: 'note',
          preview: 'Local selection',
          sourceAvailable: false,
        },
      ],
      onRemove: () => {},
    }),
  );
  assert.match(unsent, /Remove before sending/);
  assert.doesNotMatch(unsent, /Snapshot retained/);
});
