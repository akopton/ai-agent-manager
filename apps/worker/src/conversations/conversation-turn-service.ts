import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  getAgentAdapter,
  prepareConversationTurn,
  startConversationTurn,
  type AgentEvent,
  type AgentHandle,
  type AgentRunResult,
  type CliDetectionOptions,
  type ExecutionLimits,
} from '@ai-agent-manager/agents';
import {
  cliLoginHint,
  composeConversationPrompt,
  conversationDisclosure,
  conversationQueuedTurnMaxAgeMs,
  conversationTurnTimeoutMs,
  evaluateConversationConsent,
  isCliAuthenticationFailure,
  truncateText,
  type AgentRuntime,
  type ConversationTurnErrorCode,
} from '@ai-agent-manager/core';
import {
  claimConversationTurn,
  expireQueuedConversationTurns,
  findConversationTurn,
  finishConversationTurn,
  getConversationConsent,
  listProjects,
  listRunningConversationTurns,
  listStoppingConversationTurns,
  updateConversationTurnProgress,
  type ClaimedConversationTurn,
  type ConversationTurnFinish,
  type DatabaseConnection,
} from '@ai-agent-manager/database';
import { authorizeConversationTurn } from '@ai-agent-manager/orchestrator';
import type { Logger } from '../logger.js';

// Worker side of C2: claims queued conversation turns and runs each through the conversation
// gate and launch boundary, in a fresh, private, empty scratch directory that is removed again
// afterwards. It never creates a worktree, never touches a repository, task, run or worker
// command, and never publishes. Prompts and replies are never logged.

type Database = DatabaseConnection['db'];

export type ConversationStopReason = 'operator' | 'shutdown';

export type ConversationTurnServiceOptions = {
  db: Database;
  logger: Logger;
  workerInstanceId: string;
  /** Directory for per-turn scratch directories; created with mode 0700 when missing. */
  scratchRoot: string;
  /** Managed worktree root; a scratch directory may never overlap it. */
  worktreeRoot: string;
  /** The SQLite file; a scratch directory may never contain it. */
  databasePath?: string;
  now?: () => number;
  /** Conversation slots per CLI (separate from task execution slots). Default 1. */
  maxActivePerRuntime?: number;
  turnTimeoutMs?: number;
  queuedMaxAgeMs?: number;
  /** @internal Tests only: fake CLIs. */
  detectionOptions?: Partial<Record<AgentRuntime, CliDetectionOptions>>;
  /** @internal Tests only: tighter limits. */
  limits?: Partial<ExecutionLimits>;
};

export type ConversationTurnService = {
  /** Marks turns left running by another worker instance as interrupted; never resumes them. */
  reconcile: () => void;
  /** Expires stale queued turns, forwards Stop requests and starts claimable turns. */
  poll: () => void;
  /** Stops every active turn and waits until each is recorded. */
  stopAll: (reason: ConversationStopReason) => Promise<void>;
  /** Resolves when no turn is active; for tests. */
  idle: () => Promise<void>;
  readonly activeCount: number;
};

type ActiveTurn = {
  turnId: string;
  handle: AgentHandle | null;
  stopReason: ConversationStopReason | null;
  done: Promise<void>;
};

type Failure = { errorCode: ConversationTurnErrorCode; errorMessage: string };

const runtimeNames: Readonly<Record<AgentRuntime, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const contains = (parent: string, child: string): boolean => {
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
};

/** Maps a CLI failure to an actionable, stored explanation. Never invents a reply. */
export const describeCliFailure = (
  runtime: AgentRuntime,
  modelId: string | null,
  result: Extract<AgentRunResult, { status: 'failed' }>,
): Failure => {
  const name = runtimeNames[runtime];
  switch (result.code) {
    case 'timeout':
      return {
        errorCode: 'timeout',
        errorMessage: `${name} did not finish within ${Math.round(conversationTurnTimeoutMs / 60_000)} minutes and was stopped. No reply was stored.`,
      };
    case 'output_limit_exceeded':
      return {
        errorCode: 'output_limit_exceeded',
        errorMessage: `${name} produced more output than allowed and was stopped. No reply was stored.`,
      };
    case 'model_unavailable':
      return {
        errorCode: 'model_unavailable',
        errorMessage: `${name} rejected the model "${modelId ?? 'Default'}": ${result.message} Choose Default or another model in the conversation settings, then retry.`,
      };
    case 'spawn_failed':
      return {
        errorCode: 'cli_unavailable',
        errorMessage: `${name} could not be started: ${result.message}`,
      };
    default:
      if (isCliAuthenticationFailure(result.message)) {
        return {
          errorCode: 'cli_auth_required',
          errorMessage: `${name} is not signed in or its login expired. ${cliLoginHint[runtime]} (${result.message})`,
        };
      }
      return {
        errorCode: result.code === 'provider_error' ? 'provider_error' : 'cli_failed',
        errorMessage: `${name} failed: ${result.message}`,
      };
  }
};

