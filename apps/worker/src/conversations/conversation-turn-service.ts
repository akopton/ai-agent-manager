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
  composeContextPlanningPrompt,
  composeConversationPrompt,
  composeProjectAwarePrompt,
  composeSourceTaskProposalPrompt,
  composeTaskProposalPrompt,
  conversationDisclosure,
  conversationQueuedTurnMaxAgeMs,
  conversationTurnTimeoutMs,
  evaluateConversationConsent,
  findUnverifiedReferences,
  isCliAuthenticationFailure,
  parseRepositoryContextRequest,
  parseTaskProposalOutput,
  truncateText,
  type AgentRuntime,
  type TaskProposalGenerationErrorCode,
} from '@ai-agent-manager/core';
import {
  claimConversationTurn,
  claimTaskProposalGeneration,
  evaluateStoredProjectSourceAccess,
  expireQueuedConversationTurns,
  expireQueuedTaskProposalGenerations,
  findConversationTurn,
  findTaskProposalGenerationById,
  finishConversationTurn,
  finishTaskProposalGeneration,
  getConversationConsent,
  listProjects,
  listRunningConversationTurns,
  listRunningTaskProposalGenerations,
  listStoppingConversationTurns,
  listStoppingTaskProposalGenerations,
  updateConversationTurnProgress,
  updateTaskProposalGenerationProgress,
  type ClaimedConversationTurn,
  type ClaimedTaskProposalGeneration,
  type ConversationTurnFinish,
  type ConversationTurnProgress,
  type DatabaseConnection,
  type TaskProposalGenerationFinish,
} from '@ai-agent-manager/database';
import { authorizeConversationTurn } from '@ai-agent-manager/orchestrator';
import type { Logger } from '../logger.js';
import {
  describeRepositoryFailure,
  fallbackRepositoryPlan,
  prepareRepositoryContext,
  retrieveRepositoryContext,
  type PreparedRepositoryContext,
  type RepositoryContextPlan,
  type RetrievedRepositoryContext,
} from './repository-context.js';

// Worker side of C2 and C3: claims queued conversation turns (chat replies) and task proposal
// generations, and runs each through the conversation gate and launch boundary, in a fresh,
// private, empty scratch directory that is removed again afterwards. Both kinds of work share the
// same pipeline, conversation slot per CLI, Stop, timeout and restart handling. A generation only
// stores validated `draft` proposals; it never creates, queues or starts a task. Nothing here
// creates a worktree, touches a repository, task, run or worker command, or publishes. Prompts,
// replies and proposals are never logged.

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
  /**
   * Marks turns and proposal generations left running by another worker instance as interrupted;
   * never resumes them.
   */
  reconcile: () => void;
  /**
   * Expires stale queued turns and generations, forwards Stop requests and starts claimable work.
   */
  poll: () => void;
  /** Stops every active turn and generation and waits until each is recorded. */
  stopAll: (reason: ConversationStopReason) => Promise<void>;
  /** Resolves when no turn is active; for tests. */
  idle: () => Promise<void>;
  readonly activeCount: number;
};

type ActiveWork = {
  id: string;
  kind: 'turn' | 'generation';
  handle: AgentHandle | null;
  stopReason: ConversationStopReason | null;
  done: Promise<void>;
};

type Failure = { errorCode: TaskProposalGenerationErrorCode; errorMessage: string };

/** The outcome of one supervised CLI run; `completed` carries the reply text. */
type CliOutcome = ConversationTurnFinish;

/** One CLI run of conversation work: a chat turn or a proposal generation. */
type CliJob = {
  id: string;
  runtime: AgentRuntime;
  modelId: string | null;
  prompt: string;
  progress: (progress: ConversationTurnProgress) => void;
  /** Said when nothing was stored, for example "No reply was stored." */
  nothingStored: string;
  /** Message for a CLI that finished without any text. */
  emptyMessage: string;
  /**
   * C4: re-checked immediately before the gate, after the consent; a failure refuses the launch.
   * Project-aware turns use it to re-read the project's source-sharing permission.
   */
  beforeLaunch?: () => Failure | null;
};

