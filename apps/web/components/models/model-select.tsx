'use client';

import { useState } from 'react';
import { modelCatalogVersion, type AgentRuntime } from '@ai-agent-manager/core';

import { Input, NativeSelect } from '@/components/ui/input';
import {
  customModelOption,
  defaultModelOption,
  modelChoiceFor,
  modelOptionsFor,
  selectValueFor,
  valueForSelection,
} from '@/lib/models/model-selection';
import { agentRuntimeLabels } from '@/lib/tasks/board';

type ModelSelectProps = {
  id: string;
  runtime: AgentRuntime;
  /** `''` = Default; otherwise the exact CLI model identifier. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
};

/**
 * Provider-specific model selector: Default (recommended), the curated catalog of the selected
 * runtime, or a custom model ID. Render it with `key={runtime}` so switching the runtime starts
 * from a fresh state; the forms reset the value to Default themselves.
 */
export const ModelSelect = ({
  id,
  runtime,
  value,
  onChange,
  disabled = false,
  invalid = false,
  describedBy,
}: ModelSelectProps) => {
  // Opened explicitly, or showing a stored identifier that is not in the catalog.
  const [customOpen, setCustomOpen] = useState(modelChoiceFor(runtime, value).kind === 'custom');
  const selected = selectValueFor(runtime, value, customOpen);
  const options = modelOptionsFor(runtime);
  const aliases = options.filter((model) => model.kind === 'alias');
  const pinned = options.filter((model) => model.kind === 'model');
  const choice = modelChoiceFor(runtime, value);

  return (
    <div className="space-y-2">
      <NativeSelect
        id={id}
        name="modelChoice"
        value={selected}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setCustomOpen(next === customModelOption);
          onChange(valueForSelection(runtime, value, next));
        }}
        aria-invalid={invalid}
        aria-describedby={describedBy}
      >
        <option value={defaultModelOption}>Default (recommended) — CLI configuration</option>
        {aliases.length > 0 ? (
          <optgroup label={`${agentRuntimeLabels[runtime]} aliases`}>
            {aliases.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} · {model.id}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label={`${agentRuntimeLabels[runtime]} models`}>
          {pinned.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label} · {model.id}
            </option>
          ))}
        </optgroup>
        <option value={customModelOption}>Custom model ID…</option>
      </NativeSelect>
      {selected === customModelOption ? (
        <Input
          id={`${id}-custom`}
          name="modelId"
          aria-label="Custom model ID"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={200}
          disabled={disabled}
          placeholder="Exact CLI model ID, for example claude-opus-5-5"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid}
          aria-describedby={describedBy}
        />
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        {choice.kind === 'catalog'
          ? `${choice.model.description} `
          : choice.kind === 'custom'
            ? 'Passed to the CLI exactly as entered. '
            : null}
        Listed models are not guaranteed to be available to your account; the CLI decides when it
        runs, and an unavailable model fails without fallback. Catalog {modelCatalogVersion}.
      </p>
    </div>
  );
};
