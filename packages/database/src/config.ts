import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const databasePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes('\0'), {
    message: 'The database path must not contain null bytes.',
  });

export const resolveDatabasePath = (
  environment: Record<string, string | undefined> = process.env,
): string => {
  const configuredPath = environment.AI_AGENT_MANAGER_DATABASE_PATH;
  if (configuredPath === undefined) {
    return join(homedir(), 'Library', 'Application Support', 'ai-agent-manager', 'database.sqlite');
  }

  const value = databasePathSchema.parse(configuredPath);
  const expandedPath = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expandedPath)) {
    throw new Error('AI_AGENT_MANAGER_DATABASE_PATH must be an absolute path or start with "~/".');
  }
  return resolve(expandedPath);
};
