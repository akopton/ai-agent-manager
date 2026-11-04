export type SplitLine = {
  text: string;
  /** The line exceeded `maxLineBytes`; `text` holds only its first `maxLineBytes` bytes. */
  truncated: boolean;
};

/**
 * Splits a byte stream into newline-terminated lines with a per-line byte limit. Chunks may end in
 * the middle of a line or a multi-byte character; bytes are buffered until the newline. Overlong
 * lines keep their first `maxLineBytes` bytes and the rest is discarded up to the next newline.
 */
export const createLineSplitter = (maxLineBytes: number) => {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let overflowed = false;

  const append = (bytes: Buffer): void => {
    if (overflowed) {
      return;
    }
    const room = maxLineBytes - pendingBytes;
    if (bytes.length > room) {
      if (room > 0) {
        pending.push(bytes.subarray(0, room));
        pendingBytes += room;
      }
      overflowed = true;
      return;
    }
    pending.push(bytes);
    pendingBytes += bytes.length;
  };

  const take = (): SplitLine => {
    let text = Buffer.concat(pending, pendingBytes).toString('utf8');
    if (text.endsWith('\r')) {
      text = text.slice(0, -1);
    }
    const line = { text, truncated: overflowed };
    pending = [];
    pendingBytes = 0;
    overflowed = false;
    return line;
  };

  return {
    push: (chunk: Buffer): SplitLine[] => {
      const lines: SplitLine[] = [];
      let start = 0;
      for (
        let newline = chunk.indexOf(0x0a);
        newline !== -1;
        newline = chunk.indexOf(0x0a, start)
      ) {
        append(chunk.subarray(start, newline));
        lines.push(take());
        start = newline + 1;
      }
      if (start < chunk.length) {
        append(chunk.subarray(start));
      }
      return lines;
    },
    /** Returns the unterminated last line, if any (for example after the process was killed). */
    flush: (): SplitLine | null => (pendingBytes > 0 || overflowed ? take() : null),
  };
};

/** Truncates text to at most `maxCharacters` UTF-16 code units without splitting a surrogate pair. */
export const truncateText = (
  text: string,
  maxCharacters: number,
): { text: string; truncated: boolean } => {
  if (text.length <= maxCharacters) {
    return { text, truncated: false };
  }
  let end = maxCharacters;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return { text: text.slice(0, end), truncated: true };
};