export const createConversationTurnService = (
  options: ConversationTurnServiceOptions,
): ConversationTurnService => {
  const { db, logger, workerInstanceId } = options;
  const now = options.now ?? Date.now;
  const turnTimeoutMs = options.turnTimeoutMs ?? conversationTurnTimeoutMs;
  const queuedMaxAgeMs = options.queuedMaxAgeMs ?? conversationQueuedTurnMaxAgeMs;
  const active = new Map<string, ActiveTurn>();

  const finish = (turnId: string, value: ConversationTurnFinish): void => {
    try {
      finishConversationTurn(db, turnId, value, { createMessageId: randomUUID });
    } catch (error) {
      logger.error(`Conversation turn ${turnId}: the outcome could not be recorded.`, error);
    }
  };

  const failed = (
    failure: Failure,
    extra: {
      exitCode?: number | null;
      signal?: string | null;
      effectiveModelId?: string | null;
    } = {},
  ): ConversationTurnFinish => ({
    status: 'failed',
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
    exitCode: extra.exitCode ?? null,
    signal: extra.signal ?? null,
    effectiveModelId: extra.effectiveModelId ?? null,
    endedAt: now(),
  });

  const stopped = (
    reason: ConversationStopReason,
    signal: string | null,
  ): ConversationTurnFinish =>
    reason === 'operator'
      ? {
          status: 'cancelled',
          errorCode: null,
          errorMessage: 'Stopped by you. No reply was stored.',
          exitCode: null,
          signal,
          effectiveModelId: null,
          endedAt: now(),
        }
      : {
          status: 'interrupted',
          errorCode: 'worker_shutdown',
          errorMessage:
            'The worker shut down while the reply was being generated. It is not retried automatically.',
          exitCode: null,
          signal,
          effectiveModelId: null,
          endedAt: now(),
        };

  const protectedPaths = (): string[] => [
    options.worktreeRoot,
    ...(options.databasePath === undefined ? [] : [options.databasePath]),
    ...listProjects(db).flatMap((project) => [project.localPath, project.gitCommonDir]),
  ];

  const createScratchDirectory = async (): Promise<{ root: string; path: string }> => {
    await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(options.scratchRoot);
    const path = await realpath(await mkdtemp(join(root, 'turn-')));
    return { root, path };
  };

  const runOne = async (claim: ClaimedConversationTurn, entry: ActiveTurn): Promise<void> => {
    const { turn, userMessage } = claim;
    const runtime = turn.agentRuntime;
    // Assigned inside `execute`; a holder keeps TypeScript from narrowing it to `null` here.
    const scratchHolder: { current: { root: string; path: string } | null } = { current: null };

    const execute = async (): Promise<ConversationTurnFinish> => {
      const { prompt, manifest } = composeConversationPrompt({
        runtime,
        languageMode: turn.languageMode,
        history: claim.history,
        message: userMessage.content,
        notesExcluded: claim.notesExcluded,
      });
      updateConversationTurnProgress(
        db,
        turn.id,
        { contextManifestJson: JSON.stringify(manifest) },
        now(),
      );

      const adapter = getAgentAdapter(runtime);
      const detection = await adapter.detect(options.detectionOptions?.[runtime]);
      if (detection.status !== 'available') {
        return failed({
          errorCode: 'cli_unavailable',
          errorMessage: `${detection.message} Install ${runtimeNames[runtime]} and make sure the worker's PATH contains it, then retry.`,
        });
      }
      const { installation } = detection;
      updateConversationTurnProgress(db, turn.id, { cliVersion: installation.version }, now());

      const scratch = await createScratchDirectory();
      scratchHolder.current = scratch;
      const request = {
        turnId: turn.id,
        prompt,
        modelId: turn.requestedModelId,
        scratchDirectory: scratch.path,
      };
      const preparation = prepareConversationTurn(installation, request);
      if (!preparation.ok) {
        return failed({
          errorCode:
            preparation.code === 'conversation_profile_unsupported'
              ? 'conversation_profile_unsupported'
              : preparation.code === 'model_invalid' ||
                  preparation.code === 'model_selection_unsupported'
                ? 'model_unavailable'
                : 'launch_rejected',
          errorMessage: preparation.message,
        });
      }
      const { plan } = preparation;
      updateConversationTurnProgress(db, turn.id, { launchProfileId: plan.launchProfileId }, now());

      // Consent is re-read from persisted operator state immediately before the gate.
      const consent = getConversationConsent(db);
      const decision = evaluateConversationConsent(consent);
      if (!decision.ok || consent.disclosureVersion === null || consent.acceptedAt === null) {
        return failed({
          errorCode: decision.ok ? 'conversation_ai_disabled' : decision.code,
          errorMessage: decision.ok ? 'AI replies are off.' : decision.message,
        });
      }
      const acceptance = {
        disclosureVersion: consent.disclosureVersion,
        acceptedAt: new Date(consent.acceptedAt).toISOString(),
      };
      const authorization = await authorizeConversationTurn(
        {
          policy: { mode: 'trusted_local', version: 1, acceptance, timeoutMs: turnTimeoutMs },
          turn: { turnId: turn.id, prompt },
          runtime,
          installation,
          modelId: turn.requestedModelId,
          invocation: plan.invocation,
          scratchDirectory: scratch.path,
        },
        {
          enabled: consent.enabled,
          currentDisclosureVersion: conversationDisclosure.version,
          acceptance,
          scratchRoot: scratch.root,
          protectedPaths: protectedPaths(),
        },
      );
      if (!authorization.authorized) {
        const codes = [...new Set(authorization.denials.map((denial) => denial.code))];
        return failed({
          errorCode: 'authorization_denied',
          errorMessage: `The conversation gate refused this turn (${codes.join(', ')}): ${
            authorization.denials[0]?.message ?? ''
          }`,
        });
      }
      if (entry.stopReason !== null) {
        return stopped(entry.stopReason, null);
      }

      const messages: string[] = [];
      let reportedModelId: string | null = null;
      const emit = (event: AgentEvent): void => {
        if (event.type === 'message') {
          messages.push(event.text);
        } else if (event.type === 'metadata' && event.reportedModelId !== undefined) {
          reportedModelId = truncateText(event.reportedModelId, 200);
        }
      };
      const started = await startConversationTurn({
        installation,
        request,
        authorization: authorization.authorization,
        emit,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });
      if (!started.started) {
        return failed({
          errorCode: 'launch_rejected',
          errorMessage: `The launch boundary refused the turn (${started.code}): ${started.message}`,
        });
      }
      entry.handle = started.handle;
      updateConversationTurnProgress(
        db,
        turn.id,
        { pid: started.handle.pid, startedAt: now() },
        now(),
      );
      logger.info(
        `Conversation turn ${turn.id}: started ${runtime} (pid ${started.handle.pid ?? 'unknown'}, own process group).`,
      );
      if (entry.stopReason !== null) {
        void started.handle.stop();
      }
      const result = await started.handle.completed;
      const effectiveModelId = reportedModelId ?? result.reportedModelId ?? null;
      if (result.status === 'stopped') {
        return stopped(entry.stopReason ?? 'operator', result.signal);
      }
      if (result.status === 'failed') {
        return failed(describeCliFailure(runtime, turn.requestedModelId, result), {
          exitCode: result.exitCode,
          signal: result.signal,
          effectiveModelId,
        });
      }
      const reply = messages.join('\n\n').trim();
      if (reply === '') {
        return failed(
          {
            errorCode: 'empty_reply',
            errorMessage: `${runtimeNames[runtime]} finished without a reply. Nothing was stored; retry or rephrase the message.`,
          },
          { exitCode: result.exitCode, effectiveModelId },
        );
      }
      return {
        status: 'completed',
        reply,
        effectiveModelId,
        exitCode: result.exitCode,
        endedAt: now(),
      };
    };

    let outcome: ConversationTurnFinish;
    try {
      outcome = await execute();
    } catch (error) {
      logger.error(`Conversation turn ${turn.id}: the worker failed.`, error);
      if (entry.handle !== null) {
        await entry.handle.stop().catch(() => null);
      }
      outcome = failed({
        errorCode: 'worker_error',
        errorMessage: 'The worker failed while handling this turn. No reply was stored.',
      });
    }
    // An operator Stop recorded while the CLI was finishing still wins over a late reply.
    if (
      findConversationTurn(db, turn.id)?.status === 'stopping' &&
      outcome.status !== 'completed'
    ) {
      outcome = stopped('operator', outcome.status === 'cancelled' ? outcome.signal : null);
    }
    finish(turn.id, outcome);
    logger.info(`Conversation turn ${turn.id}: ${outcome.status}.`);
    const directory = scratchHolder.current;
    if (directory !== null && contains(directory.root, directory.path)) {
      await rm(directory.path, { recursive: true, force: true }).catch((error: unknown) =>
        logger.error(`Conversation turn ${turn.id}: the scratch directory was not removed.`, error),
      );
    }
  };

  const start = (claim: ClaimedConversationTurn): void => {
    let resolveDone: () => void = () => undefined;
    const entry: ActiveTurn = {
      turnId: claim.turn.id,
      handle: null,
      stopReason: null,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
    };
    active.set(claim.turn.id, entry);
    void runOne(claim, entry)
      .catch((error: unknown) =>
        logger.error(`Conversation turn ${claim.turn.id}: finishing failed.`, error),
      )
      .finally(() => {
        active.delete(claim.turn.id);
        resolveDone();
      });
  };

  const requestStop = (turnId: string, reason: ConversationStopReason): void => {
    const entry = active.get(turnId);
    if (entry === undefined || entry.stopReason !== null) return;
    entry.stopReason = reason;
    const { handle } = entry;
    if (handle !== null) {
      setImmediate(() => void handle.stop().catch(() => undefined));
    }
  };

  const reconcile = (): void => {
    for (const turn of listRunningConversationTurns(db)) {
      if (turn.workerInstanceId === workerInstanceId) continue;
      finish(turn.id, {
        status: 'interrupted',
        errorCode: 'worker_restarted',
        errorMessage: `The worker restarted while this reply was ${turn.status === 'stopping' ? 'stopping' : 'being generated'}. No reply was stored and it is not retried automatically.${
          turn.pid === null
            ? ''
            : ` The CLI process group (pid ${turn.pid}) was not signalled after the restart.`
        }`,
        exitCode: null,
        signal: null,
        effectiveModelId: null,
        endedAt: now(),
      });
      logger.info(`Conversation turn ${turn.id} was left ${turn.status}; marked interrupted.`);
    }
  };

  const poll = (): void => {
    expireQueuedConversationTurns(db, { olderThan: now() - queuedMaxAgeMs, now: now() });
    for (const turn of listStoppingConversationTurns(db, workerInstanceId)) {
      requestStop(turn.id, 'operator');
    }
    for (;;) {
      const result = claimConversationTurn(db, {
        workerInstanceId,
        now: now(),
        maxActivePerRuntime: options.maxActivePerRuntime ?? 1,
      });
      if (!result.claimed) return;
      logger.info(`Conversation turn ${result.claim.turn.id} claimed.`);
      start(result.claim);
    }
  };

  const stopAll = async (reason: ConversationStopReason): Promise<void> => {
    const entries = [...active.values()];
    for (const entry of entries) requestStop(entry.turnId, reason);
    await Promise.all(entries.map((entry) => entry.done));
  };

  return {
    reconcile,
    poll,
    stopAll,
    idle: async () => {
      await Promise.all([...active.values()].map((entry) => entry.done));
    },
    get activeCount() {
      return active.size;
    },
  };
};
