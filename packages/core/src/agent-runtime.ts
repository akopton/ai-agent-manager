import { z } from 'zod';

export const agentRuntimes = ['claude', 'codex'] as const;

export const agentRuntimeSchema = z.enum(agentRuntimes);

export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;

/**
 * A task-level model choice. `null` means `Default`: no model override is passed to the CLI.
 */
export const modelSelectionSchema = z
  .string()
  .trim()
  .min(1, 'An explicit model identifier must not be empty.')
  .max(200)
  .nullable();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;
