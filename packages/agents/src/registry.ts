import type { AgentRuntime } from '@ai-agent-manager/core';
import { claudeAdapter } from './claude-adapter.js';
import type { AgentAdapter } from './contract.js';
import { codexAdapter } from './codex-adapter.js';

/** One adapter per runtime; models are selected per request, not through separate profiles. */
export const agentAdapters: Readonly<Record<AgentRuntime, AgentAdapter>> = Object.freeze({
  claude: claudeAdapter,
  codex: codexAdapter,
});

export const getAgentAdapter = (runtime: AgentRuntime): AgentAdapter => agentAdapters[runtime];
