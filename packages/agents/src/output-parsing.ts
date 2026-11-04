import type { AgentOutputEvent, AgentOutputParser, ProviderOutcome } from './contract.js';
import { truncateText } from './line-splitter.js';

/** Limits applied to text taken from provider events. */
export const outputTextLimits = {
  message: 64 * 1024,
  summary: 16 * 1024,
  notice: 2 * 1024,
  detail: 500,
  identifier: 200,
} as const;

const maxDiagnosticsPerCode = 20;
const maxTrackedEventTypes = 32;

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const stringField = (record: JsonRecord, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

/** An identifier-like string from provider data, or `undefined` when absent or implausible. */
export const identifierField = (record: JsonRecord, key: string): string | undefined => {
  const value = stringField(record, key);
  return value !== undefined &&
    value.length > 0 &&
    value.length <= outputTextLimits.identifier &&
    /^[\x21-\x7e]+$/.test(value)
    ? value
    : undefined;
};

export const shortText = (value: string, limit: number): string => {
  const { text, truncated } = truncateText(value.replace(/\s+/g, ' ').trim(), limit);
  return truncated ? `${text}…` : text;
};

/** Mutable state shared by both provider parsers. */
export type ParserState = {
  outcome: ProviderOutcome;
  lastNotice: string | null;
};

/**
 * Wraps a provider-specific event mapper with the shared handling of blank lines, malformed JSON,
 * non-object values, and unknown event types. Diagnostics never include line content, which could
 * contain prompt text or file contents.
 */
export const createJsonLineParser = (
  mapEvent: (event: JsonRecord, type: string, state: ParserState) => AgentOutputEvent[] | null,
): AgentOutputParser => {
  const state: ParserState = { outcome: { status: 'none' }, lastNotice: null };
  const diagnosticCounts = new Map<string, number>();
  const reportedTypes = new Set<string>();
  let lineNumber = 0;

  const diagnostic = (
    code: 'malformed_output' | 'unrecognized_event',
    message: string,
  ): AgentOutputEvent[] => {
    const count = (diagnosticCounts.get(code) ?? 0) + 1;
    diagnosticCounts.set(code, count);
    if (count > maxDiagnosticsPerCode) {
      return [];
    }
    const suffix =
      count === maxDiagnosticsPerCode ? ' Further diagnostics of this kind are suppressed.' : '';
    return [{ type: 'diagnostic', code, message: `${message}${suffix}` }];
  };

  return {
    parseLine: (line) => {
      lineNumber += 1;
      if (line.trim() === '') {
        return [];
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return diagnostic(
          'malformed_output',
          `Stdout line ${lineNumber} is not valid JSON (${Buffer.byteLength(line)} bytes).`,
        );
      }
      if (!isRecord(value)) {
        return diagnostic('malformed_output', `Stdout line ${lineNumber} is not a JSON object.`);
      }
      const type = identifierField(value, 'type');
      if (type === undefined) {
        return diagnostic('malformed_output', `Stdout line ${lineNumber} has no event type.`);
      }
      const events = mapEvent(value, type, state);
      if (events !== null) {
        return events;
      }
      if (reportedTypes.has(type) || reportedTypes.size >= maxTrackedEventTypes) {
        return [];
      }
      reportedTypes.add(type);
      return diagnostic('unrecognized_event', `Ignored unrecognized event type "${type}".`);
    },
    outcome: () => state.outcome,
    lastNotice: () => state.lastNotice,
  };
};

const modelErrorPattern =
  /\bmodel\b.*\b(not[ _]found|not supported|unsupported|does not exist|invalid|not available|unavailable|no access|unknown)\b|\b(not[ _]found|invalid|unknown|unsupported)[ _]model\b/i;

/**
 * Heuristic: whether a provider error message says the requested model was refused. The exact
 * wording of both CLIs has not been verified live; a miss is reported as `provider_error`.
 */
export const isModelUnavailableMessage = (message: string): boolean =>
  modelErrorPattern.test(message);
