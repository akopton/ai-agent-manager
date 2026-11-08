import type { ReactNode } from 'react';

/** At desktop widths actions have their own column; labels/counts cannot wrap it under the title. */
export const TaskHeader = ({
  title,
  badges,
  actions,
}: {
  title: string;
  badges: ReactNode;
  actions: ReactNode;
}) => (
  <div
    data-task-header
    className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]"
  >
    <div className="min-w-0 space-y-3">
      <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
        {title}
      </h1>
      <div className="flex flex-wrap gap-2">{badges}</div>
    </div>
    <div
      data-task-header-actions
      aria-label="Task actions"
      role="group"
      className="min-w-0 space-y-3 lg:min-h-40"
    >
      {actions}
    </div>
  </div>
);
