'use client';

import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { Quote, X } from 'lucide-react';
import { conversationReferenceLimits, type ConversationMessage } from '@ai-agent-manager/core';
import { Button } from '@/components/ui/button';
import { messageAnchor } from '@/lib/conversations/proposals';

import type { ConversationReferencePreview as ReferencePreview } from '@/lib/conversations/contracts';

type ReferenceDraft = {
  references: ReferencePreview[];
  locked: boolean;
  select: (source: ReferencePreview) => void;
  remove: (id: string) => void;
  clear: () => void;
  lock: (locked: boolean) => void;
};
const emptyDraft: ReferenceDraft = {
  references: [],
  locked: false,
  select: () => {},
  remove: () => {},
  clear: () => {},
  lock: () => {},
};
const ReferenceDraftContext = createContext(emptyDraft);
export const useReferenceDraft = () => useContext(ReferenceDraftContext);

/** Lives inside the conversation-keyed workspace, outside the persistently mounted tabs. */
export const ReferenceDraftProvider = ({
  children,
  onSelect,
  sources,
}: {
  children: ReactNode;
  onSelect: () => void;
  sources?: readonly ReferencePreview[];
}) => {
  const [references, setReferences] = useState<ReferencePreview[]>([]);
  const [locked, setLocked] = useState(false);
  const pending = useRef(false);
  return (
    <ReferenceDraftContext.Provider
      value={{
        references:
          sources === undefined
            ? references
            : references.map(
                (item) =>
                  sources.find((source) => source.sourceId === item.sourceId) ?? {
                    ...item,
                    sourceAvailable: false,
                  },
              ),
        locked,
        select: (source) => {
          if (pending.current) return;
          setReferences((current) =>
            current.some((item) => item.sourceId === source.sourceId)
              ? current
              : current.length >= conversationReferenceLimits.count
                ? current
                : [...current, source],
          );
          onSelect();
        },
        remove: (id) => {
          if (!pending.current) {
            setReferences((current) => current.filter((item) => item.sourceId !== id));
          }
        },
        clear: () => {
          setReferences([]);
        },
        lock: (value) => {
          pending.current = value;
          setLocked(value);
        },
      }}
    >
      {children}
    </ReferenceDraftContext.Provider>
  );
};

export const ReferenceButton = ({
  source,
  disabled = false,
}: {
  source: Pick<ConversationMessage, 'id' | 'kind' | 'role' | 'content'>;
  disabled?: boolean;
}) => {
  const draft = useReferenceDraft();
  const selected = draft.references.some((item) => item.sourceId === source.id);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="min-h-9 self-start px-2 text-xs"
      disabled={
        disabled ||
        draft.locked ||
        selected ||
        draft.references.length >= conversationReferenceLimits.count
      }
      onClick={() =>
        draft.select({
          sourceId: source.id,
          kind: source.kind,
          role: source.role,
          preview: source.content.slice(0, conversationReferenceLimits.previewCharacters),
        })
      }
    >
      <Quote aria-hidden="true" />
      {selected ? 'Referenced' : source.kind === 'note' ? 'Reference in chat' : 'Reference'}
    </Button>
  );
};

/** The same bounded quotation presentation for selected and already-sent provenance. */
export const ReferencePreviews = ({
  references,
  onRemove,
  disabled = false,
}: {
  references: readonly ReferencePreview[];
  onRemove?: (id: string) => void;
  disabled?: boolean;
}) =>
  references.length === 0 ? null : (
    <ul
      aria-label={onRemove ? 'Selected references' : 'Sent references'}
      className="space-y-1 text-xs"
    >
      {references.map((item) => (
        <li
          key={item.sourceId}
          className="flex min-w-0 items-start gap-2 rounded-md border bg-inset px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            {item.sourceAvailable === false ? (
              <p className="font-medium text-muted-foreground">
                {item.kind === 'note' ? 'Saved note' : 'Message'} · Source unavailable ·{' '}
                {onRemove ? 'Remove before sending' : 'Snapshot retained'}
              </p>
            ) : (
              <a
                href={
                  item.kind === 'note'
                    ? `?tab=notes#note-${item.sourceId}`
                    : `?tab=chat#${messageAnchor(item.sourceId)}`
                }
                className="rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.kind === 'note'
                  ? 'Saved note'
                  : item.role === 'assistant'
                    ? 'AI reply'
                    : 'Your message'}{' '}
                · View source
              </a>
            )}
            <p className="line-clamp-2 break-words whitespace-pre-wrap">
              {item.preview}
              {item.preview.length === conversationReferenceLimits.previewCharacters ? '…' : ''}
            </p>
          </div>
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={`Remove reference to ${item.kind === 'note' ? 'saved note' : item.role === 'assistant' ? 'AI reply' : 'your message'}`}
              onClick={() => onRemove(item.sourceId)}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
