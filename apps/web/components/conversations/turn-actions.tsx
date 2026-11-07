'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import { conversationTurnResponseSchema } from '@/lib/conversations/contracts';

type TurnActionsProps = {
  projectId: string;
  conversationId: string;
  turnId: string;
  canStop: boolean;
  canRetry: boolean;
};

/**
 * Stop (terminates the CLI's process group through the worker) and Retry (asks again with the
 * conversation's current settings). Each Retry draft keeps one request ID, so a double click
 * queues one turn.
 */
export const TurnActions = ({
  projectId,
  conversationId,
  turnId,
  canStop,
  canRetry,
}: TurnActionsProps) => {
  const router = useRouter();
  const [pending, setPending] = useState<'stop' | 'retry' | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const retryRequestId = useRef<string | null>(null);
  const base = `/api/projects/${projectId}/conversations/${conversationId}/turns/${turnId}`;

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
      conversationTurnResponseSchema,
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
