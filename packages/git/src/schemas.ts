import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { GitInputError } from './errors.js';

export const defaultTimeoutMs = 10_000;
export const defaultMaxOutputBytes = 16 * 1024 * 1024;

export const gitCommandOptionsSchema = z.object({
  /** Per-command timeout. Defaults to 10 seconds. */
  timeoutMs: z.number().int().positive().max(600_000).default(defaultTimeoutMs),
  /** Combined stdout/stderr limit per command. Defaults to 16 MiB. */
  maxOutputBytes: z.number().int().positive().default(defaultMaxOutputBytes),
});

export type GitCommandOptions = z.input<typeof gitCommandOptionsSchema>;

export const parseCommandOptions = (
  options: GitCommandOptions,
): z.output<typeof gitCommandOptionsSchema> => {
  const parsed = gitCommandOptionsSchema.safeParse({
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
  if (!parsed.success) {
    throw new GitInputError(`Invalid Git command options: ${parsed.error.issues[0]?.message}.`);
  }
  return parsed.data;
};

const absolutePathSchema = z
  .string()
  .min(1, 'must not be empty')
  .refine((value) => !value.includes('\0'), { message: 'must not contain null bytes' })
  .refine((value) => isAbsolute(value), { message: 'must be an absolute path' });

export const parseAbsolutePath = (value: unknown, label = 'Path'): string => {
  const parsed = absolutePathSchema.safeParse(value);
  if (!parsed.success) {
    throw new GitInputError(`${label} ${parsed.error.issues[0]?.message ?? 'is invalid'}.`);
  }
  return parsed.data;
};

// Mirrors git-check-ref-format for a branch name under refs/heads/.
const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      ![...name].some((character) => character <= ' ' || character === '\x7f') &&
      !/[~^:?*[\\]/.test(name) &&
      !name.startsWith('-') &&
      !name.startsWith('/') &&
      !name.endsWith('/') &&
      !name.endsWith('.') &&
      !name.includes('..') &&
      !name.includes('//') &&
      !name.includes('@{') &&
      name !== '@' &&
      name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock')),
  );

export const parseBranchName = (value: unknown): string => {
  const parsed = branchNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new GitInputError(`Invalid branch name: ${JSON.stringify(value)}.`);
  }
  return parsed.data;
};
