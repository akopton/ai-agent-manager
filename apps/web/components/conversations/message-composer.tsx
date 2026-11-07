'use client';

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, NotebookPen, Send } from 'lucide-react';
import {
  conversationMessageContentSchema,
  conversationMessageMaxLength,
} from '@ai-agent-manager/core';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/input';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import {
  conversationMessageResponseSchema,
  sendConversationMessageResponseSchema,
} from '@/lib/conversations/contracts';
import { cn } from '@/lib/utils';

type ComposerMode = 'chat' | 'note';

type MessageComposerProps = {
  projectId: string;
  conversationId: string;
  /** AI replies are enabled in Settings. */
  aiEnabled: boolean;
  /** A reply is pending or running; nothing new can be added until it finishes. */
  turnActive: boolean;
  /** For example "Claude Code · Default · Polish, technical English". */
  target: string;
};

/**
 * Writes either a chat message that is sent to the conversation's AI (C2), or a note that stays
 * in AI Agent Manager (C1). Each draft keeps one request ID until it is stored, so a double
 * submission or a retry after a lost response is stored once.
 */
export const MessageComposer = ({
  projectId,
  conversationId,
  aiEnabled,
  turnActive,
  target,
}: MessageComposerProps) => {
  const router = useRouter();
  const fieldId = useId();
  const [mode, setMode] = useState<ComposerMode>(aiEnabled ? 'chat' : 'note');
  const [content, setContent] = useState('');
  const [error, setError] = useState<ClientError | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef<string | null>(null);

  const length = content.replace(/\r\n?/g, '\n').trim().length;
  const isEmpty = length === 0;
  const tooLong = length > conversationMessageMaxLength;
  const chat = mode === 'chat';
  const blocked = turnActive || (chat && !aiEnabled);

  const switchMode = (next: ComposerMode) => {
    if (next === mode) return;
    setMode(next);
    // A note and a chat message are different submissions.
    requestId.current = null;
    setError(null);
  };

  const submit = async () => {
    if (pending || blocked) {
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
    requestId.current ??= crypto.randomUUID();
    setError(null);
    setPending(true);
    const base = `/api/projects/${projectId}/conversations/${conversationId}`;
    const body = { requestId: requestId.current, content };
    const response = chat
      ? await requestJson('POST', `${base}/turns`, sendConversationMessageResponseSchema, body)
      : await requestJson('POST', `${base}/messages`, conversationMessageResponseSchema, body);
    setPending(false);
    if (!response.ok) {
      // Keep the draft and its request ID: retrying the same text cannot store it twice.
      setError(response.error);
      return;
    }
    requestId.current = null;
    setContent('');
    router.refresh();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3" noValidate aria-busy={pending}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={`${fieldId}-content`}>{chat ? 'Message to the AI' : 'New note'}</Label>
        <div
          role="radiogroup"
          aria-label="What to do with the text"
          className="inline-flex rounded-lg border bg-inset p-0.5 text-xs"
        >
          {(
            [
              ['chat', 'Send to AI'],
              ['note', 'Save as note'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => switchMode(value)}
              className={cn(
                'rounded-md px-2.5 py-1 font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                mode === value
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <Textarea
        id={`${fieldId}-content`}
        name="content"
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
        rows={5}
        className="min-h-28 resize-y"
        placeholder={
          chat
            ? 'Ask a question, describe a goal or paste context to plan…'
            : 'Write down a question, an idea or context for yourself…'
        }
        aria-invalid={tooLong || error !== null}
        aria-describedby={`${fieldId}-hint${error === null ? '' : ` ${fieldId}-error`}`}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p id={`${fieldId}-hint`} className="max-w-xl text-xs leading-5 text-muted-foreground">
          {chat ? (
            aiEnabled ? (
              <>
                Sent to <span className="font-medium text-foreground">{target}</span> with the
                earlier chat messages of this conversation. Notes are not sent. The reply is
                generated by the worker; you can leave this page.{' '}
              </>
            ) : (
              <>
                AI replies are off.{' '}
                <Link href="/settings" className="text-primary underline underline-offset-4">
                  Enable AI Conversations in Settings
                </Link>{' '}
                or save a note.{' '}
              </>
            )
          ) : (
            <>Saved in AI Agent Manager only. It is never sent to Claude Code or Codex. </>
          )}
          <span className={tooLong ? 'text-destructive' : undefined}>
            {length.toLocaleString('en')} / {conversationMessageMaxLength.toLocaleString('en')}{' '}
            characters.
          </span>{' '}
          <span className="whitespace-nowrap">Ctrl/⌘ + Enter submits.</span>
        </p>
        <Button type="submit" disabled={pending || isEmpty || tooLong || blocked}>
          {pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : chat ? (
            <Send aria-hidden="true" />
          ) : (
            <NotebookPen aria-hidden="true" />
          )}
          {pending ? (chat ? 'Sending…' : 'Saving…') : chat ? 'Send' : 'Save note'}
        </Button>
      </div>
      {turnActive ? (
        <p role="status" className="text-xs text-muted-foreground">
          A reply is still pending. Wait for it or stop it before adding a message or note.
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
