export const chatBottomThreshold = 96;

type ScrollViewport = {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
};

export const isNearChatBottom = (viewport: ScrollViewport): boolean =>
  viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= chatBottomThreshold;

/** Local to one mounted conversation. No page scrolling, storage or conversation commands. */
export const createChatScrollController = (viewport: ScrollViewport) => {
  let initialized = false;
  let visible = false;
  let following = true;
  let savedTop = 0;
  let handledHash = '';
  let anchored = false;
  let expectedTop: number | null = null;

  const position = (top: number) => {
    const bounded = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight));
    if (Math.abs(viewport.scrollTop - bounded) > 1) {
      viewport.scrollTop = bounded;
      expectedTop = viewport.scrollTop;
    }
    savedTop = viewport.scrollTop;
  };

  const sync = ({
    active,
    hash,
    anchorTop,
  }: {
    active: boolean;
    hash: string;
    anchorTop: number | null;
  }): boolean => {
    if (!active || viewport.clientHeight === 0) {
      visible = false;
      return false;
    }
    const returning = !visible;
    visible = true;
    if (!initialized || hash !== handledHash) {
      if (!initialized) following = !hash;
      initialized = true;
      handledHash = hash;
      anchored = hash !== '';
      if (anchored) following = false;
    }
    if (anchored && anchorTop !== null) position(anchorTop);
    else if (following) position(viewport.scrollHeight);
    else if (returning) position(savedTop);
    return true;
  };

  const onScroll = () => {
    // Hidden panels can emit scroll events with zero geometry; retain their last real position.
    if (!visible || viewport.clientHeight === 0) return;
    if (expectedTop !== null && Math.abs(viewport.scrollTop - expectedTop) <= 1) {
      expectedTop = null;
      return;
    }
    expectedTop = null;
    savedTop = viewport.scrollTop;
    following = isNearChatBottom(viewport);
    anchored = false;
  };

  const followLatest = () => {
    anchored = false;
    following = true;
    if (visible) position(viewport.scrollHeight);
  };

  return { sync, onScroll, followLatest };
};

/** Offset in the transcript's own coordinate system; never scroll an ancestor. */
export const chatAnchorTop = (viewport: HTMLElement, hash: string): number | null => {
  if (!hash) return null;
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
  const target = document.getElementById(id);
  if (target === null || !viewport.contains(target)) return null;
  return (
    viewport.scrollTop +
    target.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top -
    viewport.clientTop -
    12
  );
};
