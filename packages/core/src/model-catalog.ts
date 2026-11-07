import type { AgentRuntime } from './agent-runtime.js';

// Provider-specific model choices for the model selector (tasks and conversations). This is a
// **curated, versioned catalog**, not model discovery, and not a statement about what the signed-in
// account may use: availability is decided by the CLI and the provider when a run or turn starts,
// and an unavailable model fails visibly without any fallback.
//
// Why a catalog (C2 decision, 2026-11-07):
//
// - Claude Code 2.1.317 offers no machine-readable model listing. Its `--model` help names the
//   aliases `fable`, `opus` and `sonnet` and accepts full model names.
// - Codex CLI 0.166.0 can print its raw model catalog with `codex debug models --bundled`
//   (offline, JSON). It sits under the `debug` command, which is not a documented, stable
//   interface, so the application does not run or parse it. The Codex entries below are the
//   models that command listed with `visibility: "list"`, ordered by its `priority`.
//
// Update the entries (and `modelCatalogVersion`) when the supported CLI versions change. Any other
// identifier can still be entered as a custom model ID.

export type CatalogModel = {
  runtime: AgentRuntime;
  /** The exact value passed to the CLI as `--model`. */
  id: string;
  /** Human-readable name shown in the selector. */
  label: string;
  /** `alias`: resolved by the CLI to its current model of that family. */
  kind: 'alias' | 'model';
  description: string;
};

/** Identifies the catalog contents; shown next to the selector. */
export const modelCatalogVersion = '2026-11-07 (Claude Code 2.1.317, Codex CLI 0.166.0)';

const claudeModels: readonly CatalogModel[] = [
  {
    runtime: 'claude',
    id: 'fable',
    label: 'Fable (latest)',
    kind: 'alias',
    description: 'Alias; Claude Code resolves it to its current Fable model.',
  },
  {
    runtime: 'claude',
    id: 'opus',
    label: 'Opus (latest)',
    kind: 'alias',
    description: 'Alias; Claude Code resolves it to its current Opus model.',
  },
  {
    runtime: 'claude',
    id: 'sonnet',
    label: 'Sonnet (latest)',
    kind: 'alias',
    description: 'Alias; Claude Code resolves it to its current Sonnet model.',
  },
  {
    runtime: 'claude',
    id: 'haiku',
    label: 'Haiku (latest)',
    kind: 'alias',
    description: 'Alias; Claude Code resolves it to its current Haiku model.',
  },
  {
    runtime: 'claude',
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    kind: 'model',
    description: 'Pinned model name.',
  },
  {
    runtime: 'claude',
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    kind: 'model',
    description: 'Pinned model name.',
  },
  {
    runtime: 'claude',
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    kind: 'model',
    description: 'Pinned model name.',
  },
  {
    runtime: 'claude',
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    kind: 'model',
    description: 'Pinned model name.',
  },
];

const codexModels: readonly CatalogModel[] = [
  {
    runtime: 'codex',
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
    kind: 'model',
    description: 'Latest workhorse model for coding and everyday work.',
  },
  {
    runtime: 'codex',
    id: 'gpt-6-astra',
    label: 'GPT-6-Astra',
    kind: 'model',
    description: 'Frontier intelligence for the most demanding work.',
  },
  {
    runtime: 'codex',
    id: 'gpt-6-sol',
    label: 'GPT-6-Sol',
    kind: 'model',
    description: 'Previous generation workhorse model.',
  },
  {
    runtime: 'codex',
    id: 'gpt-6-luna',
    label: 'GPT-6-Luna',
    kind: 'model',
    description: 'Fast and affordable model for easier tasks.',
  },
  {
    runtime: 'codex',
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    kind: 'model',
    description: 'Older generation workhorse model.',
  },
  {
    runtime: 'codex',
    id: 'gpt-6.1-terra',
    label: 'GPT-6.1 Terra',
    kind: 'model',
    description: 'GPT-6.1 Terra Codex model.',
  },
  {
    runtime: 'codex',
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    kind: 'model',
    description: 'Older balanced model for straightforward work.',
  },
  {
    runtime: 'codex',
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6-Luna',
    kind: 'model',
    description: 'Older fast and efficient model.',
  },
  {
    runtime: 'codex',
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    kind: 'model',
    description: 'Legacy coding model.',
  },
];

export const modelCatalog: Readonly<Record<AgentRuntime, readonly CatalogModel[]>> = Object.freeze({
  claude: Object.freeze(claudeModels.map((model) => Object.freeze(model))),
  codex: Object.freeze(codexModels.map((model) => Object.freeze(model))),
});

/** The catalog entry for this runtime and identifier, if the identifier is listed. */
export const findCatalogModel = (
  runtime: AgentRuntime,
  modelId: string | null,
): CatalogModel | undefined =>
  modelId === null ? undefined : modelCatalog[runtime].find((model) => model.id === modelId);

/** The runtime whose catalog lists this identifier, other than `runtime`, if any. */
const otherRuntimeListing = (runtime: AgentRuntime, modelId: string): CatalogModel | undefined =>
  (Object.keys(modelCatalog) as AgentRuntime[])
    .filter((candidate) => candidate !== runtime)
    .map((candidate) => findCatalogModel(candidate, modelId))
    .find((model) => model !== undefined);

/**
 * Same syntax rule as the CLI adapters (`cliModelIdSchema` in `packages/agents`): the value must
 * start with a letter or digit, so it can never be read as an option, and contain no whitespace,
 * `=`, quotes or control characters.
 */
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/;

const runtimeNames: Readonly<Record<AgentRuntime, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/**
 * Checks a model selection against the selected runtime. Returns an actionable message, or `null`
 * when the selection is acceptable. `null` (Default) is always acceptable. A custom identifier is
 * accepted when it is syntactically valid and not listed for **another** runtime; whether it
 * exists is decided by the CLI when a run or turn starts.
 */
export const describeModelSelectionProblem = (
  runtime: AgentRuntime,
  modelId: string | null,
): string | null => {
  if (modelId === null) {
    return null;
  }
  if (!modelIdPattern.test(modelId)) {
    return 'A model ID may contain only letters, digits and . _ : / @ [ ] - and must start with a letter or digit.';
  }
  const other = otherRuntimeListing(runtime, modelId);
  if (other !== undefined && findCatalogModel(runtime, modelId) === undefined) {
    return `"${modelId}" is a ${runtimeNames[other.runtime]} model. Choose a ${runtimeNames[runtime]} model or Default.`;
  }
  return null;
};
