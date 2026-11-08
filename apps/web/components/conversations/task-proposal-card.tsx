'use client';

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowUpRight,
  Check,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  UserPen,
  X,
} from 'lucide-react';
import { z } from 'zod';
import {
  agentRuntimeSchema,
  agentRuntimes,
  taskPriorities,
  taskPriorityLabels,
  taskPrioritySchema,
  taskPromptMaxLength,
  taskProposalStatusLabels,
  taskTitleMaxLength,
} from '@ai-agent-manager/core';

import { ModelSelect } from '@/components/models/model-select';
import { TaskPriorityBadge } from '@/components/tasks/task-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import {
  approveTaskProposalResponseSchema,
  taskProposalResponseSchema,
  type TaskProposalView,
} from '@/lib/conversations/contracts';
import {
  buildProposalUpdate,
  changeProposalRuntime,
  describeRuntimeAndModel,
  isProposalFormField,
  messageAnchor,
  proposalDefaultBranch,
  proposalFormValues,
  proposalStatusVariant,
  type ProposalFieldErrors,
  type ProposalFormValues,
} from '@/lib/conversations/proposals';
import { agentRuntimeLabels, taskUrl } from '@/lib/tasks/board';
import { cn } from '@/lib/utils';

type TaskProposalCardProps = {
  projectId: string;
  conversationId: string;
  proposal: TaskProposalView;
  defaultBaseBranch: string;
  /** Live local branches, or `null` when they were not read or cannot be read. */
  branches: readonly string[] | null;
  /** C3.1: the AI reply this proposal was generated from; `null` for C3 proposals. */
  sourceMessageId?: string | null;
};

type Action = 'save' | 'approve' | 'reject' | 'reopen';

const invalidRequestDetailsSchema = z.object({ fields: z.record(z.string(), z.string()) });
const issuesDetailsSchema = z.object({
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});

/** Moves server-side validation errors next to their field, where possible. */
const fieldErrorsFromServer = (error: ClientError): ProposalFieldErrors | undefined => {
  if (error.code === 'base_branch_not_found') {
    return { baseBranch: error.message };
  }
  const fields = invalidRequestDetailsSchema.safeParse(error.details);
  const issues = issuesDetailsSchema.safeParse(error.details);
  const entries = fields.success
    ? Object.entries(fields.data.fields)
    : issues.success
      ? issues.data.issues.map(({ path, message }) => [path, message] as const)
      : [];
  const known = entries.filter(([key]) => isProposalFormField(key));
  return known.length === 0 ? undefined : Object.fromEntries(known);
};

const FieldError = ({ id, message }: { id: string; message: string | undefined }) =>
  message === undefined ? null : (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );

/**
 * One task proposal: the AI's suggestion and the operator's current values, editing while it is
 * a draft, and the explicit Approve to Backlog, Reject and Reopen actions. Approval creates one
 * Backlog task; it never queues or starts it.
 */
