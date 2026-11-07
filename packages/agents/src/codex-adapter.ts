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

const securityProfile = getRuntimeSecurityProfile('codex');

const definition: CliDefinition = {
  runtime: 'codex',
  displayName: 'Codex CLI',
  executableName: 'codex',
  versionPattern: /^codex-cli (\S+)$/,
  minimumVersion: '0.166.0',
  helpArguments: ['exec', '--help'],
  // The profile already contains `--json`; no further output options are needed.
  requiredOptions: securityProfile.launchArguments.filter((argument) => argument.startsWith('--')),
  // Conversation Mode (C2) options are recorded so `prepareConversationTurn` can require them.
  optionalOptions: ['--model', '--ephemeral', '--skip-git-repo-check'],
  // Location of Codex's own configuration and login; never API keys.
  environmentNames: ['CODEX_HOME'],
};

type ItemPhase = 'started' | 'updated' | 'completed';

const toolPhase = (item: JsonRecord, phase: ItemPhase): 'started' | 'completed' | 'failed' => {
  if (phase === 'started') {
    return 'started';
  }
  const status = stringField(item, 'status');
  if (status === 'failed' || status === 'declined') {
    return 'failed';
  }
  const exitCode = item.exit_code;
  return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'completed';
};

const fileChangeDetail = (item: JsonRecord): string | undefined => {
  if (!Array.isArray(item.changes)) {
    return undefined;
  }
  const paths = item.changes
    .filter(isRecord)
    .map((change) => {
      const path = stringField(change, 'path');
      const kind = stringField(change, 'kind');
      return path === undefined ? undefined : `${kind ?? 'change'} ${path}`;
    })
    .filter((entry): entry is string => entry !== undefined);
  return paths.length === 0 ? undefined : shortText(paths.join(', '), outputTextLimits.detail);
};

const tool = (
  item: JsonRecord,
  phase: ItemPhase,
  toolName: string,
  detail: string | undefined,
): AgentOutputEvent[] => {
  // `item.updated` repeats in-progress state (for example aggregated command output); skipped.
  if (phase === 'updated') {
    return [];
  }
  const toolId = identifierField(item, 'id');
  return [
    {
      type: 'tool_activity',
      phase: toolPhase(item, phase),
      toolName,
      ...(toolId === undefined ? {} : { toolId }),
      ...(detail === undefined || detail === '' ? {} : { detail }),
    },
  ];
};

const mapItem = (
  item: JsonRecord,
  phase: ItemPhase,
  state: ParserState,
  messages: { last: string | null },
): AgentOutputEvent[] => {
  switch (stringField(item, 'type')) {
    case 'agent_message': {
      const text = stringField(item, 'text') ?? '';
      if (phase !== 'completed' || text.trim() === '') {
        return [];
      }
      messages.last = text;
      return [{ type: 'message', ...truncateText(text, outputTextLimits.message) }];
    }
    case 'command_execution': {
      const command = stringField(item, 'command');
      return tool(
        item,
        phase,
        'command',
        command === undefined ? undefined : shortText(command, outputTextLimits.detail),
      );
    }
    case 'file_change':
      return phase === 'completed' ? tool(item, phase, 'file_change', fileChangeDetail(item)) : [];
    case 'mcp_tool_call': {
      const server = identifierField(item, 'server') ?? 'unknown';
      const name = identifierField(item, 'tool') ?? 'unknown';
      return tool(item, phase, `mcp:${server}/${name}`, undefined);
    }
    case 'web_search': {
      const query = stringField(item, 'query');
      return tool(
        item,
        phase,
        'web_search',
        query === undefined ? undefined : shortText(query, outputTextLimits.detail),
      );
    }
    case 'error': {
      const message = shortText(stringField(item, 'message') ?? 'error', outputTextLimits.notice);
      state.lastNotice = message;
      return [{ type: 'provider_notice', message }];
    }
    default:
      // reasoning, todo_list, and item types added by newer versions produce no output.
      return [];
  }
};

const createCodexParser = () => {
  const messages: { last: string | null } = { last: null };
  return createJsonLineParser((event, type, state) => {
    switch (type) {
      case 'thread.started': {
        const sessionId = identifierField(event, 'thread_id');
        return sessionId === undefined ? [] : [{ type: 'metadata', sessionId }];
      }
      case 'turn.started':
        return [];
      case 'turn.completed':
        state.outcome = {
          status: 'succeeded',
          ...(messages.last === null
            ? {}
            : { summary: truncateText(messages.last, outputTextLimits.summary).text }),
        };
        return [];
      case 'turn.failed': {
        const error = event.error;
        const message = isRecord(error) ? stringField(error, 'message') : undefined;
        state.outcome = {
          status: 'failed',
          message: shortText(
            `Codex reported a failed turn${message === undefined ? '' : `: ${message}`}`,
            outputTextLimits.notice,
          ),
        };
        return [];
      }
      case 'error': {
        // Not necessarily fatal (Codex reports reconnect attempts this way); the turn outcome decides.
        const message = shortText(
          stringField(event, 'message') ?? 'error',
          outputTextLimits.notice,
        );
        state.lastNotice = message;
        return [{ type: 'provider_notice', message }];
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = event.item;
        if (!isRecord(item)) {
          return [];
        }
        return mapItem(item, type.slice('item.'.length) as ItemPhase, state, messages);
      }
      default:
        return null;
    }
  });
};

/**
 * Codex adapter. `codex exec` with the `codex-exec-workspace-write` profile (which includes
 * `--json`), an optional `--model`, and the prompt read from stdin (`-`).
 */
export const codexAdapterSpecification: AdapterSpecification = {
  definition,
  securityProfile,
  outputArguments: [],
  trailingArguments: ['-'],
  forbiddenOptions: [
    '--oss',
    '--local-provider',
    '--image',
    '-i',
    '--output-schema',
    '--output-last-message',
    '-o',
    '--skip-git-repo-check',
    '--cyber-access-program',
    '--thread-source',
  ],
  capabilities: (installation) => ({
    runtime: 'codex',
    executionMode: true,
    conversationMode: ['--ephemeral', '--skip-git-repo-check'].every((option) =>
      installation.detectedOptions.includes(option),
    ),
    structuredEvents: true,
    explicitModelSelection: installation.detectedOptions.includes('--model'),
    sessionIdReporting: true,
    // `codex exec --json` does not report the effective model.
    reportedModelMetadata: false,
    toolActivityEvents: true,
    sessionResume: {
      status: 'unverified',
      reason: '`codex exec resume` exists; resuming a stopped run has not been verified.',
    },
  }),
  createOutputParser: () => createCodexParser(),
};

export const codexAdapter = createAdapter(codexAdapterSpecification);
