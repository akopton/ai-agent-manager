import type { ReactNode } from 'react';
import { contentWidthClassNames, type ContentWidth } from '@/lib/layout';
import { cn } from '@/lib/utils';

/** Left-aligned internal reading/form column; never contains shared project navigation. */
export const PageContent = ({
  children,
  width = 'workspace',
  fill = false,
}: {
  children?: ReactNode;
  width?: ContentWidth;
  fill?: boolean;
}) => (
  <div
    data-content-width={width}
    className={cn('min-h-0 min-w-0 space-y-6', fill && 'h-full', contentWidthClassNames[width])}
  >
    {children}
  </div>
);
