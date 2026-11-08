'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { isProjectWorkspacePath, pageGutterClassName, pageSpacingClassName } from '@/lib/layout';
import { cn } from '@/lib/utils';

/** Shared geometry; project descendants delegate scrolling to their persistent workspace. */
export const WorkspaceContent = ({ children }: { children: ReactNode }) => (
  <main
    id="main-content"
    tabIndex={-1}
    className={cn(
      'min-h-0 min-w-0 flex-1 py-4 outline-none',
      pageGutterClassName,
      pageSpacingClassName,
      isProjectWorkspacePath(usePathname() ?? '') ? 'md:overflow-hidden' : 'md:overflow-y-auto',
    )}
  >
    {children}
  </main>
);
