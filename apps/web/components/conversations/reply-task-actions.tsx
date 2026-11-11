'use client';

import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowDown,
  CheckCircle2,
  ListChecks,
  Loader2,
  OctagonX,
  RotateCcw,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import { taskProposalInstructionsMaxLength } from '@ai-agent-manager/core';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import {
  taskProposalGenerationResponseSchema,
  type TaskProposalGenerationView,
} from '@/lib/conversations/contracts';
import {
  describeGenerationState,
  proposalBatchAnchor,
  type GenerationTone,
} from '@/lib/conversations/proposals';
import { cn } from '@/lib/utils';

const toneClasses: Record<GenerationTone, string> = {
  pending: 'text-muted-foreground',
  running: 'text-info',
  stopping: 'text-warning',
  completed: 'text-success',
  empty: 'text-muted-foreground',
  failed: 'text-destructive',
  stopped: 'text-muted-foreground',
  interrupted: 'text-warning',
};

const ToneIcon = ({ tone }: { tone: GenerationTone }) => {
  switch (tone) {
    case 'pending':
    case 'running':
    case 'stopping':
      return <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />;
    case 'completed':
      return <CheckCircle2 className="size-3.5" aria-hidden="true" />;
    case 'failed':
      return <AlertCircle className="size-3.5" aria-hidden="true" />;
    default:
      return <OctagonX className="size-3.5" aria-hidden="true" />;
  }
};

type ReplyTaskActionsProps = {
  projectId: string;
  conversationId: string;
  /** The completed AI reply this action generates tasks from. */
  messageId: string;
  /** The latest proposal request made from this reply, if any. */
  generation: TaskProposalGenerationView | null;
  aiEnabled: boolean;
  /** Why a new request cannot be made now, or `null` when it can. */
  blockedReason: string | null;
  referenceAction?: ReactNode;
};

/**
 * C3.1: "Generate tasks" under one completed AI reply, with an optional focus, and the state of
 * the latest request made from that reply. Only the reply's ID is sent; the server loads its text.
 * Each click keeps one request ID until it succeeds, so a double click stores one request, and a
 * later click is a deliberate new generation.
 */
export const ReplyTaskActions = ({
  projectId,
  conversationId,
  messageId,
  generation,
  aiEnabled,
  blockedReason,
  referenceAction,
}: ReplyTaskActionsProps) => {
  const router = useRouter();
  const fieldId = useId();
  const [focusOpen, setFocusOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const tooLong = instructions.trim().length > taskProposalInstructionsMaxLength;
  const state =
    generation === null ? null : describeGenerationState(generation, { latest: true, aiEnabled });
  const hasBatch = generation?.status === 'completed' && generation.proposalCount > 0;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || blockedReason !== null || tooLong) return;
    submitting.current = true;
    requestId.current ??= crypto.randomUUID();
    setPending(true);
    setError(null);
    const result = await requestJson(
      'POST',
      `/api/projects/${projectId}/conversations/${conversationId}/proposal-generations`,
      taskProposalGenerationResponseSchema,
      { requestId: requestId.current, sourceMessageId: messageId, instructions },
    );
    submitting.current = false;
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    requestId.current = null;
    setInstructions('');
    setFocusOpen(false);
    router.refresh();
  };

  return (
    <footer className="mt-3 flex min-w-0 flex-col gap-2 border-t pt-2 text-xs">
      <div className="flex flex-wrap items-start gap-2">
        {referenceAction}
        <form
          onSubmit={submit}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          noValidate
          aria-busy={pending}
          aria-label="Generate tasks from this reply"
        >
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            className="min-h-9 px-2 text-xs"
            disabled={pending || blockedReason !== null || tooLong}
            title={blockedReason ?? 'Propose tasks using only this reply as the source.'}
            aria-describedby={blockedReason === null ? undefined : `${fieldId}-blocked`}
          >
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <ListChecks aria-hidden="true" />
            )}
            {generation === null ? 'Generate tasks' : 'Generate tasks again'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-9 px-2 text-xs text-muted-foreground"
            disabled={pending}
            aria-expanded={focusOpen}
            aria-controls={`${fieldId}-focus`}
            onClick={() => setFocusOpen((open) => !open)}
          >
            <SlidersHorizontal aria-hidden="true" />
            Focus
          </Button>
          {focusOpen ? (
            <Input
              id={`${fieldId}-focus`}
              aria-label="Optional focus for the tasks from this reply"
              disabled={pending}
              value={instructions}
              onChange={(event) => {
                setInstructions(event.target.value);
                requestId.current = null;
                setError(null);
              }}
              maxLength={taskProposalInstructionsMaxLength}
              placeholder="Optional, e.g. only the backend part"
              className="h-9 w-full min-w-0 flex-1 basis-48 text-xs"
              aria-invalid={tooLong}
            />
          ) : null}
          {blockedReason !== null ? (
            <span id={`${fieldId}-blocked`} className="sr-only">
              {blockedReason}
            </span>
          ) : null}
        </form>
      </div>
      {generation !== null && state !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
        >
          <span className={cn('flex items-center gap-1.5 font-medium', toneClasses[state.tone])}>
            <ToneIcon tone={state.tone} />
            {state.title}
          </span>
          {state.description === null || state.tone === 'completed' ? null : (
            <span className="break-words text-muted-foreground">{state.description}</span>
          )}
          {hasBatch ? (
            <a
              href={`#${proposalBatchAnchor(generation.id)}`}
              className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <ArrowDown className="size-3.5" aria-hidden="true" />
              View proposals in Tasks
            </a>
          ) : null}
          <ProposalGenerationActions
            projectId={projectId}
            conversationId={conversationId}
            generationId={generation.id}
            canStop={state.canStop}
            canRetry={state.canRetry}
          />
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-destructive">
          {error.message}
        </p>
      ) : null}
    </footer>
  );
};

