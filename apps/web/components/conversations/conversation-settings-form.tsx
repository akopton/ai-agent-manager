'use client';

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { z } from 'zod';
import {
  agentRuntimeSchema,
  agentRuntimes,
  conversationLanguageModeDescriptions,
  conversationLanguageModeLabels,
  conversationLanguageModes,
  conversationLanguageModeSchema,
  conversationTitleMaxLength,
  type Conversation,
} from '@ai-agent-manager/core';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import { conversationResponseSchema } from '@/lib/conversations/contracts';
import { conversationUrl, conversationsUrl } from '@/lib/conversations/format';
import {
  buildConversationUpdate,
  changeConversationRuntime,
  conversationFormValues,
  isConversationFormField,
  newConversationFormValues,
  validateConversationForm,
  type ConversationFieldErrors,
  type ConversationFormField,
  type ConversationFormValues,
} from '@/lib/conversations/form';
import { agentRuntimeLabels } from '@/lib/tasks/board';

const invalidRequestDetailsSchema = z.object({ fields: z.record(z.string(), z.string()) });

const fieldErrorsFromServer = (error: ClientError): ConversationFieldErrors | undefined => {
  const details = invalidRequestDetailsSchema.safeParse(error.details);
  if (error.code !== 'invalid_request' || !details.success) {
    return undefined;
  }
  const entries = Object.entries(details.data.fields).filter(([key]) =>
    isConversationFormField(key),
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

const FieldError = ({ id, message }: { id: string; message: string | undefined }) =>
  message === undefined ? null : (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );

type ConversationSettingsFormProps = {
  projectId: string;
  /** The conversation being edited; omitted when creating one. */
  conversation?: Conversation;
};

/**
 * Title, runtime, model and language of a conversation. Creating or saving stores the settings
 * only; no agent is started.
 */
export const ConversationSettingsForm = ({
  projectId,
  conversation,
}: ConversationSettingsFormProps) => {
  const router = useRouter();
  const fieldId = useId();
  // The last saved settings: a second save right after the first must name the new revision.
  const [baseline, setBaseline] = useState(conversation);
  const creating = baseline === undefined;
  const initial = creating ? newConversationFormValues() : conversationFormValues(baseline);
  const [values, setValues] = useState<ConversationFormValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<ConversationFieldErrors>({});
  const [error, setError] = useState<ClientError | null>(null);
  const [notice, setNotice] = useState<'saved' | 'unchanged' | null>(null);
  const [modelReset, setModelReset] = useState(false);
  const [pending, setPending] = useState(false);

  const isDirty = (Object.keys(initial) as ConversationFormField[]).some(
    (key) => values[key] !== initial[key],
  );

  const update = (field: ConversationFormField, next: ConversationFormValues) => {
    setValues(next);
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setNotice(null);
  };

  const handleRuntimeChange = (value: string) => {
    const runtime = agentRuntimeSchema.safeParse(value);
    if (!runtime.success) {
      return;
    }
    const next = changeConversationRuntime(values, runtime.data);
    setModelReset(values.modelId.trim() !== '' && next.modelId === '');
    update('agentRuntime', next);
  };

  const handleFailure = (failure: ClientError) => {
    setPending(false);
    const fromServer = fieldErrorsFromServer(failure);
    if (fromServer === undefined) {
      setError(failure);
    } else {
      setFieldErrors(fromServer);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    setError(null);
    setNotice(null);

    if (creating) {
      const result = validateConversationForm(values);
      if (!result.ok) {
        setFieldErrors(result.fields);
        return;
      }
      setFieldErrors({});
      setPending(true);
      const response = await requestJson(
        'POST',
        `/api/projects/${projectId}/conversations`,
        conversationResponseSchema,
        result.request,
      );
      if (!response.ok) {
        handleFailure(response.error);
        return;
      }
      router.push(conversationUrl(projectId, response.data.conversation.id));
      router.refresh();
      return;
    }

    const result = buildConversationUpdate(baseline, values);
    if (!result.ok) {
      setFieldErrors(result.fields);
      return;
    }
    setFieldErrors({});
    if (result.update === null) {
      setNotice('unchanged');
      return;
    }
    setPending(true);
    const response = await requestJson(
      'PATCH',
      `/api/projects/${projectId}/conversations/${baseline.id}`,
      conversationResponseSchema,
      result.update,
    );
    if (!response.ok) {
      handleFailure(response.error);
      return;
    }
    const saved = response.data.conversation;
    setBaseline(saved);
    setValues(conversationFormValues(saved));
    setModelReset(false);
    setPending(false);
    setNotice('saved');
    router.refresh();
  };

  const describedBy = (field: ConversationFormField, hint?: string) =>
    [hint, fieldErrors[field] === undefined ? undefined : `${fieldId}-${field}-error`]
      .filter((value) => value !== undefined)
      .join(' ') || undefined;

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate aria-busy={pending}>
      <div className="space-y-2">
        <Label htmlFor={`${fieldId}-title`}>Title</Label>
        <Input
          id={`${fieldId}-title`}
          name="title"
          value={values.title}
          onChange={(event) => update('title', { ...values, title: event.target.value })}
          maxLength={conversationTitleMaxLength}
          required
          autoFocus={creating}
          placeholder="For example: Authentication redesign"
          aria-invalid={fieldErrors.title !== undefined}
          aria-describedby={describedBy('title')}
        />
        <FieldError id={`${fieldId}-title-error`} message={fieldErrors.title} />
      </div>

      <div className={creating ? 'grid gap-5 sm:grid-cols-2' : 'space-y-5'}>
        <div className="space-y-2">
          <Label htmlFor={`${fieldId}-runtime`}>Agent runtime</Label>
          <NativeSelect
            id={`${fieldId}-runtime`}
            name="agentRuntime"
            value={values.agentRuntime}
            onChange={(event) => handleRuntimeChange(event.target.value)}
            aria-invalid={fieldErrors.agentRuntime !== undefined}
            aria-describedby={describedBy('agentRuntime')}
          >
            {agentRuntimes.map((runtime) => (
              <option key={runtime} value={runtime}>
                {agentRuntimeLabels[runtime]}
              </option>
            ))}
          </NativeSelect>
          <FieldError id={`${fieldId}-agentRuntime-error`} message={fieldErrors.agentRuntime} />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${fieldId}-model`}>Model</Label>
          <Input
            id={`${fieldId}-model`}
            name="modelId"
            value={values.modelId}
            onChange={(event) => {
              setModelReset(false);
              update('modelId', { ...values, modelId: event.target.value });
            }}
            maxLength={200}
            placeholder="Default"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={fieldErrors.modelId !== undefined}
            aria-describedby={describedBy('modelId', `${fieldId}-model-hint`)}
          />
          <p id={`${fieldId}-model-hint`} className="text-xs leading-5 text-muted-foreground">
            {modelReset ? 'The model was reset to Default because the runtime changed. ' : null}
            Leave empty for Default: the CLI uses its own configuration. An explicit identifier is
            stored as entered and checked only when replies are enabled.
          </p>
          <FieldError id={`${fieldId}-modelId-error`} message={fieldErrors.modelId} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${fieldId}-language`}>Language</Label>
        <NativeSelect
          id={`${fieldId}-language`}
          name="languageMode"
          value={values.languageMode}
          onChange={(event) => {
            const mode = conversationLanguageModeSchema.safeParse(event.target.value);
            if (mode.success) {
              update('languageMode', { ...values, languageMode: mode.data });
            }
          }}
          aria-invalid={fieldErrors.languageMode !== undefined}
          aria-describedby={describedBy('languageMode', `${fieldId}-language-hint`)}
        >
          {conversationLanguageModes.map((mode) => (
            <option key={mode} value={mode}>
              {conversationLanguageModeLabels[mode]}
            </option>
          ))}
        </NativeSelect>
        <p id={`${fieldId}-language-hint`} className="text-xs leading-5 text-muted-foreground">
          {conversationLanguageModeDescriptions[values.languageMode]}
        </p>
        <FieldError id={`${fieldId}-languageMode-error`} message={fieldErrors.languageMode} />
      </div>

      {error !== null ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>
            {creating ? 'The conversation was not created' : 'The settings were not saved'}
          </AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {notice === 'saved' ? (
        <Alert variant="success" role="status">
          <CheckCircle2 aria-hidden="true" />
          <AlertDescription>
            <p>Settings saved. They apply to future replies; saved notes are unchanged.</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {notice === 'unchanged' ? (
        <Alert role="status">
          <Info aria-hidden="true" />
          <AlertDescription>
            <p>There are no changes to save.</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {creating ? (
          <Button asChild variant="ghost">
            <Link href={conversationsUrl(projectId)}>Cancel</Link>
          </Button>
        ) : null}
        <Button type="submit" disabled={pending || (!creating && !isDirty)}>
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {pending ? 'Saving…' : creating ? 'Create conversation' : 'Save settings'}
        </Button>
      </div>
    </form>
  );
};
