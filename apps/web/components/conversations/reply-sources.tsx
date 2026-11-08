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
    <details className="mt-3 min-w-0 rounded-lg border bg-inset/40 px-3 py-1 text-xs">
      <summary className="flex min-h-9 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <FileCode2 className="size-3.5 self-center text-primary" aria-hidden="true" />
        <span className="font-semibold text-foreground">
          {view.items.length} {view.items.length === 1 ? 'source' : 'sources'}
        </span>
        <span className="text-muted-foreground">
          {record.sourceMode === 'working_tree' ? 'HEAD reference' : 'commit'}{' '}
          <span className="font-mono">{view.commitShort}</span>
          {view.branch === null ? ' (detached)' : ` on ${view.branch}`}
        </span>
        {view.incomplete ? (
          <span className="flex items-center gap-1 text-warning">
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            Limited context
          </span>
        ) : null}
      </summary>
      <p className="mt-2 leading-5 text-muted-foreground">
        Retrieved excerpts referenced for this reply. Other claims have not been verified by this
        context.
      </p>
      {view.items.length === 0 ? null : (
        <ul className="mt-2 space-y-1" aria-label="Supplied excerpts">
          {view.items.map((item) => (
            <li key={item.reference} className="flex flex-wrap gap-x-2">
              <span className="font-mono break-all text-foreground">{item.reference}</span>
              <span className="min-w-0 break-all text-muted-foreground">{item.detail}</span>
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
        {record.sourceMode === 'working_tree'
          ? record.catalog.untrackedFiles === undefined
            ? 'Current working tree; untracked and ignored files were excluded.'
            : 'Current working tree; eligible untracked files included. Ignored files excluded. HEAD identifies the repository; untracked files have no commit provenance.'
          : 'Committed content only; uncommitted changes were not included.'}
      </p>
    </details>
  );
};
