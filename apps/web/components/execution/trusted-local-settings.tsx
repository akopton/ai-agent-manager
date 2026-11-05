'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, ShieldAlert, ShieldOff } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import {
  executionSettingsResponseSchema,
  type ExecutionSettingsView,
} from '@/lib/execution/contracts';

/**
 * Explicit Trusted Local acceptance. The operator must tick the confirmation after reading the
 * disclosure; the request names the disclosure version and every risk shown, so an acceptance of
 * a different text is refused by the server.
 */
export const TrustedLocalSettings = ({ settings }: { settings: ExecutionSettingsView }) => {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const submit = async (enabled: boolean) => {
    setPending(true);
    setError(null);
    const body = enabled
      ? {
          enabled: true,
          disclosureVersion: settings.disclosure.version,
          acceptedRisks: settings.disclosure.acceptedRisks,
        }
      : { enabled: false };
    const result = await requestJson(
      'PUT',
      '/api/settings/trusted-local',
      executionSettingsResponseSchema,
      body,
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
      {settings.trustedLocal.current ? (
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void submit(false)}
        >
          {pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <ShieldOff aria-hidden="true" />
          )}
          Disable Trusted Local Mode
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
              I have read disclosure {settings.disclosure.version} and accept every risk listed
              above for repositories I mark as trusted.
            </span>
          </label>
          <Button type="button" disabled={!confirmed || pending} onClick={() => void submit(true)}>
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <ShieldAlert aria-hidden="true" />
            )}
            Enable Trusted Local Mode
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
