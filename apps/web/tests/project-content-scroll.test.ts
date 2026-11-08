import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjectContentScroll } from '@/lib/projects/content-scroll';

const setup = (scrollHeight = 2000) => {
  const viewport = { scrollTop: 0, scrollHeight, clientHeight: 500 };
  const saved: number[] = [];
  return {
    viewport,
    saved,
    scroll: createProjectContentScroll(viewport, (top) => saved.push(top)),
  };
};

test('a new page stops restoring once top is reached, so late mutations cannot pull readers up', () => {
  const { viewport, scroll } = setup();
  scroll.restore(0, '', null);
  viewport.scrollTop = 700;
  // A mutation may be delivered before the queued browser scroll event.
  scroll.sync(null);
  assert.equal(viewport.scrollTop, 700);
  scroll.onScroll();
  scroll.sync(null);
  assert.equal(viewport.scrollTop, 700);
});

test('restoration waits through short loading content and then yields to the operator', () => {
  const { viewport, saved, scroll } = setup(500);
  scroll.restore(450, '', null);
  assert.equal(viewport.scrollTop, 0);
  assert.equal(saved.at(-1), 450);
  scroll.onScroll();
  viewport.scrollHeight = 2000;
  scroll.sync(null);
  assert.equal(viewport.scrollTop, 450);
  scroll.onScroll();
  viewport.scrollTop = 700;
  scroll.onScroll();
  viewport.scrollHeight = 3000;
  scroll.sync(null);
  assert.equal(viewport.scrollTop, 700);
  assert.equal(saved.at(-1), 700);
});

test('explicit anchors wait for streamed targets and track layout only until user scrolling', () => {
  const { viewport, scroll } = setup();
  scroll.restore(0, '#source-sharing', null);
  scroll.sync(900);
  assert.equal(viewport.scrollTop, 900);
  scroll.onScroll();
  scroll.sync(1000);
  assert.equal(viewport.scrollTop, 1000);
  scroll.onScroll();
  viewport.scrollTop = 800;
  scroll.onScroll();
  scroll.sync(1100);
  assert.equal(viewport.scrollTop, 800);
});
