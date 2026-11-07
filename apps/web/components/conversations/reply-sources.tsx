import { FileCode2, TriangleAlert } from 'lucide-react';
import type { RepositoryContextRecord } from '@ai-agent-manager/core';

import { buildSourcesView } from '@/lib/conversations/sources';

/**
 * C4 — compact "Sources" under a project-aware reply: the repository excerpts AI Agent Manager
 * actually supplied (paths and line ranges at a commit), with limits, refusals and freshness.
 * Collapsed by default; a native disclosure, so it works with the keyboard.
 */
export const ReplySources = ({ record }: { record: RepositoryContextRecord }) => {
  const view = buildSourcesView(record);
  return (
    <details className="max-w-[92%] min-w-0 rounded-xl border bg-inset/60 px-3 py-2 text-xs">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1">
        <FileCode2 className="size-3.5 self-center text-primary" aria-hidden="true" />
        <span className="font-semibold text-foreground">
          Sources ({view.items.length === 1 ? '1 excerpt' : `${view.items.length} excerpts`})
        </span>
        <span className="text-muted-foreground">
          commit <span className="font-mono">{view.commitShort}</span>
          {view.branch === null ? ' (detached)' : ` on ${view.branch}`}
        </span>
        {view.incomplete ? (
          <span className="flex items-center gap-1 text-warning">
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            Limited context
          </span>
        ) : null}
      </summary>
      {view.items.length === 0 ? null : (
        <ul className="mt-2 space-y-1" aria-label="Supplied excerpts">
          {view.items.map((item) => (
            <li key={item.reference} className="flex flex-wrap gap-x-2">
              <span className="font-mono break-all text-foreground">{item.reference}</span>
              <span className="text-muted-foreground">{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {view.notes.length === 0 ? null : (
        <ul className="mt-2 space-y-1 leading-5 text-muted-foreground">
          {view.notes.map((note) => (
            <li key={note} className="break-words">
              {note}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 leading-5 text-muted-foreground">
        Committed content only; uncommitted changes were not included.
      </p>
    </details>
  );
};
