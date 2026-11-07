import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatScrollController, isNearChatBottom } from '@/lib/conversations/chat-scroll';

const fixture = () => {
  const viewport = { scrollTop: 0, scrollHeight: 2400, clientHeight: 400 };
  const controller = createChatScrollController(viewport);
  const sync = (options: Partial<Parameters<typeof controller.sync>[0]> = {}) =>
    controller.sync({ active: true, hash: '', anchorTop: null, ...options });
  const userScroll = (top: number) => {
    viewport.scrollTop = top;
    controller.onScroll();
  };
  return { viewport, controller, sync, userScroll };
};

test('initial Chat opens at the latest content and another conversation starts independently', () => {
  const first = fixture();
  first.sync();
  assert.equal(first.viewport.scrollTop, 2000);
  first.userScroll(100);
  first.sync();
  assert.equal(first.viewport.scrollTop, 100);
  const second = fixture();
  second.sync();
  assert.equal(second.viewport.scrollTop, 2000);
  assert.equal(first.viewport.scrollTop, 100);
});

test('bottom following uses a 96px threshold and preserves reading older messages', () => {
  const { viewport, sync, userScroll } = fixture();
  sync();
  userScroll(1904);
  assert.equal(isNearChatBottom(viewport), true);
  viewport.scrollHeight += 600;
  sync();
  assert.equal(viewport.scrollTop, 2600);
  userScroll(2503);
  assert.equal(isNearChatBottom(viewport), false);
  viewport.scrollHeight += 600;
  sync();
  assert.equal(viewport.scrollTop, 2503);
});

test('successful outgoing chat resumes following; scrolling upward before the reply cancels it', () => {
  const { viewport, controller, sync, userScroll } = fixture();
  sync({ hash: '#message-old', anchorTop: 100 });
  controller.followLatest();
  assert.equal(viewport.scrollTop, 2000);
  viewport.scrollHeight += 200;
  sync({ hash: '#message-old', anchorTop: 100 });
  assert.equal(viewport.scrollTop, 2200);
  userScroll(700);
  viewport.scrollHeight += 800;
  sync({ hash: '#message-old', anchorTop: 100 });
  assert.equal(viewport.scrollTop, 700);
});

test('an older message anchor wins on opening and stays aligned through delayed layout', () => {
  const { viewport, controller, sync, userScroll } = fixture();
  sync({ hash: '#message-old', anchorTop: 300 });
  assert.equal(viewport.scrollTop, 300);
  controller.onScroll(); // The event from our programmatic anchor positioning is not user intent.
  viewport.scrollHeight += 500;
  sync({ hash: '#message-old', anchorTop: 500 });
  assert.equal(viewport.scrollTop, 500);
  userScroll(650);
  sync({ hash: '#message-old', anchorTop: 550 });
  assert.equal(
    viewport.scrollTop,
    650,
    'polling must not reapply a handled anchor after user scrolling',
  );
  sync({ hash: '#message-another', anchorTop: 100 });
  assert.equal(viewport.scrollTop, 100, 'a deliberate different anchor still navigates');
});

test('an initially unavailable fragment suppresses bottom following until its target renders', () => {
  const { viewport, sync } = fixture();
  sync({ hash: '#message-old' });
  assert.equal(viewport.scrollTop, 0);
  sync({ hash: '#message-old', anchorTop: 400 });
  assert.equal(viewport.scrollTop, 400);
});

test('Tasks/Notes transitions retain reading position despite hidden zero geometry and new replies', () => {
  const { viewport, controller, sync, userScroll } = fixture();
  sync();
  userScroll(450);
  sync({ active: false });
  viewport.clientHeight = 0;
  viewport.scrollTop = 0;
  controller.onScroll();
  viewport.scrollHeight += 800;
  sync({ active: false });
  viewport.clientHeight = 400;
  sync();
  assert.equal(viewport.scrollTop, 450);
  userScroll(viewport.scrollHeight - viewport.clientHeight);
  sync({ active: false });
  viewport.scrollHeight += 300;
  sync();
  assert.equal(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight);
});

test('initial Notes or hidden loading defers positioning until Chat actually has dimensions', () => {
  const { viewport, sync } = fixture();
  viewport.clientHeight = 0;
  assert.equal(sync(), false);
  assert.equal(viewport.scrollTop, 0);
  viewport.clientHeight = 400;
  assert.equal(sync({ active: false }), false);
  assert.equal(viewport.scrollTop, 0);
  assert.equal(sync(), true);
  assert.equal(viewport.scrollTop, 2000);
});

test('idle polling does not repeatedly write scrollTop or move reading position', () => {
  let top = 0;
  let writes = 0;
  const viewport = {
    scrollHeight: 2400,
    clientHeight: 400,
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = value;
      writes += 1;
    },
  };
  const controller = createChatScrollController(viewport);
  const update = () => controller.sync({ active: true, hash: '', anchorTop: null });
  update();
  controller.onScroll();
  for (let i = 0; i < 20; i += 1) update();
  assert.equal(writes, 1);
  viewport.scrollTop = 400;
  controller.onScroll();
  for (let i = 0; i < 20; i += 1) update();
  assert.equal(writes, 2);
  assert.equal(top, 400);
});
