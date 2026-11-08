type ContentViewport = {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
};

/** Local project-page restoration, including targets that arrive after a streamed loading state. */
export const createProjectContentScroll = (
  viewport: ContentViewport,
  rememberPosition: (top: number) => void,
) => {
  let restoring = false;
  let fragment = '';
  let savedTop = 0;
  let expectedTop: number | null = null;

  const sync = (anchorTop: number | null) => {
    if (!restoring) return;
    const target = anchorTop ?? savedTop;
    viewport.scrollTop = Math.max(
      0,
      Math.min(target, viewport.scrollHeight - viewport.clientHeight),
    );
    expectedTop = viewport.scrollTop;
    // Retain the desired position if streamed content is temporarily too short.
    rememberPosition(target);
    if (!fragment && Math.abs(viewport.scrollTop - target) <= 1) restoring = false;
  };

  const restore = (top: number, hash: string, anchorTop: number | null) => {
    savedTop = top;
    fragment = hash;
    restoring = true;
    sync(anchorTop);
  };

  const onScroll = () => {
    if (expectedTop !== null && Math.abs(viewport.scrollTop - expectedTop) <= 1) {
      expectedTop = null;
      return;
    }
    expectedTop = null;
    restoring = false;
    rememberPosition(viewport.scrollTop);
  };

  return { restore, sync, onScroll };
};
