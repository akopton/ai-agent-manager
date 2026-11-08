import type { ReactNode, Ref, UIEventHandler } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** One scroll boundary per view; composers remain outside the history scroll region. */
export const ConversationPanel = ({
  name,
  label,
  children,
  footer,
  panelRef,
  viewportRef,
  contentRef,
  onScroll,
  className,
}: {
  name: string;
  label: string;
  children?: ReactNode;
  footer?: ReactNode;
  panelRef?: Ref<HTMLElement>;
  viewportRef?: Ref<HTMLDivElement>;
  contentRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  className?: string;
}) => (
  <section
    ref={panelRef}
    aria-label={name}
    className={cn('flex h-full min-h-0 min-w-0 flex-col gap-2', className)}
  >
    <div
      ref={viewportRef}
      role="region"
      aria-label={label}
      tabIndex={0}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md p-1 outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div ref={contentRef} className="space-y-4">
        {children}
      </div>
    </div>
    {footer === undefined ? null : (
      <Card size="sm" className="max-h-[45%] shrink-0 overflow-y-auto">
        <CardContent>{footer}</CardContent>
      </Card>
    )}
  </section>
);