const noReply = 'No reply was stored.';
const noProposals = 'No proposals were stored.';

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
  nothingStored = noReply,
): Failure => {
  const name = runtimeNames[runtime];
  switch (result.code) {
    case 'timeout':
      return {
        errorCode: 'timeout',
        errorMessage: `${name} did not finish within ${Math.round(conversationTurnTimeoutMs / 60_000)} minutes and was stopped. ${nothingStored}`,
      };
    case 'output_limit_exceeded':
      return {
        errorCode: 'output_limit_exceeded',
        errorMessage: `${name} produced more output than allowed and was stopped. ${nothingStored}`,
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
  const active = new Map<string, ActiveWork>();

  const finish = (turnId: string, value: ConversationTurnFinish): void => {
    try {
      finishConversationTurn(db, turnId, value, { createMessageId: randomUUID });
    } catch (error) {
      logger.error(`Conversation turn ${turnId}: the outcome could not be recorded.`, error);
    }
  };

  const finishGeneration = (generationId: string, value: TaskProposalGenerationFinish): void => {
    try {
      finishTaskProposalGeneration(db, generationId, value, { createProposalId: randomUUID });
    } catch (error) {
      logger.error(
        `Proposal generation ${generationId}: the outcome could not be recorded.`,
        error,
      );
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
    nothingStored = noReply,
  ): ConversationTurnFinish =>
    reason === 'operator'
      ? {
          status: 'cancelled',
          errorCode: null,
          errorMessage: `Stopped by you. ${nothingStored}`,
          exitCode: null,
          signal,
          effectiveModelId: null,
          endedAt: now(),
        }
      : {
          status: 'interrupted',
          errorCode: 'worker_shutdown',
          errorMessage:
            nothingStored === noReply
              ? 'The worker shut down while the reply was being generated. It is not retried automatically.'
              : `The worker shut down while the proposals were being generated. ${nothingStored} It is not retried automatically.`,
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

  /**
   * Runs one CLI job through detection, the launch preparation, the persisted consent, the
   * conversation gate and the launch boundary, in a fresh scratch directory that is removed
   * afterwards. Returns the outcome; a reply is only returned when the CLI completed with text.
   */
  const runCli = async (job: CliJob, entry: ActiveWork): Promise<CliOutcome> => {
    const { runtime } = job;
    // Assigned inside `execute`; a holder keeps TypeScript from narrowing it to `null` here.
    const scratchHolder: { current: { root: string; path: string } | null } = { current: null };

    const execute = async (): Promise<CliOutcome> => {
      const adapter = getAgentAdapter(runtime);
      const detection = await adapter.detect(options.detectionOptions?.[runtime]);
      if (detection.status !== 'available') {
        return failed({
          errorCode: 'cli_unavailable',
          errorMessage: `${detection.message} Install ${runtimeNames[runtime]} and make sure the worker's PATH contains it, then retry.`,
        });
      }
      const { installation } = detection;
      job.progress({ cliVersion: installation.version });

      const scratch = await createScratchDirectory();
      scratchHolder.current = scratch;
      const request = {
        turnId: job.id,
        prompt: job.prompt,
        modelId: job.modelId,
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
      job.progress({ launchProfileId: plan.launchProfileId });

      // Consent is re-read from persisted operator state immediately before the gate.
      const consent = getConversationConsent(db);
      const decision = evaluateConversationConsent(consent);
      if (!decision.ok || consent.disclosureVersion === null || consent.acceptedAt === null) {
        return failed({
          errorCode: decision.ok ? 'conversation_ai_disabled' : decision.code,
          errorMessage: decision.ok ? 'AI replies are off.' : decision.message,
        });
      }
      const refused = job.beforeLaunch?.() ?? null;
      if (refused !== null) {
        return failed(refused);
      }
      const acceptance = {
        disclosureVersion: consent.disclosureVersion,
        acceptedAt: new Date(consent.acceptedAt).toISOString(),
      };
      const authorization = await authorizeConversationTurn(
        {
          policy: { mode: 'trusted_local', version: 1, acceptance, timeoutMs: turnTimeoutMs },
          turn: { turnId: job.id, prompt: job.prompt },
          runtime,
          installation,
          modelId: job.modelId,
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
        return stopped(entry.stopReason, null, job.nothingStored);
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
      job.progress({ pid: started.handle.pid, startedAt: now() });
      logger.info(
        `${entry.kind === 'turn' ? 'Conversation turn' : 'Proposal generation'} ${job.id}: started ${runtime} (pid ${started.handle.pid ?? 'unknown'}, own process group).`,
      );
      if (entry.stopReason !== null) {
        void started.handle.stop();
      }
      const result = await started.handle.completed;
      const effectiveModelId = reportedModelId ?? result.reportedModelId ?? null;
      if (result.status === 'stopped') {
        return stopped(entry.stopReason ?? 'operator', result.signal, job.nothingStored);
      }
      if (result.status === 'failed') {
        return failed(describeCliFailure(runtime, job.modelId, result, job.nothingStored), {
          exitCode: result.exitCode,
          signal: result.signal,
          effectiveModelId,
        });
      }
      const reply = messages.join('\n\n').trim();
      if (reply === '') {
        return failed(
          { errorCode: 'empty_reply', errorMessage: job.emptyMessage },
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

    let outcome: CliOutcome;
    try {
      outcome = await execute();
    } catch (error) {
      logger.error(`Conversation work ${job.id}: the worker failed.`, error);
      if (entry.handle !== null) {
        await entry.handle.stop().catch(() => null);
      }
      outcome = failed({
        errorCode: 'worker_error',
        errorMessage: `The worker failed while handling this ${entry.kind === 'turn' ? 'turn' : 'proposal request'}. ${job.nothingStored}`,
      });
    }
    const directory = scratchHolder.current;
    if (directory !== null && contains(directory.root, directory.path)) {
      await rm(directory.path, { recursive: true, force: true }).catch((error: unknown) =>
        logger.error(`Conversation work ${job.id}: the scratch directory was not removed.`, error),
      );
    }
    return outcome;
  };

  /** Finishes a turn, letting an operator Stop recorded meanwhile win over a late outcome. */
  const finishTurn = (turnId: string, outcome: CliOutcome): void => {
    let result = outcome;
    if (findConversationTurn(db, turnId)?.status === 'stopping' && outcome.status !== 'completed') {
      result = stopped('operator', outcome.status === 'cancelled' ? outcome.signal : null);
    }
    finish(turnId, result);
    logger.info(`Conversation turn ${turnId}: ${result.status}.`);
  };

  /**
   * C4 — a Project-Aware turn: re-check the source-sharing permission and the repository, list
   * the commit's readable files, let the CLI choose files (planning run, structured JSON request),
   * validate and read bounded excerpts, then run the CLI again for the answer. Both runs use the
   * same gate, launch profile, scratch directory policy, timeout and Stop as a chat turn. Model
   * output can only name files to read; it never triggers any other action.
   */
  const runProjectAwareTurn = async (
    claim: ClaimedConversationTurn,
    entry: ActiveWork,
  ): Promise<void> => {
    const { turn, userMessage, conversation } = claim;
    const name = runtimeNames[turn.agentRuntime];
    const progress = (values: ConversationTurnProgress) =>
      updateConversationTurnProgress(db, turn.id, values, now());
    const accessFailure = (): Failure | null => {
      const access = evaluateStoredProjectSourceAccess(db, conversation.projectId);
      return access.ok
        ? null
        : {
            errorCode: 'source_access_denied',
            errorMessage: `Nothing was sent to the AI. ${access.message}`,
          };
    };
    const stoppedNow = (): CliOutcome | null =>
      entry.stopReason === null ? null : stopped(entry.stopReason, null);

    progress({ contextStage: 'checking_repository' });
    const denied = accessFailure();
    if (denied !== null || claim.repository === null) {
      finishTurn(
        turn.id,
        failed(
          denied ?? {
            errorCode: 'repository_unavailable',
            errorMessage: 'The project repository is unknown. Nothing was sent to the AI.',
          },
        ),
      );
      return;
    }
    let prepared: PreparedRepositoryContext;
    try {
      prepared = await prepareRepositoryContext({
        repository: claim.repository,
        message: userMessage.content,
      });
    } catch (error) {
      logger.error(`Conversation turn ${turn.id}: the repository could not be read.`, error);
      finishTurn(turn.id, failed(describeRepositoryFailure(error)));
      return;
    }
    const early = stoppedNow();
    if (early !== null) {
      finishTurn(turn.id, early);
      return;
    }

    // Planning run: the CLI returns a JSON read request; nothing else is accepted from it.
    progress({ contextStage: 'selecting_files' });
    const planning = await runCli(
      {
        id: turn.id,
        runtime: turn.agentRuntime,
        modelId: turn.requestedModelId,
        prompt: composeContextPlanningPrompt({
          runtime: turn.agentRuntime,
          catalogText: prepared.catalogText,
          history: claim.history,
          message: userMessage.content,
        }),
        progress,
        nothingStored: noReply,
        emptyMessage: `${name} returned no file selection.`,
        beforeLaunch: accessFailure,
      },
      entry,
    );
    entry.handle = null;
    let plan: RepositoryContextPlan;
    if (planning.status === 'completed') {
      const parsed = parseRepositoryContextRequest(planning.reply);
      plan = parsed.ok
        ? {
            selection: 'model',
            selectionNote: parsed.request.note,
            files: parsed.request.files,
            searches: parsed.request.searches,
            ignored: parsed.request.ignored,
          }
        : fallbackRepositoryPlan(
            prepared,
            userMessage.content,
            `${parsed.message} Files were selected by keyword search instead.`,
          );
    } else if (planning.status === 'failed' && planning.errorCode === 'empty_reply') {
      plan = fallbackRepositoryPlan(
        prepared,
        userMessage.content,
        `${name} returned no file selection. Files were selected by keyword search instead.`,
      );
    } else {
      finishTurn(
        turn.id,
        planning.status === 'failed'
          ? {
              ...planning,
              errorMessage: `While choosing repository files: ${planning.errorMessage ?? ''}`,
            }
          : planning,
      );
      return;
    }
    const beforeReading = stoppedNow();
    if (beforeReading !== null) {
      finishTurn(turn.id, beforeReading);
      return;
    }

    // Application-side validation and bounded reads.
    progress({ contextStage: 'reading_files' });
    const recheck = accessFailure();
    if (recheck !== null) {
      finishTurn(turn.id, failed(recheck));
      return;
    }
    let retrieved: RetrievedRepositoryContext;
    try {
      retrieved = await retrieveRepositoryContext(prepared, plan);
    } catch (error) {
      logger.error(`Conversation turn ${turn.id}: reading repository files failed.`, error);
      finishTurn(turn.id, failed(describeRepositoryFailure(error)));
      return;
    }
    const { prompt, manifest } = composeProjectAwarePrompt({
      runtime: turn.agentRuntime,
      languageMode: turn.languageMode,
      history: claim.history,
      message: userMessage.content,
      notesExcluded: claim.notesExcluded,
      record: retrieved.record,
      excerpts: retrieved.excerpts,
    });
    progress({
      contextStage: 'answering',
      contextManifestJson: JSON.stringify(manifest),
      repositoryContextJson: JSON.stringify(retrieved.record),
    });
    const outcome = await runCli(
      {
        id: turn.id,
        runtime: turn.agentRuntime,
        modelId: turn.requestedModelId,
        prompt,
        progress,
        nothingStored: noReply,
        emptyMessage: `${name} finished without a reply. Nothing was stored; retry or rephrase the message.`,
        beforeLaunch: accessFailure,
      },
      entry,
    );
    if (outcome.status === 'completed') {
      // Paths the reply mentions that were not supplied are recorded, never trusted.
      const supplied = new Set(retrieved.record.sources.map((source) => source.path));
      progress({
        repositoryContextJson: JSON.stringify({
          ...retrieved.record,
          unverifiedReferences: findUnverifiedReferences(outcome.reply, supplied),
        }),
      });
    }
    finishTurn(turn.id, outcome);
  };

  const runTurn = async (claim: ClaimedConversationTurn, entry: ActiveWork): Promise<void> => {
    if (claim.turn.contextMode === 'project_aware') {
      await runProjectAwareTurn(claim, entry);
      return;
    }
    const { turn, userMessage } = claim;
    const { prompt, manifest } = composeConversationPrompt({
      runtime: turn.agentRuntime,
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
    let outcome = await runCli(
      {
        id: turn.id,
        runtime: turn.agentRuntime,
        modelId: turn.requestedModelId,
        prompt,
        progress: (progress) => updateConversationTurnProgress(db, turn.id, progress, now()),
        nothingStored: noReply,
        emptyMessage: `${runtimeNames[turn.agentRuntime]} finished without a reply. Nothing was stored; retry or rephrase the message.`,
      },
      entry,
    );
    // An operator Stop recorded while the CLI was finishing still wins over a late reply.
    if (
      findConversationTurn(db, turn.id)?.status === 'stopping' &&
      outcome.status !== 'completed'
    ) {
      outcome = stopped('operator', outcome.status === 'cancelled' ? outcome.signal : null);
    }
    finish(turn.id, outcome);
    logger.info(`Conversation turn ${turn.id}: ${outcome.status}.`);
  };

  /** Turns a completed CLI reply into stored draft proposals, or a `malformed_output` failure. */
  const toGenerationFinish = (outcome: CliOutcome): TaskProposalGenerationFinish => {
    if (outcome.status !== 'completed') {
      return outcome;
    }
    const parsed = parseTaskProposalOutput(outcome.reply);
    if (!parsed.ok) {
      return {
        status: 'failed',
        errorCode: 'malformed_output',
        errorMessage: parsed.message,
        exitCode: outcome.exitCode,
        signal: null,
        effectiveModelId: outcome.effectiveModelId,
        endedAt: outcome.endedAt,
      };
    }
    return {
      status: 'completed',
      proposals: parsed.proposals,
      skippedCount: parsed.skipped.length,
      note: parsed.note,
      effectiveModelId: outcome.effectiveModelId,
      exitCode: outcome.exitCode,
      endedAt: outcome.endedAt,
    };
  };

  const runGeneration = async (
    claim: ClaimedTaskProposalGeneration,
    entry: ActiveWork,
  ): Promise<void> => {
    const { generation } = claim;
    // C3.1: exactly the source reply's snapshot, taken when the request was made. Only a C3
    // generation queued before the upgrade (no source) still uses the answered history.
    const { prompt, manifest } =
      generation.sourceMessageId !== null && generation.sourceContent !== null
        ? composeSourceTaskProposalPrompt({
            runtime: generation.agentRuntime,
            languageMode: generation.languageMode,
            source: {
              messageId: generation.sourceMessageId,
              sequence: generation.basedOnSequence,
              content: generation.sourceContent,
            },
            instructions: generation.instructions,
            sourceReferences: claim.sourceReferences,
          })
        : composeTaskProposalPrompt({
            runtime: generation.agentRuntime,
            languageMode: generation.languageMode,
            history: claim.history,
            instructions: generation.instructions,
            basedOnSequence: generation.basedOnSequence,
            notesExcluded: claim.notesExcluded,
          });
    const progress = (values: ConversationTurnProgress) =>
      updateTaskProposalGenerationProgress(db, generation.id, values, now());
    progress({ contextManifestJson: JSON.stringify(manifest) });
    let outcome = await runCli(
      {
        id: generation.id,
        runtime: generation.agentRuntime,
        modelId: generation.requestedModelId,
        prompt,
        progress,
        nothingStored: noProposals,
        emptyMessage: `${runtimeNames[generation.agentRuntime]} finished without a reply. ${noProposals} Retry the generation.`,
      },
      entry,
    );
    // An operator Stop recorded while the CLI was finishing still wins over late output, so a
    // stopped generation never stores proposals.
    if (findTaskProposalGenerationById(db, generation.id)?.status === 'stopping') {
      outcome = stopped(
        'operator',
        outcome.status === 'cancelled' ? outcome.signal : null,
        noProposals,
      );
    }
    const result = toGenerationFinish(outcome);
    finishGeneration(generation.id, result);
    logger.info(
      `Proposal generation ${generation.id}: ${result.status}${
        result.status === 'completed' ? ` (${result.proposals.length} proposals)` : ''
      }.`,
    );
  };

  const track = (
    id: string,
    kind: ActiveWork['kind'],
    run: (entry: ActiveWork) => Promise<void>,
  ) => {
    let resolveDone: () => void = () => undefined;
    const entry: ActiveWork = {
      id,
      kind,
      handle: null,
      stopReason: null,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
    };
    active.set(id, entry);
    void run(entry)
      .catch((error: unknown) => logger.error(`Conversation work ${id}: finishing failed.`, error))
      .finally(() => {
        active.delete(id);
        resolveDone();
      });
  };

  const requestStop = (id: string, reason: ConversationStopReason): void => {
    const entry = active.get(id);
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
    for (const generation of listRunningTaskProposalGenerations(db)) {
      if (generation.workerInstanceId === workerInstanceId) continue;
      finishGeneration(generation.id, {
        status: 'interrupted',
        errorCode: 'worker_restarted',
        errorMessage: `The worker restarted while task proposals were ${generation.status === 'stopping' ? 'stopping' : 'being generated'}. No proposals were stored and it is not retried automatically.${
          generation.pid === null
            ? ''
            : ` The CLI process group (pid ${generation.pid}) was not signalled after the restart.`
        }`,
        exitCode: null,
        signal: null,
        effectiveModelId: null,
        endedAt: now(),
      });
      logger.info(
        `Proposal generation ${generation.id} was left ${generation.status}; marked interrupted.`,
      );
    }
  };

  const poll = (): void => {
    const olderThan = now() - queuedMaxAgeMs;
    expireQueuedConversationTurns(db, { olderThan, now: now() });
    expireQueuedTaskProposalGenerations(db, { olderThan, now: now() });
    for (const turn of listStoppingConversationTurns(db, workerInstanceId)) {
      requestStop(turn.id, 'operator');
    }
    for (const generation of listStoppingTaskProposalGenerations(db, workerInstanceId)) {
      requestStop(generation.id, 'operator');
    }
    const maxActivePerRuntime = options.maxActivePerRuntime ?? 1;
    for (;;) {
      const result = claimConversationTurn(db, {
        workerInstanceId,
        now: now(),
        maxActivePerRuntime,
      });
      if (!result.claimed) break;
      logger.info(`Conversation turn ${result.claim.turn.id} claimed.`);
      const { claim } = result;
      track(claim.turn.id, 'turn', (entry) => runTurn(claim, entry));
    }
    for (;;) {
      const result = claimTaskProposalGeneration(db, {
        workerInstanceId,
        now: now(),
        maxActivePerRuntime,
      });
      if (!result.claimed) break;
      logger.info(`Proposal generation ${result.claim.generation.id} claimed.`);
      const { claim } = result;
      track(claim.generation.id, 'generation', (entry) => runGeneration(claim, entry));
    }
  };

  const stopAll = async (reason: ConversationStopReason): Promise<void> => {
    const entries = [...active.values()];
    for (const entry of entries) requestStop(entry.id, reason);
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
