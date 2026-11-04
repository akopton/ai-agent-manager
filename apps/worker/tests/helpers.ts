import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../src/logger.js';

export type RecordingLogger = Logger & { messages: string[] };

export const createRecordingLogger = (): RecordingLogger => {
  const messages: string[] = [];
  return {
    messages,
    info: (message) => messages.push(message),
    error: (message) => messages.push(`ERROR ${message}`),
  };
};

export const withTemporaryDirectory = async (
  run: (directory: string) => void | Promise<void>,
): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-manager-worker-'));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
