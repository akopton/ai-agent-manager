import {
  formatSourceReference,
  type ConversationTurnStage,
  type RepositoryContextRecord,
} from '@ai-agent-manager/core';
import type { ProjectSourceAccessView } from '@/lib/conversations/contracts';

// C4 — pure presentation of project-aware context: why source sharing is unavailable, what a
// running turn is doing, and the compact "Sources" list under a project-aware reply. Only the
// application's retrieval record is shown; nothing is inferred from the reply text.

export const describeSourceAccessReason = (reason: ProjectSourceAccessView['reason']): string => {
  switch (reason) {
    case 'allowed':
      return 'Source sharing is allowed for this project.';
    case 'repository_changed':
      return 'Source sharing was allowed for a different repository identity. Review and allow it again.';
    case 'stale':
      return 'The source-sharing disclosure changed. Review and allow it again.';
    case 'not_allowed':
      return 'Project-Aware messages are refused until you allow sharing this project’s eligible working-tree source with the selected CLI. General Chat needs no permission.';
  }
};

export const describeTurnStage = (stage: ConversationTurnStage, runtimeName: string): string => {
  switch (stage) {
    case 'checking_repository':
      return 'Checking the repository…';
    case 'selecting_files':
      return `${runtimeName} is choosing relevant files…`;
    case 'reading_files':
      return 'Reading repository files…';
    case 'answering':
      return `${runtimeName} is writing a reply with repository context…`;
  }
};

export type SourceItem = {
  reference: string;
  /** "requested", "search match" or "keyword search", plus "excerpt" for partial files. */
  detail: string;
};

export type SourcesView = {
  commit: string;
  commitShort: string;
  branch: string | null;
  items: SourceItem[];
  /** Short statements about limits, refusals, the selection and freshness. */
  notes: string[];
  /** Whether the context was limited or the selection fell back to keyword search. */
  incomplete: boolean;
};

const originLabels: Readonly<Record<RepositoryContextRecord['sources'][number]['origin'], string>> =
  {
    requested: 'chosen by the AI',
    search: 'search match',
    fallback: 'keyword search',
  };

/** The compact Sources list of a project-aware reply, from its retrieval record. */
export const buildSourcesView = (record: RepositoryContextRecord): SourcesView => {
  const items = record.sources.map((source) => ({
    reference: formatSourceReference(source),
    detail: [
      originLabels[source.origin],
      `Lines ${source.startLine}–${source.endLine}`,
      source.state === 'untracked'
        ? 'Untracked · Local (no HEAD provenance)'
        : source.state === 'modified'
          ? 'Tracked · Modified (working-tree modification)'
          : source.state === 'added'
            ? 'Tracked · Added'
            : source.state === 'matches_head'
              ? 'Tracked · working tree matches HEAD bytes'
              : null,
      source.contentHash === undefined ? null : `SHA-256 ${source.contentHash}`,
      source.readAt === undefined ? null : `read ${source.readAt}`,
      source.partial
        ? `${source.endLine - source.startLine + 1} of ${source.totalLines} lines`
        : null,
      source.documentation ? 'documentation' : null,
    ]
      .filter((part) => part !== null)
      .join(' · '),
  }));
  const notes: string[] = [];
  if (record.sourceMode === 'working_tree') {
    notes.push(
      'Current working-tree excerpts, including tracked edits. Files were captured individually; this is not a complete repository snapshot or a clean-status check. Later edits may differ.',
    );
    if (record.retrievedAt !== undefined)
      notes.push(
        `Retrieved ${record.retrievedAt}. Relevant files are reread on each turn, even when HEAD is unchanged.`,
      );
  }
  if (record.sources.length === 0) {
    notes.push('No repository content was supplied for this reply.');
  }
  if (record.selection === 'fallback') {
    notes.push(
      `Files were selected by keyword search${record.selectionNote === null ? '' : `: ${record.selectionNote}`}`,
    );
  } else if (record.selectionNote !== null) {
    notes.push(`AI selection note: ${record.selectionNote}`);
  }
  if (record.searches.length > 0) {
    notes.push(
      `Searches: ${record.searches.map((search) => `“${search.term}” (${search.matchedFiles}${search.truncated ? '+' : ''})`).join(', ')}.`,
    );
  }
  if (record.rejected.length > 0) {
    notes.push(
      `Refused: ${record.rejected.map((item) => `${item.path} (${item.reason})`).join('; ')}.`,
    );
  }
  if (record.omitted.length > 0) {
    notes.push(
      `Left out: ${record.omitted.map((item) => `${item.path} (${item.reason})`).join('; ')}.`,
    );
  }
  if (record.ignoredRequests.length > 0) {
    notes.push(`Ignored requests: ${record.ignoredRequests.join('; ')}.`);
  }
  if (record.catalog.treeTruncated) {
    notes.push('The repository tree was too large to list completely.');
  }
  if (record.limited) {
    notes.push('The repository context was limited; the answer may be incomplete.');
  }
  if (record.previousCommit !== null && record.previousCommit !== record.commit) {
    notes.push(
      `The repository changed since the previous project-aware reply (${record.previousCommit.slice(0, 8)} → ${record.commit.slice(0, 8)}).`,
    );
  }
  if (record.unverifiedReferences.length > 0) {
    notes.push(
      `The reply also mentions files that were not supplied to the AI: ${record.unverifiedReferences.join(', ')}.`,
    );
  }
  return {
    commit: record.commit,
    commitShort: record.commit.slice(0, 8),
    branch: record.branch,
    items,
    notes,
    incomplete: record.limited || record.selection === 'fallback',
  };
};