export const TaskProposalCard = ({
  projectId,
  conversationId,
  proposal,
  defaultBaseBranch,
  branches,
  sourceMessageId = null,
}: TaskProposalCardProps) => {
  const router = useRouter();
  const fieldId = useId();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<ProposalFormValues>(() => proposalFormValues(proposal));
  const [fieldErrors, setFieldErrors] = useState<ProposalFieldErrors>({});
  const [error, setError] = useState<ClientError | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [modelReset, setModelReset] = useState(false);
  const base = `/api/projects/${projectId}/conversations/${conversationId}/proposals/${proposal.id}`;
  const draft = proposal.status === 'draft';
  const branchOptions =
    proposal.baseBranch !== null && !(branches ?? []).includes(proposal.baseBranch)
      ? [proposal.baseBranch, ...(branches ?? [])]
      : (branches ?? []);

  const update = (field: keyof ProposalFormValues, next: ProposalFormValues) => {
    setValues(next);
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setError(null);
  };

  const startEditing = () => {
    setValues(proposalFormValues(proposal));
    setFieldErrors({});
    setError(null);
    setModelReset(false);
    setEditing(true);
  };

  const finish = (result: { ok: boolean; error?: ClientError }) => {
    setPending(null);
    if (!result.ok && result.error !== undefined) {
      const fields = fieldErrorsFromServer(result.error);
      if (fields !== undefined && editing) {
        setFieldErrors(fields);
      } else {
        setError(result.error);
      }
      return false;
    }
    router.refresh();
    return true;
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending !== null) return;
    const result = buildProposalUpdate(proposal, values);
    if (!result.ok) {
      setFieldErrors(result.fields);
      return;
    }
    if (result.update === null) {
      setEditing(false);
      return;
    }
    setPending('save');
    setError(null);
    const response = await requestJson('PATCH', base, taskProposalResponseSchema, result.update);
    if (finish(response.ok ? { ok: true } : { ok: false, error: response.error })) {
      setEditing(false);
    }
  };

  const act = async (action: 'approve' | 'reject' | 'reopen') => {
    if (pending !== null) return;
    setPending(action);
    setError(null);
    const body = { revision: proposal.revision };
    const response =
      action === 'approve'
        ? await requestJson('POST', `${base}/approve`, approveTaskProposalResponseSchema, body)
        : await requestJson('POST', `${base}/${action}`, taskProposalResponseSchema, body);
    finish(response.ok ? { ok: true } : { ok: false, error: response.error });
  };

  const describedBy = (field: keyof ProposalFormValues) =>
    fieldErrors[field] === undefined ? undefined : `${fieldId}-${field}-error`;

  return (
    <article
      aria-label={`Task proposal ${proposal.position}: ${proposal.title}`}
      className={cn(
        'space-y-3 rounded-xl border bg-card px-4 py-3',
        proposal.status === 'rejected' && 'bg-inset/60 opacity-80',
        proposal.status === 'approved' && 'border-success/40',
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Badge variant={proposalStatusVariant[proposal.status]}>
          {taskProposalStatusLabels[proposal.status]}
        </Badge>
        {proposal.edited ? (
          <Badge variant="outline" title="You changed values the AI suggested.">
            <UserPen aria-hidden="true" />
            Edited by you
          </Badge>
        ) : (
          <Badge variant="outline" title="Values as suggested by the AI.">
            <Sparkles aria-hidden="true" />
            AI suggestion
          </Badge>
        )}
        <TaskPriorityBadge priority={proposal.priority} />
        <span className="text-xs break-all text-muted-foreground">
          {describeRuntimeAndModel(proposal.agentRuntime, proposal.modelId)} · base{' '}
          {proposal.baseBranch ?? `project default (${defaultBaseBranch})`}
        </span>
        {sourceMessageId === null ? null : (
          <a
            href={`#${messageAnchor(sourceMessageId)}`}
            className="ml-auto rounded-sm text-xs text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Source reply
          </a>
        )}
      </header>

      {editing ? (
        <form onSubmit={save} className="space-y-4" noValidate aria-busy={pending === 'save'}>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-title`}>Title</Label>
            <Input
              id={`${fieldId}-title`}
              value={values.title}
              maxLength={taskTitleMaxLength}
              onChange={(event) => update('title', { ...values, title: event.target.value })}
              aria-invalid={fieldErrors.title !== undefined}
              aria-describedby={describedBy('title')}
            />
            <FieldError id={`${fieldId}-title-error`} message={fieldErrors.title} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-prompt`}>Implementation prompt</Label>
            <Textarea
              id={`${fieldId}-prompt`}
              value={values.prompt}
              maxLength={taskPromptMaxLength}
              rows={8}
              onChange={(event) => update('prompt', { ...values, prompt: event.target.value })}
              aria-invalid={fieldErrors.prompt !== undefined}
              aria-describedby={describedBy('prompt')}
            />
            <FieldError id={`${fieldId}-prompt-error`} message={fieldErrors.prompt} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-runtime`}>Agent runtime</Label>
              <NativeSelect
                id={`${fieldId}-runtime`}
                value={values.agentRuntime}
                onChange={(event) => {
                  const runtime = agentRuntimeSchema.safeParse(event.target.value);
                  if (!runtime.success) return;
                  const next = changeProposalRuntime(values, runtime.data);
                  setModelReset(values.modelId.trim() !== '' && next.modelId === '');
                  update('agentRuntime', next);
                }}
              >
                {agentRuntimes.map((runtime) => (
                  <option key={runtime} value={runtime}>
                    {agentRuntimeLabels[runtime]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-model`}>Model</Label>
              <ModelSelect
                key={values.agentRuntime}
                id={`${fieldId}-model`}
                runtime={values.agentRuntime}
                value={values.modelId}
                onChange={(modelId) => {
                  setModelReset(false);
                  update('modelId', { ...values, modelId });
                }}
                invalid={fieldErrors.modelId !== undefined}
                describedBy={describedBy('modelId')}
              />
              {modelReset ? (
                <p className="text-xs text-muted-foreground">
                  The model was reset to Default because the runtime changed.
                </p>
              ) : null}
              <FieldError id={`${fieldId}-modelId-error`} message={fieldErrors.modelId} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-priority`}>Priority</Label>
              <NativeSelect
                id={`${fieldId}-priority`}
                value={values.priority}
                onChange={(event) => {
                  const priority = taskPrioritySchema.safeParse(event.target.value);
                  if (priority.success) update('priority', { ...values, priority: priority.data });
                }}
              >
                {taskPriorities.map((priority) => (
                  <option key={priority} value={priority}>
                    {taskPriorityLabels[priority]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-branch`}>Base branch</Label>
              <NativeSelect
                id={`${fieldId}-branch`}
                value={values.baseBranch}
                onChange={(event) =>
                  update('baseBranch', { ...values, baseBranch: event.target.value })
                }
                aria-invalid={fieldErrors.baseBranch !== undefined}
                aria-describedby={`${fieldId}-branch-hint ${describedBy('baseBranch') ?? ''}`}
              >
                <option value={proposalDefaultBranch}>Project default ({defaultBaseBranch})</option>
                {branchOptions.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                    {branches !== null && !branches.includes(branch) ? ' (not found)' : ''}
                  </option>
                ))}
              </NativeSelect>
              <p id={`${fieldId}-branch-hint`} className="text-xs text-muted-foreground">
                {branches === null
                  ? 'The repository cannot be read right now, so only the project default can be chosen.'
                  : 'The project default is resolved when the task first starts.'}
              </p>
              <FieldError id={`${fieldId}-baseBranch-error`} message={fieldErrors.baseBranch} />
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending !== null}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending !== null}>
              {pending === 'save' ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Save draft
            </Button>
          </div>
        </form>
      ) : (
        <>
          <h3 className="text-base leading-6 font-semibold break-words">
            <span className="mr-1.5 text-muted-foreground tabular-nums">#{proposal.position}</span>
            {proposal.title}
          </h3>
          <div className="space-y-2 rounded-lg border bg-inset/40 px-3 py-2 text-sm">
            <p className="text-xs font-medium text-muted-foreground">Implementation prompt</p>
            <p id={`${fieldId}-full-prompt`} className="leading-6 break-words whitespace-pre-wrap">
              {expanded || proposal.prompt.length <= 240
                ? proposal.prompt
                : `${proposal.prompt.slice(0, 240).trimEnd()}…`}
            </p>
            {proposal.prompt.length > 240 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-9"
                aria-expanded={expanded}
                aria-controls={`${fieldId}-full-prompt`}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? 'Show less' : 'Expand prompt'}
              </Button>
            ) : null}
            <span className="sr-only">
              {proposal.prompt.length.toLocaleString('en')} characters
            </span>
          </div>
          {proposal.rationale !== '' || proposal.dependencies !== '' ? (
            <dl className="grid gap-1 text-xs leading-5">
              {proposal.rationale !== '' ? (
                <div>
                  <dt className="inline font-medium text-muted-foreground">Why: </dt>
                  <dd className="inline break-words">{proposal.rationale}</dd>
                </div>
              ) : null}
              {proposal.dependencies !== '' ? (
                <div>
                  <dt className="inline font-medium text-muted-foreground">Order: </dt>
                  <dd className="inline break-words">{proposal.dependencies}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {proposal.edited ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground select-none">
                Show the AI&apos;s original suggestion
              </summary>
              <div className="mt-2 space-y-1 rounded-lg border border-dashed px-3 py-2">
                <p className="font-medium break-words">{proposal.suggested.title}</p>
                <p className="text-muted-foreground">
                  {taskPriorityLabels[proposal.suggested.priority]} priority ·{' '}
                  {describeRuntimeAndModel(
                    proposal.suggested.agentRuntime,
                    proposal.suggested.modelId,
                  )}{' '}
                  · project default branch
                </p>
                <p className="leading-5 break-words whitespace-pre-wrap">
                  {proposal.suggested.prompt}
                </p>
              </div>
            </details>
          ) : null}
        </>
      )}

      {proposal.status === 'approved' && proposal.taskId !== null ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Check className="size-4 text-success" aria-hidden="true" />
          <span>Approved with these values. The task is in Backlog and was not queued.</span>
          <Link
            href={taskUrl(projectId, proposal.taskId)}
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            Open task
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </p>
      ) : null}

      {!editing && draft ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Approving creates one task in Backlog. It is not queued or started.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending !== null}
              onClick={startEditing}
            >
              <Pencil aria-hidden="true" />
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() => void act('reject')}
            >
              {pending === 'reject' ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <X aria-hidden="true" />
              )}
              Reject
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending !== null}
              onClick={() => void act('approve')}
            >
              {pending === 'approve' ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              Approve to Backlog
            </Button>
          </div>
        </div>
      ) : null}

      {proposal.status === 'rejected' ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Rejected. Reopen it as a draft to edit or approve it.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void act('reopen')}
          >
            {pending === 'reopen' ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw aria-hidden="true" />
            )}
            Reopen
          </Button>
        </div>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      ) : null}
    </article>
  );
};