type GenerationActionsProps = {
  projectId: string;
  conversationId: string;
  generationId: string;
  canStop: boolean;
  canRetry: boolean;
};

/** Full generation history also includes requests that produced no proposal cards. */
export const ProposalGenerationStatus = ({
  generation,
  projectId,
  conversationId,
  retryable,
  aiEnabled,
}: {
  generation: TaskProposalGenerationView;
  projectId: string;
  conversationId: string;
  retryable: boolean;
  aiEnabled: boolean;
}) => {
  const state = describeGenerationState(generation, { latest: retryable, aiEnabled });
  return (
    <div role="status" className="space-y-2 text-xs" aria-live="polite">
      <p className={cn('flex items-center gap-2 font-medium', toneClasses[state.tone])}>
        <ToneIcon tone={state.tone} /> {state.title}
      </p>
      {state.description === null ? null : (
        <p className="break-words text-muted-foreground">
          {generation.status === 'completed' && generation.note ? 'AI note: ' : null}
          {state.description}
        </p>
      )}
      <ProposalGenerationActions
        projectId={projectId}
        conversationId={conversationId}
        generationId={generation.id}
        canStop={state.canStop}
        canRetry={generation.sourceMessageId !== null && state.canRetry}
      />
    </div>
  );
};

/** Stop and Retry for a proposal request, like a chat turn's actions. */
export const ProposalGenerationActions = ({
  projectId,
  conversationId,
  generationId,
  canStop,
  canRetry,
}: GenerationActionsProps) => {
  const router = useRouter();
  const [pending, setPending] = useState<'stop' | 'retry' | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const retryRequestId = useRef<string | null>(null);
  const base = `/api/projects/${projectId}/conversations/${conversationId}/proposal-generations/${generationId}`;

  if (!canStop && !canRetry) {
    return null;
  }

  const run = async (action: 'stop' | 'retry') => {
    if (pending !== null) return;
    setPending(action);
    setError(null);
    if (action === 'retry') retryRequestId.current ??= crypto.randomUUID();
    const result = await requestJson(
      'POST',
      `${base}/${action}`,
      taskProposalGenerationResponseSchema,
      action === 'retry' ? { requestId: retryRequestId.current } : undefined,
    );
    setPending(null);
    if (!result.ok) {
      setError(result.error);
    }
    router.refresh();
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canStop ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void run('stop')}
        >
          {pending === 'stop' ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Square aria-hidden="true" />
          )}
          Stop
        </Button>
      ) : null}
      {canRetry ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void run('retry')}
        >
          {pending === 'retry' ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <RotateCcw aria-hidden="true" />
          )}
          Retry
        </Button>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      ) : null}
    </div>
  );
};
