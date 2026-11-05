'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, FileWarning, Loader2 } from 'lucide-react';

import { DiffView } from '@/components/review/diff-view';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import {
  fileDiffResponseSchema,
  type ChangedFileView,
  type FileDiffView,
} from '@/lib/review/contracts';
import {
  describeFileChange,
  diffOmissionMessages,
  formatBytes,
  taskReviewDiffUrl,
} from '@/lib/review/format';
import { cn } from '@/lib/utils';

/** Diffs of the first files are loaded right away; the rest load when opened. */
const initiallyOpenFiles = 8;

const changeBadgeStyles: Readonly<Record<string, string>> = {
  Added: 'border-success/40 text-success',
  Untracked: 'border-success/40 text-success',
  Deleted: 'border-destructive/40 text-destructive',
  Renamed: 'border-info/40 text-info',
  Conflicted: 'border-warning/50 text-warning',
};

export const FileChangeBadge = ({ file }: { file: ChangedFileView }) => {
  const label = describeFileChange(file);
  return (
    <Badge variant="outline" className={cn('shrink-0', changeBadgeStyles[label])}>
      {label}
    </Badge>
  );
};

/** Short flags that matter for review: binary, too large, committed, symlinks, etc. */
const fileFlags = (file: ChangedFileView): string[] => {
  const flags: string[] = [];
  if (file.diffOmitted === 'binary' || file.binary === true) flags.push('binary');
  if (file.diffOmitted === 'too_large') flags.push('too large');
  if (file.diffOmitted === 'unsupported_encoding') flags.push('not UTF-8');
  if (file.diffOmitted === 'unsupported_file_type') flags.push(file.kind);
  if (file.kind === 'symlink') flags.push('symlink');
  if (file.symlinkEscapesWorktree === true) flags.push('points outside worktree');
  if (file.kind === 'executable' && file.previousKind !== 'executable') flags.push('executable');
  if (file.committed) flags.push('committed on task branch');
  if (file.staged) flags.push('staged');
  if (file.size !== null) flags.push(formatBytes(file.size));
  return flags;
};

const LineCounts = ({ file }: { file: ChangedFileView }) =>
  file.additions === null && file.deletions === null ? null : (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-success">+{file.additions ?? 0}</span>{' '}
      <span className="text-destructive">−{file.deletions ?? 0}</span>
    </span>
  );

type DiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; diff: FileDiffView }
  | { status: 'error'; error: ClientError };

type FileDiffProps = {
  projectId: string;
  taskId: string;
  file: ChangedFileView;
  revision: string;
  defaultOpen: boolean;
  anchorId: string;
};

const FileDiff = ({ projectId, taskId, file, revision, defaultOpen, anchorId }: FileDiffProps) => {
  // Diffs that the inventory already knows cannot be shown are not requested.
  const knownOmission =
    file.diffOmitted !== null && file.diffOmitted !== 'read_budget_exhausted'
      ? file.diffOmitted
      : null;
  const [open, setOpen] = useState(defaultOpen);
  const [state, setState] = useState<DiffState>(
    defaultOpen && knownOmission === null ? { status: 'loading' } : { status: 'idle' },
  );

  // Fetches while the file is open and a load was requested; a closed or replaced file ignores
  // a late response.
  useEffect(() => {
    if (!open || state.status !== 'loading') return undefined;
    let current = true;
    void requestJson(
      'GET',
      taskReviewDiffUrl(projectId, taskId, file.path),
      fileDiffResponseSchema,
    ).then((result) => {
      if (!current) return;
      setState(
        result.ok
          ? { status: 'loaded', diff: result.data.diff }
          : { status: 'error', error: result.error },
      );
    });
    return () => {
      current = false;
    };
  }, [open, state.status, projectId, taskId, file.path]);

  const toggle = () => {
    if (!open && knownOmission === null && state.status === 'idle') {
      setState({ status: 'loading' });
    }
    setOpen(!open);
  };

  const omitted = knownOmission ?? (state.status === 'loaded' ? state.diff.omitted : null);

  return (
    <section id={anchorId} aria-label={file.path} className="scroll-mt-4 rounded-lg border bg-card">
      <h3 className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-t-lg px-3 py-2 text-left text-sm transition-colors hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          )}
          <FileChangeBadge file={file} />
          <span className="min-w-0 flex-1 font-mono text-xs break-all">
            {file.previousPath !== null ? `${file.previousPath} → ` : null}
            {file.path}
          </span>
          <LineCounts file={file} />
        </button>
      </h3>
      {open ? (
        <div className="space-y-2 border-t p-3">
          {fileFlags(file).length > 0 ? (
            <p className="text-xs text-muted-foreground">{fileFlags(file).join(' · ')}</p>
          ) : null}
          {file.symlinkTarget !== null ? (
            <p className="text-xs">
              Symlink target: <span className="font-mono break-all">{file.symlinkTarget}</span> (not
              followed)
            </p>
          ) : null}
          {omitted !== null ? (
            <p className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              <FileWarning className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {diffOmissionMessages[omitted]}
            </p>
          ) : state.status === 'loading' || state.status === 'idle' ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading diff…
            </p>
          ) : state.status === 'error' ? (
            <Alert variant="destructive" role="alert">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>The diff could not be loaded</AlertTitle>
              <AlertDescription>
                <p>{state.error.message}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setState({ status: 'loading' })}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : state.diff.patch === null ? (
            <p className="text-sm text-muted-foreground">No diff is available for this file.</p>
          ) : (
            <>
              {state.diff.revision !== revision ? (
                <p className="text-xs text-warning">
                  The worktree changed after the overview was loaded. Refresh the page to inspect it
                  again.
                </p>
              ) : null}
              <DiffView patch={state.diff.patch} />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
};

type ReviewFileListProps = {
  projectId: string;
  taskId: string;
  files: ChangedFileView[];
  revision: string;
};

/** The change inventory as a compact index plus one collapsible diff per file. */
export const ReviewFileList = ({ projectId, taskId, files, revision }: ReviewFileListProps) => (
  <div className="space-y-4">
    <nav aria-label="Changed files">
      <ul className="divide-y rounded-lg border bg-card text-sm">
        {files.map((file, index) => (
          <li key={file.path} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
            <FileChangeBadge file={file} />
            <a
              href={`#file-${index}`}
              className="min-w-0 flex-1 rounded-sm font-mono text-xs break-all underline-offset-4 hover:text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {file.path}
            </a>
            <LineCounts file={file} />
          </li>
        ))}
      </ul>
    </nav>
    <div className="space-y-3">
      {files.map((file, index) => (
        <FileDiff
          key={`${revision}:${file.path}`}
          projectId={projectId}
          taskId={taskId}
          file={file}
          revision={revision}
          defaultOpen={index < initiallyOpenFiles}
          anchorId={`file-${index}`}
        />
      ))}
    </div>
  </div>
);
