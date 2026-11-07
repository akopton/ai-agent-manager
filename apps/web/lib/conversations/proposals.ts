import {
  updateTaskProposalInputSchema,
  type AgentRuntime,
  type TaskPriority,
  type TaskProposalStatus,
} from '@ai-agent-manager/core';
import type {
  TaskProposalGenerationView,
  TaskProposalView,
  UpdateTaskProposalRequest,
} from '@/lib/conversations/contracts';
import { describeModelChoice, modelValueProblem } from '@/lib/models/model-selection';

// Pure presentation model of C3 task proposals: the state line of a proposal request, the
// proposal editor's values and the update it sends. Kept free of React so every state can be
// tested directly.

const runtimeNames: Readonly<Record<AgentRuntime, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export type GenerationTone =
  'pending' | 'running' | 'stopping' | 'completed' | 'empty' | 'failed' | 'stopped' | 'interrupted';

export type GenerationState = {
  tone: GenerationTone;
  title: string;
  description: string | null;
  canStop: boolean;
  canRetry: boolean;
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Describes what the operator sees for one proposal request. */
export const describeGenerationState = (
  generation: TaskProposalGenerationView,
  { latest, aiEnabled }: { latest: boolean; aiEnabled: boolean },
): GenerationState => {
  const name = runtimeNames[generation.agentRuntime];
  const canRetry = latest && aiEnabled;
  switch (generation.status) {
    case 'queued':
      return {
        tone: 'pending',
        title: 'Waiting for the worker…',
        description: `The request is saved. The worker sends it to ${name} when it is running.`,
        canStop: true,
        canRetry: false,
      };
    case 'running':
      return {
        tone: 'running',
        title:
          generation.startedAt === null
            ? `Starting ${name}…`
            : `${name} is preparing task proposals…`,
        description:
          'Proposals appear below as drafts when the answer is complete. Nothing is created until you approve one.',
        canStop: true,
        canRetry: false,
      };
    case 'stopping':
      return {
        tone: 'stopping',
        title: 'Stopping…',
        description: `The worker is stopping ${name}. No proposals will be stored.`,
        canStop: false,
        canRetry: false,
      };
    case 'completed': {
      const skipped =
        generation.skippedCount === 0
          ? ''
          : ` ${plural(generation.skippedCount, 'item')} did not match the proposal format and ${generation.skippedCount === 1 ? 'was' : 'were'} skipped.`;
      if (generation.proposalCount === 0) {
        return {
          tone: 'empty',
          title: 'No task proposals',
          description:
            `${generation.note ?? `${name} did not find concrete tasks in this conversation. Discuss the work in more detail and try again.`}${skipped}`.trim(),
          canStop: false,
          canRetry: false,
        };
      }
      return {
        tone: 'completed',
        title: `${plural(generation.proposalCount, 'proposal')} generated`,
        description: `${generation.note ?? ''}${skipped}`.trim() || null,
        canStop: false,
        canRetry: false,
      };
    }
    case 'failed':
      return {
        tone: 'failed',
        title: 'Proposals could not be generated',
        description: generation.errorMessage,
        canStop: false,
        canRetry,
      };
    case 'cancelled':
      return {
        tone: 'stopped',
        title: 'Stopped',
        description: generation.errorMessage ?? 'No proposals were stored.',
        canStop: false,
        canRetry,
      };
    case 'interrupted':
      return {
        tone: 'interrupted',
        title: 'Interrupted',
        description: generation.errorMessage,
        canStop: false,
        canRetry,
      };
  }
};

/** The latest proposal request of a conversation, if any. */
export const latestGeneration = (
  generations: readonly TaskProposalGenerationView[],
): TaskProposalGenerationView | undefined => generations.at(-1);

export const hasActiveGeneration = (generations: readonly TaskProposalGenerationView[]): boolean =>
  generations.some((generation) => generation.active);

export const proposalStatusVariant: Readonly<
  Record<TaskProposalStatus, 'secondary' | 'success' | 'outline'>
> = {
  draft: 'secondary',
  approved: 'success',
  rejected: 'outline',
};

/** Counts per status, for the panel summary. */
export const countProposals = (
  proposals: readonly TaskProposalView[],
): Record<TaskProposalStatus, number> => {
  const counts: Record<TaskProposalStatus, number> = { draft: 0, approved: 0, rejected: 0 };
  for (const proposal of proposals) counts[proposal.status] += 1;
  return counts;
};

/** "Claude Code · Default", for the runtime and model of a proposal or suggestion. */
export const describeRuntimeAndModel = (runtime: AgentRuntime, modelId: string | null): string =>
  `${runtimeNames[runtime]} · ${describeModelChoice(runtime, modelId)}`;

/** Value of the base branch select that means the project's default base branch. */
export const proposalDefaultBranch = '';

export type ProposalFormValues = {
  title: string;
  prompt: string;
  agentRuntime: AgentRuntime;
  /** `''` = Default; otherwise the exact CLI model identifier. */
  modelId: string;
  priority: TaskPriority;
  /** A branch name, or `proposalDefaultBranch`. */
  baseBranch: string;
};

export type ProposalFormField = keyof ProposalFormValues;

export type ProposalFieldErrors = Partial<Record<ProposalFormField, string>>;

export const proposalFormValues = (proposal: TaskProposalView): ProposalFormValues => ({
  title: proposal.title,
  prompt: proposal.prompt,
  agentRuntime: proposal.agentRuntime,
  modelId: proposal.modelId ?? '',
  priority: proposal.priority,
  baseBranch: proposal.baseBranch ?? proposalDefaultBranch,
});

/** Switching the runtime resets the model to Default, as for tasks (`SPEC.md` §5). */
export const changeProposalRuntime = (
  values: ProposalFormValues,
  agentRuntime: AgentRuntime,
): ProposalFormValues =>
  agentRuntime === values.agentRuntime ? values : { ...values, agentRuntime, modelId: '' };

const formFields = new Set<string>([
  'title',
  'prompt',
  'agentRuntime',
  'modelId',
  'priority',
  'baseBranch',
]);

export const isProposalFormField = (key: string): key is ProposalFormField => formFields.has(key);

export type ProposalUpdateResult =
  | { ok: true; update: UpdateTaskProposalRequest | null }
  | { ok: false; fields: ProposalFieldErrors };

/**
 * Validates the editor with the server's schema and returns only the changed fields, based on
 * the revision the operator edited (`update: null` when nothing changed).
 */
export const buildProposalUpdate = (
  proposal: TaskProposalView,
  values: ProposalFormValues,
): ProposalUpdateResult => {
  const modelId = values.modelId.trim() === '' ? null : values.modelId.trim();
  const baseBranch = values.baseBranch === proposalDefaultBranch ? null : values.baseBranch;
  const candidate: UpdateTaskProposalRequest = {
    revision: proposal.revision,
    ...(values.title === proposal.title ? {} : { title: values.title }),
    ...(values.prompt === proposal.prompt ? {} : { prompt: values.prompt }),
    ...(values.agentRuntime === proposal.agentRuntime ? {} : { agentRuntime: values.agentRuntime }),
    ...(modelId === proposal.modelId ? {} : { modelId }),
    ...(values.priority === proposal.priority ? {} : { priority: values.priority }),
    ...(baseBranch === proposal.baseBranch ? {} : { baseBranch }),
  };
  if (Object.keys(candidate).length === 1) {
    return { ok: true, update: null };
  }
  const parsed = updateTaskProposalInputSchema.safeParse(candidate);
  if (!parsed.success) {
    const fields: ProposalFieldErrors = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (isProposalFormField(key) && fields[key] === undefined) {
        fields[key] = issue.message;
      }
    }
    return { ok: false, fields };
  }
  // Checked only when the runtime or model changes, so a stored custom ID stays editable.
  if (candidate.agentRuntime !== undefined || candidate.modelId !== undefined) {
    const problem = modelValueProblem(values.agentRuntime, values.modelId);
    if (problem !== null) {
      return { ok: false, fields: { modelId: problem } };
    }
  }
  return { ok: true, update: candidate };
};

