'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { PageContent } from '@/components/page-content';
import { chatAnchorTop as localAnchorTop } from '@/lib/conversations/chat-scroll';
import { isProjectConversationsPath, type ContentWidth } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { createProjectContentScroll } from '@/lib/projects/content-scroll';

export const projectContentWidth = (pathname: string): ContentWidth => {
  if (/\/projects\/[^/]+\/settings\/?$/.test(pathname)) return 'form';
  if (/\/projects\/[^/]+\/tasks(?:\/|$)/.test(pathname)) return 'reading';
  return 'workspace';
};

/** Standard pages scroll here. Conversations delegate to their existing individual panes. */
export const ProjectContent = ({ children }: { children: ReactNode }) => {
  const pathname = usePathname() ?? '';
  const conversations = isProjectConversationsPath(pathname);
  const viewportRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || conversations) return;
    const scroll = createProjectContentScroll(viewport, (top) =>
      positions.current.set(pathname, top),
    );
    const align = () => scroll.sync(localAnchorTop(viewport, window.location.hash));
    const position = () =>
      scroll.restore(
        positions.current.get(pathname) ?? 0,
        window.location.hash,
        localAnchorTop(viewport, window.location.hash),
      );
    position();
    const resize = new ResizeObserver(align);
    resize.observe(viewport);
    if (viewport.firstElementChild !== null) resize.observe(viewport.firstElementChild);
    const mutation = new MutationObserver(align);
    mutation.observe(viewport, { childList: true, subtree: true });
    viewport.addEventListener('scroll', scroll.onScroll);
    window.addEventListener('hashchange', position);
    window.addEventListener('popstate', position);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      viewport.removeEventListener('scroll', scroll.onScroll);
      window.removeEventListener('hashchange', position);
      window.removeEventListener('popstate', position);
    };
  }, [pathname, conversations]);

  return (
    <div
      ref={viewportRef}
      data-project-viewport={conversations ? 'conversation-panes' : 'page'}
      role={conversations ? undefined : 'region'}
      aria-label={conversations ? undefined : 'Project content'}
      tabIndex={conversations ? undefined : 0}
      className={cn(
        'min-h-0 min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        conversations ? 'overflow-hidden' : 'overflow-y-auto overscroll-contain p-1 -m-1',
      )}
    >
      <PageContent width={projectContentWidth(pathname)} fill={conversations}>
        {children}
      </PageContent>
    </div>
  );
};
