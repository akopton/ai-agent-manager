'use client';

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, NotebookPen } from 'lucide-react';
import {
  conversationMessageContentSchema,
  conversationMessageMaxLength,
} from '@ai-agent-manager/core';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/input';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import { conversationMessageResponseSchema } from '@/lib/conversations/contracts';

type MessageComposerProps = { projectId: string; conversationId: string };

/**
 * Saves operator notes (C1). A note is stored in AI Agent Manager only; it is not sent to Claude
 * Code or Codex and no reply is generated. Each draft keeps one request ID until it is saved, so
 * a double submission or a retry after a lost response is stored once.
 */
export const MessageComposer = ({ projectId, conversationId }: MessageComposerProps) => {
  const router = useRouter();
  const fieldId = useId();
  const [content, setContent] = useState('');
  const [error, setError] = useState<ClientError | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef<string | null>(null);

  // Same normalization as the stored content: line endings and surrounding whitespace don't count.
  const length = content.replace(/\r\n?/g, '\n').trim().length;
  const isEmpty = length === 0;
  const tooLong = length > conversationMessageMaxLength;

  const submit = async () => {
    if (pending) {
      return;
    }
    const parsed = conversationMessageContentSchema.safeParse(content);
    if (!parsed.success) {
      setError({
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'The note is invalid.',
      });
      return;
    }
    requestId.current ??= crypto.randomUUID();
    setError(null);
    setPending(true);
    const response = await requestJson(
      'POST',
      `/api/projects/${projectId}/conversations/${conversationId}/messages`,
      conversationMessageResponseSchema,
      { requestId: requestId.current, content },
    );
    setPending(false);
    if (!response.ok) {
      // Keep the draft and its request ID: retrying the same text cannot save it twice.
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
      <Label htmlFor={`${fieldId}-content`}>New note</Label>
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
        placeholder="Write down a question, an idea or context for this conversation…"
        aria-invalid={tooLong || error !== null}
        aria-describedby={`${fieldId}-hint${error === null ? '' : ` ${fieldId}-error`}`}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p id={`${fieldId}-hint`} className="max-w-xl text-xs leading-5 text-muted-foreground">
          Saved as a note in AI Agent Manager only. It is not sent to Claude Code or Codex, and no
          reply is generated. Plain text; Markdown is kept as written.{' '}
          <span className={tooLong ? 'text-destructive' : undefined}>
            {length.toLocaleString('en')} / {conversationMessageMaxLength.toLocaleString('en')}{' '}
            characters.
          </span>{' '}
          <span className="whitespace-nowrap">Ctrl/⌘ + Enter saves.</span>
        </p>
        <Button type="submit" disabled={pending || isEmpty || tooLong}>
          {pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <NotebookPen aria-hidden="true" />
          )}
          {pending ? 'Saving…' : 'Save note'}
        </Button>
      </div>
      {error !== null ? (
        <Alert variant="destructive" id={`${fieldId}-error`}>
          <AlertCircle aria-hidden="true" />
          <AlertTitle>The note was not saved</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
          </AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
};
