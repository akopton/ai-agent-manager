import type { AgentOutputEvent } from './contract.js';
import type { CliDefinition } from './discovery.js';
import { createAdapter, type AdapterSpecification } from './invocation.js';
import { truncateText } from './line-splitter.js';
import {
  createJsonLineParser,
  identifierField,
  isRecord,
  outputTextLimits,
  shortText,
  stringField,
  type JsonRecord,
  type ParserState,
} from './output-parsing.js';
import { getRuntimeSecurityProfile } from './security-profiles.js';

const securityProfile = getRuntimeSecurityProfile('claude');

/**
 * `--print` needs `--verbose` for `stream-json` (the 2.1.317 binary refuses otherwise). Output
 * options do not change permissions; they are appended after the profile arguments.
 */
const outputArguments = ['--output-format', 'stream-json', '--verbose'] as const;

const definition: CliDefinition = {
  runtime: 'claude',
  displayName: 'Claude Code',
  executableName: 'claude',
  versionPattern: /^(\S+) \(Claude Code\)$/,
  minimumVersion: '2.1.317',
  helpArguments: ['--help'],
  requiredOptions: [
    ...securityProfile.launchArguments.filter((argument) => argument.startsWith('--')),
    '--output-format',
    '--verbose',
  ],
  // Conversation Mode (C2) options are recorded so `prepareConversationTurn` can require them.
  optionalOptions: [
    '--model',
    '--resume',
    '--session-id',
    '--tools',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--safe-mode',
  ],
  // Location of Claude Code's own configuration and login; never API keys.
  environmentNames: ['CLAUDE_CONFIG_DIR'],
};

/** Event types that are understood but produce no normalized output. */
const ignoredTypes = new Set(['stream_event', 'rate_limit_event', 'keep_alive']);

const maxTrackedTools = 1000;

const mapAssistant = (event: JsonRecord, toolNames: Map<string, string>): AgentOutputEvent[] => {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return [];
  }
  const events: AgentOutputEvent[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) {
      continue;
    }
    const blockType = stringField(block, 'type');
    if (blockType === 'text') {
      const text = stringField(block, 'text') ?? '';
      if (text.trim() !== '') {
        events.push({ type: 'message', ...truncateText(text, outputTextLimits.message) });
      }
    } else if (blockType === 'tool_use') {
      const toolId = identifierField(block, 'id');
      const toolName = identifierField(block, 'name') ?? 'unknown';
      if (toolId !== undefined && toolNames.size < maxTrackedTools) {
        toolNames.set(toolId, toolName);
      }
      // Tool input may contain file contents or secrets; only the tool name is reported.
      events.push({
        type: 'tool_activity',
        phase: 'started',
        toolName,
        ...(toolId === undefined ? {} : { toolId }),
      });
    }
  }
  return events;
};

const createClaudeParser = () => {
  // Tool names, per run, for matching tool results to their tool_use blocks.
  const toolNames = new Map<string, string>();
  return createJsonLineParser((event, type, state: ParserState) => {
    switch (type) {
      case 'system': {
        if (stringField(event, 'subtype') !== 'init') {
          return [];
        }
        const sessionId = identifierField(event, 'session_id');
        const reportedModelId = identifierField(event, 'model');
        if (sessionId === undefined && reportedModelId === undefined) {
          return [];
        }
        return [
          {
            type: 'metadata',
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(reportedModelId === undefined ? {} : { reportedModelId }),
          },
        ];
      }
      case 'assistant':
        return mapAssistant(event, toolNames);
      case 'user': {
        // Only tool results are reported; user text (the prompt) is never echoed into events.
        const message = event.message;
        if (!isRecord(message) || !Array.isArray(message.content)) {
          return [];
        }
        return message.content.flatMap((block): AgentOutputEvent[] => {
          if (!isRecord(block) || stringField(block, 'type') !== 'tool_result') {
            return [];
          }
          const toolId = identifierField(block, 'tool_use_id');
          return [
            {
              type: 'tool_activity',
              phase: block.is_error === true ? 'failed' : 'completed',
              toolName: (toolId === undefined ? undefined : toolNames.get(toolId)) ?? 'unknown',
              ...(toolId === undefined ? {} : { toolId }),
            },
          ];
        });
      }
      case 'result': {
        const subtype = stringField(event, 'subtype') ?? 'unknown';
        const result = stringField(event, 'result');
        if (subtype === 'success' && event.is_error !== true) {
          state.outcome = {
            status: 'succeeded',
            ...(result === undefined || result.trim() === ''
              ? {}
              : { summary: truncateText(result, outputTextLimits.summary).text }),
          };
        } else {
          const errors = Array.isArray(event.errors)
            ? event.errors.filter((entry): entry is string => typeof entry === 'string')
            : [];
          const detail = [result, ...errors].filter((part) => part !== undefined && part !== '');
          state.outcome = {
            status: 'failed',
            message: shortText(
              `Claude Code reported ${subtype}${detail.length > 0 ? `: ${detail.join(' ')}` : ''}`,
              outputTextLimits.notice,
            ),
          };
        }
        const sessionId = identifierField(event, 'session_id');
        return sessionId === undefined ? [] : [{ type: 'metadata', sessionId }];
      }
      default:
        return ignoredTypes.has(type) ? [] : null;
    }
  });
};

/**
 * Claude Code adapter. Non-interactive `--print` run with the `claude-print-restricted` profile,
 * `stream-json` events, the prompt on stdin, and an optional `--model`.
 */
export const claudeAdapterSpecification: AdapterSpecification = {
  definition,
  securityProfile,
  outputArguments,
  trailingArguments: [],
  forbiddenOptions: [
    '--fallback-model',
    '--resume',
    '-r',
    '--continue',
    '-c',
    '--fork-session',
    '--worktree',
    '-w',
    '--background',
    '--bg',
    '--cloud',
    '--remote-control',
    '--tools',
    '--allowedTools',
    '--allowed-tools',
    '--mcp-config',
    '--plugin-dir',
    '--plugin-url',
    '--agents',
    '--setting-sources',
  ],
  capabilities: (installation) => ({
    runtime: 'claude',
    executionMode: true,
    conversationMode: [
      '--tools',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--safe-mode',
    ].every((option) => installation.detectedOptions.includes(option)),
    structuredEvents: true,
    explicitModelSelection: installation.detectedOptions.includes('--model'),
    sessionIdReporting: true,
    reportedModelMetadata: true,
    toolActivityEvents: true,
    sessionResume: installation.detectedOptions.includes('--resume')
      ? {
          status: 'unverified',
          reason: 'The CLI lists --resume; resuming a stopped run has not been verified.',
        }
      : { status: 'unsupported', reason: 'The CLI does not list --resume.' },
  }),
  createOutputParser: () => createClaudeParser(),
};

export const claudeAdapter = createAdapter(claudeAdapterSpecification);
