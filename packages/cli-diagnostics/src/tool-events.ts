import type { AgentRuntime } from '@ai-agent-manager/core';

export type ToolEventScan = { mentioned: boolean; failed: boolean };

const maxScannedLineBytes = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const contentBlocks = (event: Record<string, unknown>): Record<string, unknown>[] => {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
};

/**
 * Stateful scanner over raw CLI stdout lines (Claude `stream-json` or Codex `--json`). Records
 * whether a tool invocation mentioned any needle (scenario id or target file name) and whether
 * that same tool reported failure. Keeps no line content.
 *
 * The normalized adapter events omit tool inputs on purpose, so the scan works on raw lines and
 * runs only in the harness, over output that is never persisted.
 */
export const createToolEventScanner = (runtime: AgentRuntime, needles: readonly string[]) => {
  const mentionedIds = new Set<string>();
  const scan: ToolEventScan = { mentioned: false, failed: false };
  const mentions = (line: string) => needles.some((needle) => line.includes(needle));

  const push = (line: string): void => {
    if (line.length > maxScannedLineBytes || line.trim() === '') return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (runtime === 'claude') {
      for (const block of contentBlocks(event)) {
        if (block.type === 'tool_use' && mentions(JSON.stringify(block.input ?? null))) {
          scan.mentioned = true;
          if (typeof block.id === 'string') mentionedIds.add(block.id);
        }
        if (
          block.type === 'tool_result' &&
          typeof block.tool_use_id === 'string' &&
          mentionedIds.has(block.tool_use_id) &&
          block.is_error === true
        ) {
          scan.failed = true;
        }
      }
      return;
    }
    const item = event.item;
    if (!isRecord(item) || typeof item.id !== 'string') return;
    const isTool = item.type === 'command_execution' || item.type === 'file_change';
    if (!isTool) return;
    if (event.type === 'item.started' && mentions(JSON.stringify(item))) {
      scan.mentioned = true;
      mentionedIds.add(item.id);
    }
    if (event.type === 'item.completed') {
      if (!mentionedIds.has(item.id) && mentions(JSON.stringify(item))) {
        scan.mentioned = true;
        mentionedIds.add(item.id);
      }
      const failed =
        item.status === 'failed' ||
        item.status === 'declined' ||
        (typeof item.exit_code === 'number' && item.exit_code !== 0);
      if (mentionedIds.has(item.id) && failed) scan.failed = true;
    }
  };

  return { push, result: (): ToolEventScan => ({ ...scan }) };
};
