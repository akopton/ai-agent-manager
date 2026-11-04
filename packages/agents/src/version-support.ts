import type { AgentRuntime } from '@ai-agent-manager/core';
import { claudeAdapterSpecification } from './claude-adapter.js';
import { codexAdapterSpecification } from './codex-adapter.js';
import { compareVersions, parseVersionOutput } from './version.js';

const minimumVersions: Readonly<Record<AgentRuntime, string>> = Object.freeze({
  claude: claudeAdapterSpecification.definition.minimumVersion,
  codex: codexAdapterSpecification.definition.minimumVersion,
});

const exactVersion = /^(.+)$/;

/**
 * Whether `version` is a well-formed version at least as new as the oldest version whose
 * command-line interface was assessed for `runtime` (the same minimum discovery enforces). This
 * is a compatibility check, not a security assessment.
 */
export const isSupportedCliVersion = (runtime: AgentRuntime, version: string): boolean => {
  const parsed = parseVersionOutput(version, exactVersion);
  const minimum = parseVersionOutput(minimumVersions[runtime], exactVersion);
  return (
    parsed !== null &&
    minimum !== null &&
    parsed.version === version &&
    compareVersions(parsed, minimum) >= 0
  );
};
