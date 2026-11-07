'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, MessageSquareOff, MessagesSquare } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import {
  conversationSettingsResponseSchema,
  type ConversationSettingsView,
} from '@/lib/conversations/contracts';

/**
 * Explicit AI Conversations acceptance, separate from Trusted Local execution. The request names
 * the disclosure version shown, so an acceptance of a different text is refused by the server.
 */
export const ConversationAiSettings = ({ settings }: { settings: ConversationSettingsView }) => {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const submit = async (enabled: boolean) => {
    setPending(true);
    setError(null);
    const result = await requestJson(
      'PUT',
      '/api/settings/conversations',
      conversationSettingsResponseSchema,
      enabled
        ? { enabled: true, disclosureVersion: settings.disclosure.version }
        : { enabled: false },
    );
    setPending(false);
    setConfirmed(false);
    if (!result.ok) {
      setError(result.error);
    }
    router.refresh();
  };

  return (
    <div className="space-y-4">
      {settings.current ? (
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void submit(false)}
        >
          {pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <MessageSquareOff aria-hidden="true" />
          )}
          Turn AI replies off
        </Button>
      ) : (
        <div className="space-y-3">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              I have read disclosure {settings.disclosure.version} and want messages I send in
              conversations to be answered by Claude Code or Codex on this Mac.
            </span>
          </label>
          <Button type="button" disabled={!confirmed || pending} onClick={() => void submit(true)}>
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <MessagesSquare aria-hidden="true" />
            )}
            Enable AI replies
          </Button>
        </div>
      )}
      {error !== null ? (
        <Alert variant="destructive" role="alert">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>The setting was not changed</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};
