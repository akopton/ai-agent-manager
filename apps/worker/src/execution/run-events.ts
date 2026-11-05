import type { AgentEvent } from '@ai-agent-manager/agents';
import { redactSecrets, truncateText } from '@ai-agent-manager/core';

// Normalizes agent and worker events into bounded, redacted payloads for `run_events`. Prompts,
// environment values and tool inputs never reach this module (the launch boundary does not emit
// them). Agent output is untrusted text: it is truncated and common secret shapes are masked,
// which reduces but does not eliminate the chance of storing a credential the agent printed.

export type RecordedEvent = { kind: string; payload: Record<string, unknown> };

const text = (value: string, max: number): string => redactSecrets(truncateText(value, max));

export const normalizeAgentEvent = (event: AgentEvent): RecordedEvent => {
  switch (event.type) {
    case 'started':
      return {
        kind: 'agent_started',
        payload: {
          pid: event.pid,
          processGroupId: event.processGroupId,
          securityMode: event.securityMode,
          processContainment: event.processContainment,
        },
      };
    case 'message':
      return {
        kind: 'message',
        payload: { text: text(event.text, 4_000), truncated: event.truncated },
      };
    case 'tool_activity':
      return {
        kind: 'tool_activity',
        payload: {
          phase: event.phase,
          toolName: truncateText(event.toolName, 64),
          ...(event.detail === undefined ? {} : { detail: text(event.detail, 300) }),
        },
      };
    case 'metadata':
      return {
        kind: 'metadata',
        payload: {
          sessionIdReported: event.sessionId !== undefined,
          ...(event.reportedModelId === undefined
            ? {}
            : { reportedModelId: truncateText(event.reportedModelId, 200) }),
        },
      };
    case 'provider_notice':
      return { kind: 'provider_notice', payload: { message: text(event.message, 1_000) } };
    case 'stderr':
      return { kind: 'stderr', payload: { text: text(event.text, 1_000) } };
    case 'diagnostic':
      return {
        kind: 'diagnostic',
        payload: { code: event.code, message: text(event.message, 500) },
      };
    case 'stopping':
      return { kind: 'agent_stopping', payload: { reason: event.reason } };
    case 'completed':
    case 'failed':
    case 'stopped': {
      const { result } = event;
      return {
        kind: `agent_${event.type}`,
        payload: {
          status: result.status,
          ...(result.status === 'failed'
            ? { code: result.code, message: text(result.message, 500) }
            : {}),
          exitCode: result.exitCode,
          signal: result.signal,
          lingeringProcesses: result.lingeringProcesses,
          processContainment: result.processContainment,
          securityMode: result.securityMode,
        },
      };
    }
    default: {
      const unknown: never = event;
      return { kind: 'unknown', payload: { type: String((unknown as { type?: unknown }).type) } };
    }
  }
};
