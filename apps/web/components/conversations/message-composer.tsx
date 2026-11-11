'use client';

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, NotebookPen, Send } from 'lucide-react';
import {
  conversationMessageContentSchema,
  conversationReferenceLimits,
  conversationMessageMaxLength,
} from '@ai-agent-manager/core';

import {
  ReferencePreviews,
  useReferenceDraft,
} from '@/components/conversations/conversation-references';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/input';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import {
  conversationMessageResponseSchema,
  sendConversationMessageResponseSchema,
} from '@/lib/conversations/contracts';

type ComposerMode = 'chat' | 'note';

export type MessageComposerProps = {
  projectId: string;
  mode?: ComposerMode;
  conversationId: string;
  /** AI replies are enabled in Settings. */
  aiEnabled: boolean;
  /** A reply is pending or running; nothing new can be added until it finishes. */
  turnActive: boolean;
  /** Task proposals are being generated (C3); chat waits, notes can still be saved. */
  proposalsActive?: boolean;
  /** For example "Claude Code · Default · Polish, technical English". */
  target: string;
  /** Presentation-only notification after a successful chat submission. */
  onSent?: () => void;
};

/**
 * Writes either a chat message that is sent to the conversation's AI (C2), or a note that stays
 * in AI Agent Manager (C1). Each draft keeps one request ID until it is stored, so a double
 * submission or a retry after a lost response is stored once.
 */
export const MessageComposer = ({
  projectId,
  mode = 'chat',
  conversationId,
  aiEnabled,
  turnActive,
  proposalsActive = false,
  target,
  onSent,
}: MessageComposerProps) => {
  const router = useRouter();
  const referenceDraft = useReferenceDraft();
  const requestSignature = useRef<string | null>(null);
  const fieldId = useId();
  const [content, setContent] = useState('');
  const [error, setError] = useState<ClientError | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);

  const length = content.replace(/\r\n?/g, '\n').trim().length;
  const isEmpty = length === 0;
  const tooLong = length > conversationMessageMaxLength;
  const chat = mode === 'chat';
  const blocked = turnActive || (chat && (!aiEnabled || proposalsActive));

  const submit = async () => {
    if (submitting.current || blocked) {
      return;
    }
    if (chat && referenceDraft.references.some((item) => item.sourceAvailable === false)) {
      setError({
        code: 'invalid_reference',
        message:
          'A referenced note or message is unavailable or was deleted. Remove its reference before sending.',
      });
      return;
    }
    const parsed = conversationMessageContentSchema.safeParse(content);
    if (!parsed.success) {
      setError({
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'The message is invalid.',
      });
      return;
    }
    const referenceIds = chat ? referenceDraft.references.map((item) => item.sourceId) : [];
    const signature = JSON.stringify({ content, referenceIds });
    if (requestSignature.current !== signature) requestId.current = null;
    requestSignature.current = signature;
    requestId.current ??= crypto.randomUUID();
    setError(null);
    submitting.current = true;
    setPending(true);
    if (chat) referenceDraft.lock(true);
    const base = `/api/projects/${projectId}/conversations/${conversationId}`;
    const body = { requestId: requestId.current, content, ...(chat ? { referenceIds } : {}) };
    const response = chat
      ? await requestJson('POST', `${base}/turns`, sendConversationMessageResponseSchema, body)
      : await requestJson('POST', `${base}/messages`, conversationMessageResponseSchema, body);
    submitting.current = false;
    setPending(false);
    if (chat) referenceDraft.lock(false);
    if (!response.ok) {
      // Keep the draft and its request ID: retrying the same text cannot store it twice.
      setError(response.error);
      return;
    }
    requestId.current = null;
    setContent('');
    if (chat) {
      referenceDraft.clear();
      onSent?.();
    }
    router.refresh();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !event.nativeEvent.isComposing &&
      !event.repeat
    ) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      aria-label={chat ? `Message to ${target}` : 'Save a local note'}
      onSubmit={handleSubmit}
      className={chat ? 'space-y-2' : 'space-y-3'}
      noValidate
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className={chat ? 'sr-only' : undefined} htmlFor={`${fieldId}-content`}>
          {chat ? 'Message to the AI' : 'New note'}
        </Label>
      </div>
      {chat ? (
        <>
          <ReferencePreviews
            references={referenceDraft.references}
            onRemove={referenceDraft.remove}
            disabled={pending}
          />
          {referenceDraft.references.length > 0 ? (
            <p role="status" className="text-xs text-muted-foreground">
              {referenceDraft.references.length} / {conversationReferenceLimits.count} references.
              References are shared only when you send.
            </p>
          ) : null}
          {referenceDraft.references.some((item) => item.kind === 'note') ? (
            <p className="text-xs text-warning">
              Referenced note content will be shared with {target} when you send this message.
            </p>
          ) : null}
        </>
      ) : null}
      <Textarea
        id={`${fieldId}-content`}
        name="content"
        disabled={pending}
        value={content}
        onChange={(event) => {
          setContent(event.target.value);
          if (requestId.current !== null) {
            // Edited text is a new submission.
            requestId.current = null;
          }
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        rows={chat ? 2 : 4}
        className={chat ? 'max-h-[30dvh] min-h-20 resize-y' : 'max-h-[50dvh] min-h-28 resize-y'}
        placeholder={
          chat
            ? 'Ask a question, describe a goal or paste context to plan…'
            : 'Write down a question, an idea or context for yourself…'
        }
        aria-invalid={tooLong || error !== null}
        aria-describedby={`${fieldId}-hint${error === null ? '' : ` ${fieldId}-error`}`}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p
          id={`${fieldId}-hint`}
          className="min-w-0 flex-1 text-xs leading-5 break-words text-muted-foreground"
        >
          {chat ? (
            aiEnabled ? (
              <>Notes are private unless explicitly referenced. </>
            ) : (
              <>
                AI replies are off.{' '}
                <Link href="/settings" className="text-primary underline underline-offset-4">
                  Enable AI Conversations in Settings
                </Link>{' '}
                or save a note in Notes.{' '}
              </>
            )
          ) : (
            <>
              Saved in AI Agent Manager only. Share it later only by explicitly referencing it in
              Chat.{' '}
            </>
          )}
          <span className={tooLong ? 'text-destructive' : undefined}>
            {length.toLocaleString('en')} / {conversationMessageMaxLength.toLocaleString('en')}{' '}
            characters.
          </span>{' '}
          <span className="whitespace-nowrap">Ctrl/⌘ + Enter submits.</span>
        </p>
        <Button
          type="submit"
          variant={chat ? 'default' : 'outline'}
          disabled={pending || isEmpty || tooLong || blocked}
        >
          {pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : chat ? (
            <Send aria-hidden="true" />
          ) : (
            <NotebookPen aria-hidden="true" />
          )}
          {pending ? (chat ? 'Sending…' : 'Saving…') : chat ? 'Send to AI' : 'Save as Note'}
        </Button>
      </div>
      {turnActive ? (
        <p role="status" className="text-xs text-muted-foreground">
          A reply is still pending. Wait for it or stop it before adding a message or note.
        </p>
      ) : proposalsActive && chat ? (
        <p role="status" className="text-xs text-muted-foreground">
          Task proposals are being generated. Wait for them or stop the generation before sending a
          message; notes can still be saved.
        </p>
      ) : null}
      {error !== null ? (
        <Alert variant="destructive" id={`${fieldId}-error`}>
          <AlertCircle aria-hidden="true" />
          <AlertTitle>{chat ? 'The message was not sent' : 'The note was not saved'}</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
          </AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
};
