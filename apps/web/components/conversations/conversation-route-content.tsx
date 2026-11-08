'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { isConversationDetailPath } from '@/lib/layout';
import { cn } from '@/lib/utils';

/** Detail views own their pane scrollbars; list/new forms use this single scroll boundary. */
export const ConversationRouteContent = ({ children }: { children: ReactNode }) => (
  <div
    className={cn(
      'h-full min-h-0 min-w-0',
      isConversationDetailPath(usePathname() ?? '')
        ? 'overflow-hidden'
        : 'space-y-3 overflow-y-auto overscroll-contain p-1',
    )}
  >
    {children}
  </div>
);
