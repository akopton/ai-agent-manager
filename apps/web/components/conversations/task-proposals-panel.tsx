import { ArrowUp, ListChecks } from 'lucide-react';

import { TaskProposalCard } from '@/components/conversations/task-proposal-card';
import { ProposalGenerationStatus } from '@/components/conversations/reply-task-actions';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { TaskProposalGenerationView, TaskProposalView } from '@/lib/conversations/contracts';
import {
  countProposals,
  describeRuntimeAndModel,
  hasActiveGeneration,
  latestGenerationBySource,
  messageAnchor,
  proposalBatchAnchor,
} from '@/lib/conversations/proposals';
import { formatTimestamp } from '@/lib/projects/format';

type TaskProposalsPanelProps = {
  projectId: string;
  conversationId: string;
  defaultBaseBranch: string;
  branches: readonly string[] | null;
  generations: readonly TaskProposalGenerationView[];
  proposals: readonly TaskProposalView[];
  aiEnabled?: boolean;
  turnActive?: boolean;
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The history of task proposals of a conversation, grouped by the request that produced them.
 * Each C3.1 batch names and links its source AI reply; requests are made with **Generate tasks**
 * under a reply in the transcript. Editing, rejecting or approving proposals never changes the
 * chat history.
 */
export const TaskProposalsPanel = ({
  projectId,
  conversationId,
  defaultBaseBranch,
  branches,
  generations,
  proposals,
  aiEnabled = false,
  turnActive = false,
}: TaskProposalsPanelProps) => {
  const batches = generations.map((generation) => ({
    generation,
    proposals: proposals.filter((proposal) => proposal.generationId === generation.id),
  }));
  const latest = latestGenerationBySource(generations);
  const busy = turnActive || hasActiveGeneration(generations);
  const counts = countProposals(proposals);

  return (
    <Card aria-labelledby="proposals-title">
      <CardHeader>
        <CardTitle>
          <h2 id="proposals-title" className="flex items-center gap-2">
            <ListChecks className="size-4 text-primary" aria-hidden="true" />
            Task proposals
          </h2>
        </CardTitle>
        <CardDescription>
          Use <span className="font-medium text-foreground">Generate tasks</span> under an AI reply
          to turn that reply, and only that reply, into task drafts. Review, edit and approve them
          here one by one. Only your approval creates a task, always in Backlog; nothing is queued
          or started automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {batches.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No task proposals yet. They appear here only when you ask for them from an AI reply.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {counts.draft} draft · {counts.approved} approved · {counts.rejected} rejected
            </p>
            {batches.map(({ generation, proposals: batch }) => (
              <section
                key={generation.id}
                id={proposalBatchAnchor(generation.id)}
                aria-label={`Proposals from ${generation.sourceMessageId === null ? 'the whole conversation' : 'an AI reply'}, ${formatTimestamp(generation.createdAt)}`}
                className="scroll-mt-20 space-y-3 rounded-xl target:ring-2 target:ring-primary/40 target:ring-offset-4 target:ring-offset-background"
              >
                <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b pb-2 text-xs">
                  <span className="font-semibold text-foreground">
                    {plural(batch.length, 'proposal')}
                  </span>
                  <span className="text-muted-foreground">
                    {generation.sourceMessageId === null
                      ? 'from the whole conversation (before C3.1)'
                      : 'from one AI reply'}{' '}
                    ·{' '}
                    {describeRuntimeAndModel(generation.agentRuntime, generation.requestedModelId)}{' '}
                    · {formatTimestamp(generation.createdAt)}
                  </span>
                  {generation.instructions === '' ? null : (
                    <span className="break-words text-muted-foreground">
                      · Focus: <span className="text-foreground">{generation.instructions}</span>
                    </span>
                  )}
                  {generation.sourceMessageId === null ? null : (
                    <a
                      href={`#${messageAnchor(generation.sourceMessageId)}`}
                      className="ml-auto inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <ArrowUp className="size-3.5" aria-hidden="true" />
                      Show source reply
                    </a>
                  )}
                </header>
                <ProposalGenerationStatus
                  projectId={projectId}
                  conversationId={conversationId}
                  generation={generation}
                  retryable={
                    !busy &&
                    generation.sourceMessageId !== null &&
                    latest.get(generation.sourceMessageId)?.id === generation.id
                  }
                  aiEnabled={aiEnabled}
                />
                <ol aria-label="Proposals in this batch" className="space-y-3">
                  {batch.map((proposal) => (
                    <li key={proposal.id}>
                      <TaskProposalCard
                        // Re-mount after a save so the editor starts from the stored values.
                        key={`${proposal.id}-${proposal.revision}`}
                        projectId={projectId}
                        conversationId={conversationId}
                        proposal={proposal}
                        defaultBaseBranch={defaultBaseBranch}
                        branches={branches}
                        sourceMessageId={generation.sourceMessageId}
                      />
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
};
