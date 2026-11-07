import {
  describeModelSelectionProblem,
  findCatalogModel,
  modelCatalog,
  type AgentRuntime,
  type CatalogModel,
} from '@ai-agent-manager/core';

// Pure state of the provider-specific model selector shared by the task and conversation forms.
// The form value stays a string: `''` means Default (no `--model`), anything else is the exact CLI
// model identifier that is stored and passed to the CLI. The selector maps it to one of three
// choices: Default, a catalog entry of the selected runtime, or a custom identifier.

/** `<select>` value of the Default option. Matches the forms' `defaultModel`. */
export const defaultModelOption = '';

/** `<select>` value of the "Custom model ID" option; never stored. */
export const customModelOption = '__custom__';

export type ModelChoice =
  | { kind: 'default' }
  | { kind: 'catalog'; model: CatalogModel }
  | { kind: 'custom'; modelId: string };

/** Classifies a stored or entered model value for the given runtime. */
export const modelChoiceFor = (runtime: AgentRuntime, value: string): ModelChoice => {
  const trimmed = value.trim();
  if (trimmed === '') {
    return { kind: 'default' };
  }
  const model = findCatalogModel(runtime, trimmed);
  return model === undefined ? { kind: 'custom', modelId: trimmed } : { kind: 'catalog', model };
};

/** The catalog entries offered for a runtime, in catalog order. */
export const modelOptionsFor = (runtime: AgentRuntime): readonly CatalogModel[] =>
  modelCatalog[runtime];

/**
 * The `<select>` value for the current state. A custom identifier (or an empty custom field the
 * operator just opened) selects the "Custom model ID" option.
 */
export const selectValueFor = (
  runtime: AgentRuntime,
  value: string,
  customOpen: boolean,
): string => {
  const choice = modelChoiceFor(runtime, value);
  if (choice.kind === 'catalog') {
    return choice.model.id;
  }
  if (choice.kind === 'custom' || customOpen) {
    return customModelOption;
  }
  return defaultModelOption;
};

/**
 * The form value after choosing an option. Choosing "Custom model ID" keeps a custom value being
 * edited and otherwise starts empty; Default and catalog entries store their exact identifier.
 */
export const valueForSelection = (
  runtime: AgentRuntime,
  current: string,
  selected: string,
): string => {
  if (selected === customModelOption) {
    return modelChoiceFor(runtime, current).kind === 'custom' ? current : '';
  }
  return selected;
};

/** Human-readable description of a model value, for headers and run details. */
export const describeModelChoice = (runtime: AgentRuntime, modelId: string | null): string => {
  const choice = modelChoiceFor(runtime, modelId ?? '');
  switch (choice.kind) {
    case 'default':
      return 'Default';
    case 'catalog':
      return `${choice.model.label} (${choice.model.id})`;
    case 'custom':
      return `${choice.modelId} (custom)`;
  }
};

/** Client-side check matching the server: syntax, and not a model of the other runtime. */
export const modelValueProblem = (runtime: AgentRuntime, value: string): string | null =>
  describeModelSelectionProblem(runtime, value.trim() === '' ? null : value.trim());
