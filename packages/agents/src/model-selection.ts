import { z } from 'zod';
import { modelSelectionSchema } from '@ai-agent-manager/core';

/**
 * A model identifier that may be passed to a CLI as the value of `--model`. Checks only the
 * **syntax**: whether the model exists or is available for the current account and authentication
 * mode is decided by the CLI at run time. There is deliberately no list of supported models.
 *
 * The first character must be alphanumeric so a value can never be read as an option, and
 * whitespace, `=`, quotes, and control characters are rejected. Aliases (`opus`), full names
 * (`claude-opus-5-5`), context suffixes (`[1m]`), and provider paths (`gpt-5.1-codex`) are accepted.
 */
export const cliModelIdSchema = modelSelectionSchema.refine(
  (value) => value === null || /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/.test(value),
  'A model identifier may contain only letters, digits, and . _ : / @ [ ] - and must start with a letter or digit.',
);

export type CliModelId = z.output<typeof cliModelIdSchema>;
