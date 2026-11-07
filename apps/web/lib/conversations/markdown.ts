// A small Markdown subset for AI replies, parsed into plain data and rendered as React elements
// (never as HTML strings). Supported: fenced code blocks, ATX headings, bullet and numbered lists,
// block quotes, horizontal rules, paragraphs, inline code, bold, italic and http(s) links.
// Anything else stays visible as text. Replies are untrusted model output: no raw HTML is ever
// interpreted, and links other than http(s) are shown as text.

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'em'; children: MarkdownInline[] }
  | { type: 'link'; href: string; children: MarkdownInline[] };

export type MarkdownBlock =
  | { type: 'code'; language: string | null; text: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInline[] }
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownInline[][] }
  | { type: 'quote'; children: MarkdownBlock[] }
  | { type: 'rule' };

const fencePattern = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const headingPattern = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const bulletPattern = /^\s{0,3}[-*+]\s+(.*)$/;
const orderedPattern = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const quotePattern = /^\s{0,3}>\s?(.*)$/;
const rulePattern = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

const isSafeHref = (href: string): boolean => /^https?:\/\/[^\s]+$/i.test(href);

/** Parses inline markup. Unmatched markers are kept as text. */
export const parseInline = (text: string): MarkdownInline[] => {
  const result: MarkdownInline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer !== '') {
      result.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code !== null && code[2] !== undefined) {
      flush();
      result.push({ type: 'code', text: code[2].trim() === '' ? code[2] : code[2].trim() });
      index += code[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong !== null && strong[2] !== undefined) {
      flush();
      result.push({ type: 'strong', children: parseInline(strong[2]) });
      index += strong[0].length;
      continue;
    }
    const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![*_\w])/.exec(rest);
    if (
      em !== null &&
      em[2] !== undefined &&
      (em[1] === '*' || !/\w/.test(text[index - 1] ?? ''))
    ) {
      flush();
      result.push({ type: 'em', children: parseInline(em[2]) });
      index += em[0].length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null && link[1] !== undefined && link[2] !== undefined) {
      flush();
      if (isSafeHref(link[2])) {
        result.push({ type: 'link', href: link[2], children: parseInline(link[1]) });
      } else {
        result.push({ type: 'text', text: link[0] });
      }
      index += link[0].length;
      continue;
    }
    buffer += text[index];
    index += 1;
  }
  flush();
  return result;
};

/** Parses a Markdown document into blocks. Never throws. */
export const parseMarkdown = (source: string): MarkdownBlock[] => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  const paragraphEnds = (line: string): boolean =>
    line.trim() === '' ||
    fencePattern.test(line) ||
    headingPattern.test(line) ||
    bulletPattern.test(line) ||
    orderedPattern.test(line) ||
    quotePattern.test(line) ||
    rulePattern.test(line);

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const fence = fencePattern.exec(line);
    if (fence !== null) {
      const marker = fence[2] ?? '```';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // Closing fence (or end of input for an unterminated block).
      blocks.push({
        type: 'code',
        language: fence[3] === '' ? null : (fence[3] ?? null),
        text: body.join('\n'),
      });
      continue;
    }
    if (rulePattern.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }
    const heading = headingPattern.exec(line);
    if (heading !== null) {
      const level = Math.min(6, heading[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, children: parseInline(heading[2] ?? '') });
      index += 1;
      continue;
    }
    if (quotePattern.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const match = quotePattern.exec(lines[index] ?? '');
        if (match === null) break;
        body.push(match[1] ?? '');
        index += 1;
      }
      blocks.push({ type: 'quote', children: parseMarkdown(body.join('\n')) });
      continue;
    }
    const bullet = bulletPattern.exec(line);
    const ordered = orderedPattern.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = bullet === null;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = isOrdered ? orderedPattern.exec(current) : bulletPattern.exec(current);
        if (match !== null) {
          items.push((isOrdered ? match[2] : match[1]) ?? '');
          index += 1;
          continue;
        }
        // Indented continuation lines (including nested items) belong to the previous item.
        if (current.trim() !== '' && /^\s{2,}/.test(current) && items.length > 0) {
          items[items.length - 1] += `\n${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({
        type: 'list',
        ordered: isOrdered,
        start: isOrdered ? Number(ordered?.[1] ?? '1') : 1,
        items: items.map(parseInline),
      });
      continue;
    }
    const body: string[] = [line];
    index += 1;
    while (index < lines.length && !paragraphEnds(lines[index] ?? '')) {
      body.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
  }
  return blocks;
};
