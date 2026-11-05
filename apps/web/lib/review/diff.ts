// Parses a unified diff (as produced by `getTaskFileDiff`) into rows with old and new line
// numbers for display. Pure and display-only: it never decides what a change means.

export type DiffRow =
  | { type: 'context'; oldLine: number; newLine: number; text: string }
  | { type: 'addition'; oldLine: null; newLine: number; text: string }
  | { type: 'deletion'; oldLine: number; newLine: null; text: string }
  /** `\ No newline at end of file`. */
  | { type: 'note'; oldLine: null; newLine: null; text: string };

export type DiffHunk = { header: string; rows: DiffRow[] };

export type ParsedDiff = {
  /** Header lines before the first hunk (`diff --git`, modes, renames, `---`/`+++`). */
  meta: string[];
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};

const hunkHeaderPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export const parseUnifiedDiff = (patch: string): ParsedDiff => {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const result: ParsedDiff = { meta: [], hunks: [], additions: 0, deletions: 0 };
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const header = hunkHeaderPattern.exec(line);
    if (header !== null) {
      hunk = { header: line, rows: [] };
      result.hunks.push(hunk);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (hunk === null || line.startsWith('diff --git ')) {
      // A second file section (never produced for one file, but handled) starts a new header.
      hunk = null;
      result.meta.push(line);
      continue;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === '+') {
      hunk.rows.push({ type: 'addition', oldLine: null, newLine, text });
      newLine += 1;
      result.additions += 1;
    } else if (marker === '-') {
      hunk.rows.push({ type: 'deletion', oldLine, newLine: null, text });
      oldLine += 1;
      result.deletions += 1;
    } else if (marker === '\\') {
      hunk.rows.push({ type: 'note', oldLine: null, newLine: null, text: line });
    } else {
      hunk.rows.push({ type: 'context', oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
    }
  }
  return result;
};
