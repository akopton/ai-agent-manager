'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Pencil, Trash2, X } from 'lucide-react';
import {
  updateConversationNoteInputSchema,
  conversationMessageMaxLength,
  type ConversationMessage,
} from '@ai-agent-manager/core';
import { ReferenceButton } from '@/components/conversations/conversation-references';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  updateConversationNoteResponseSchema,
  deleteConversationNoteResponseSchema,
} from '@/lib/conversations/contracts';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import { formatTimestamp } from '@/lib/projects/format';

type NoteEdit = { content: string; revision: number };

export const ConversationNoteCard = ({
  projectId,
  note,
  onDeleted,
}: {
  projectId: string;
  note: ConversationMessage;
  onDeleted: () => void;
}) => {
  const router = useRouter();
  const fieldId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [edit, setEdit] = useState<NoteEdit | null>(null);
  const [deleteRevision, setDeleteRevision] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const url = `/api/projects/${projectId}/conversations/${note.conversationId}/messages/${note.id}`;
  const label = `note ${note.sequence}`;
  const cancelEdit = () => {
    setEdit(null);
    setError(null);
    requestAnimationFrame(() => editButton.current?.focus({ preventScroll: true }));
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || edit === null) return;
    const parsed = updateConversationNoteInputSchema.safeParse(edit);
    if (!parsed.success) {
      setError({
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'The note is invalid.',
      });
      return;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    const result = await requestJson(
      'PATCH',
      url,
      updateConversationNoteResponseSchema,
      parsed.data,
    );
    submitting.current = false;
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      router.refresh();
      return;
    }
    cancelEdit();
    router.refresh();
  };
  const remove = async () => {
    if (submitting.current || deleteRevision === null) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    const result = await requestJson('DELETE', url, deleteConversationNoteResponseSchema, {
      revision: deleteRevision,
    });
    submitting.current = false;
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      router.refresh();
      return;
    }
    setDeleteRevision(null);
    onDeleted();
    router.refresh();
  };
  return (
    <article
      aria-label={`Saved ${label}`}
      className="rounded-xl border border-dashed bg-inset/60 px-4 py-3"
    >
      <header className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>Note · Private unless referenced</span>
        <time dateTime={new Date(note.createdAt).toISOString()}>
          {formatTimestamp(note.createdAt)}
        </time>
        {(note.revision ?? 1) > 1 && note.updatedAt ? (
          <span>
            Edited{' '}
            <time dateTime={new Date(note.updatedAt).toISOString()}>
              {formatTimestamp(note.updatedAt)}
            </time>
          </span>
        ) : null}
      </header>
      {edit === null ? (
        <p className="text-sm leading-6 break-words whitespace-pre-wrap">{note.content}</p>
      ) : (
        <form
          aria-label={`Edit ${label}`}
          onSubmit={(event) => void save(event)}
          className="space-y-2"
          aria-busy={pending}
          noValidate
        >
          <Label htmlFor={fieldId}>Note content</Label>
          <Textarea
            id={fieldId}
            autoFocus
            value={edit.content}
            disabled={pending}
            onChange={(event) => {
              setEdit({ ...edit, content: event.target.value });
              setError(null);
            }}
            rows={4}
            className="max-h-[40dvh] resize-y"
            aria-invalid={error !== null}
            aria-describedby={`${fieldId}-hint${error ? ` ${fieldId}-error` : ''}`}
          />
          <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
            {edit.content.replace(/\r\n?/g, '\n').trim().length.toLocaleString('en')} /{' '}
            {conversationMessageMaxLength.toLocaleString('en')} characters. Saving does not send
            anything to AI.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={cancelEdit}
            >
              <X aria-hidden="true" />
              Cancel
            </Button>
          </div>
        </form>
      )}
      <footer className="mt-3 flex flex-wrap gap-2 border-t pt-2">
        <ReferenceButton source={note} disabled={pending || edit !== null} />
        <Button
          ref={editButton}
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending || edit !== null}
          aria-label={`Edit ${label}`}
          onClick={() => {
            setEdit({ content: note.content, revision: note.revision ?? 1 });
            setError(null);
          }}
        >
          <Pencil aria-hidden="true" />
          Edit
        </Button>
        <AlertDialog
          open={deleteRevision !== null}
          onOpenChange={(open) => {
            if (submitting.current) return;
            setDeleteRevision(open ? (note.revision ?? 1) : null);
            setError(null);
          }}
        >
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={pending || edit !== null}
              aria-label={`Delete ${label}`}
            >
              <Trash2 aria-hidden="true" />
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent
            onEscapeKeyDown={(event) => {
              if (pending) event.preventDefault();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Delete note?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the note from Notes and clears its current text. Its position and
                deletion record remain. Copies already saved in AI reference snapshots and provider
                records are not erased.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error.message}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button variant="outline" disabled={pending}>
                  Cancel
                </Button>
              </AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => void remove()}
              >
                {pending ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 aria-hidden="true" />
                )}
                Delete note
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </footer>
      {error && deleteRevision === null ? (
        <p id={`${fieldId}-error`} role="alert" className="mt-2 text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
    </article>
  );
};
