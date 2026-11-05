import { cn } from '@/lib/utils';
import { parseUnifiedDiff, type DiffRow } from '@/lib/review/diff';

const rowStyles: Readonly<Record<DiffRow['type'], string>> = {
  context: '',
  addition: 'bg-diff-added text-diff-added-foreground',
  deletion: 'bg-diff-removed text-diff-removed-foreground',
  note: 'text-muted-foreground italic',
};

const markerStyles: Readonly<Record<DiffRow['type'], string>> = {
  context: '',
  addition: 'text-success',
  deletion: 'text-destructive',
  note: '',
};

const rowMarkers: Readonly<Record<DiffRow['type'], string>> = {
  context: ' ',
  addition: '+',
  deletion: '-',
  note: '',
};

const rowLabels: Readonly<Record<DiffRow['type'], string | undefined>> = {
  context: undefined,
  addition: 'Added line',
  deletion: 'Removed line',
  note: undefined,
};

/**
 * A unified diff with old and new line numbers. Additions and deletions are marked by color and
 * by a `+`/`-` marker (not color alone). Long lines scroll horizontally inside the diff only.
 */
export const DiffView = ({ patch }: { patch: string }) => {
  const parsed = parseUnifiedDiff(patch);
  return (
    <div className="space-y-2">
      {parsed.meta.some((line) => /^(?:old|new) mode|^rename |^similarity /.test(line)) ? (
        <ul className="font-mono text-xs text-muted-foreground">
          {parsed.meta
            .filter((line) => /^(?:old|new) mode|^rename |^similarity /.test(line))
            .map((line) => (
              <li key={line} className="break-all">
                {line}
              </li>
            ))}
        </ul>
      ) : null}
      {parsed.hunks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No content lines changed.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-inset">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            {parsed.hunks.map((hunk, hunkIndex) => (
              <tbody key={`${hunkIndex}:${hunk.header}`}>
                <tr className="bg-diff-hunk text-muted-foreground">
                  <td colSpan={3} className="px-2 py-1 whitespace-pre">
                    {hunk.header}
                  </td>
                </tr>
                {hunk.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className={cn(rowStyles[row.type])}>
                    <td className="w-px border-r px-2 text-right text-muted-foreground/70 tabular-nums select-none">
                      {row.oldLine ?? ''}
                    </td>
                    <td className="w-px border-r px-2 text-right text-muted-foreground/70 tabular-nums select-none">
                      {row.newLine ?? ''}
                    </td>
                    <td className="px-2 whitespace-pre">
                      <span
                        aria-label={rowLabels[row.type]}
                        className={cn('select-none', markerStyles[row.type])}
                      >
                        {rowMarkers[row.type]}
                      </span>
                      {row.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
};
