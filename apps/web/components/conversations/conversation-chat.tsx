'use client';

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import {
  MessageComposer,
  type MessageComposerProps,
} from '@/components/conversations/message-composer';
import { Card, CardContent } from '@/components/ui/card';
import { chatAnchorTop, createChatScrollController } from '@/lib/conversations/chat-scroll';

export const ChatViewContext = createContext({ active: true, hash: '' });

/** Keyed by conversation ID at the server boundary so a different conversation starts fresh. */
export const ConversationChat = ({
  children,
  composer,
}: {
  children: ReactNode;
  composer: Omit<MessageComposerProps, 'mode' | 'onSent'>;
}) => {
  const { active, hash } = useContext(ChatViewContext);
  const paneRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createChatScrollController> | null>(null);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (pane === null || viewport === null || content === null) return;
    controller.current ??= createChatScrollController(viewport);
    const scroll = controller.current;
    const sync = () => {
      if (!active || viewport.clientHeight === 0) {
        scroll.sync({ active: false, hash, anchorTop: null });
        return;
      }
      // Use document coordinates so ordinary page scrolling never changes the pane's height.
      const top = pane.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(384, window.innerHeight - top - 24);
      if (pane.style.height !== `${height}px`) pane.style.height = `${height}px`;
      // Read the fragment before the first paint, including during initial hydration.
      const currentHash = window.location.hash;
      if (
        scroll.sync({ active, hash: currentHash, anchorTop: chatAnchorTop(viewport, currentHash) })
      ) {
        viewport.dataset.scrollReady = 'true';
        pane.dataset.chatReady = 'true';
      }
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(content);
    observer.observe(viewport);
    const main = pane.closest('main');
    if (main !== null) observer.observe(main);
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [active, hash, children]);

  return (
    <section
      ref={paneRef}
      aria-label="Chat"
      className="flex h-[70dvh] min-h-96 min-w-0 flex-col gap-4 [&:not([data-chat-ready])]:invisible"
    >
      <div
        ref={viewportRef}
        role="region"
        aria-label="Chat transcript"
        tabIndex={0}
        onScroll={() => controller.current?.onScroll()}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md p-1 outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-ring [&:not([data-scroll-ready])]:invisible"
      >
        <div ref={contentRef} className="space-y-4">
          {children}
        </div>
      </div>
      <Card className="max-h-[60%] shrink-0 overflow-y-auto">
        <CardContent>
          <MessageComposer {...composer} onSent={() => controller.current?.followLatest()} />
        </CardContent>
      </Card>
    </section>
  );
};