// ---------------------------------------------------------------------------------------------
// C3.1 — generation from individual AI replies
// ---------------------------------------------------------------------------------------------

/** Anchor of an AI reply in the transcript, for "Show source reply" links. */
export const messageAnchor = (messageId: string): string => `message-${messageId}`;

/** Anchor of a proposal batch in the Task proposals panel. */
export const proposalBatchAnchor = (generationId: string): string => `proposals-${generationId}`;

/** The latest generation for each source reply (generations are in creation order). */
export const latestGenerationBySource = (
  generations: readonly TaskProposalGenerationView[],
): Map<string, TaskProposalGenerationView> => {
  const latest = new Map<string, TaskProposalGenerationView>();
  for (const generation of generations) {
    if (generation.sourceMessageId !== null) latest.set(generation.sourceMessageId, generation);
  }
  return latest;
};

export type ProposalBatch = {
  generation: TaskProposalGenerationView;
  proposals: TaskProposalView[];
};

/**
 * Proposals grouped by the request that produced them, in stable creation order. Requests that
 * stored no proposals are left out; their state is shown next to their source reply.
 */
export const groupProposalsByGeneration = (
  generations: readonly TaskProposalGenerationView[],
  proposals: readonly TaskProposalView[],
): ProposalBatch[] =>
  generations
    .map((generation) => ({
      generation,
      proposals: proposals.filter((proposal) => proposal.generationId === generation.id),
    }))
    .filter((batch) => batch.proposals.length > 0);

/**
 * Why "Generate tasks" cannot be used right now, or `null` when it can. One AI request per
 * conversation at a time, and only with AI Conversations enabled.
 */
export const replyGenerationBlockedReason = ({
  aiEnabled,
  turnActive,
  generating,
}: {
  aiEnabled: boolean;
  turnActive: boolean;
  generating: boolean;
}): string | null => {
  if (!aiEnabled) return 'AI Conversations are off. Enable them in Settings to generate tasks.';
  if (generating) return 'Task proposals are being generated. Wait for them or stop the request.';
  if (turnActive) return 'A reply is still pending. Wait for it before generating tasks.';
  return null;
};
