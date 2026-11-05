import type { Metadata } from 'next';
import { connection } from 'next/server';
import { ShieldAlert, ShieldCheck } from 'lucide-react';

import { TrustedLocalSettings } from '@/components/execution/trusted-local-settings';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTimestamp } from '@/lib/projects/format';
import { getDatabase } from '@/lib/server/database';
import { getExecutionSettings } from '@/lib/server/execution';
import { loadForPage } from '@/lib/server/load';

export const metadata: Metadata = { title: 'Settings · AI Agent Manager' };

const SettingsPage = async () => {
  await connection();
  const result = await loadForPage(() => getExecutionSettings(getDatabase()));
  if (!result.ok) {
    return <DatabaseNotReady message={result.message} />;
  }
  const settings = result.data;
  const { trustedLocal, disclosure } = settings;
  const stale = trustedLocal.enabled && !trustedLocal.current;

  return (
    <>
      <section aria-labelledby="page-title" className="space-y-2">
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight">
          Settings
        </h1>
        <p className="text-muted-foreground">
          Agent execution is off until you enable Trusted Local Mode here and trust a project.
        </p>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <h2>{disclosure.title}</h2>
            {trustedLocal.current ? (
              <Badge variant="secondary">
                <ShieldCheck aria-hidden="true" />
                Enabled
              </Badge>
            ) : (
              <Badge variant="outline">Off</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Disclosure version {disclosure.version}. Strict Isolated Mode is not available: no
            isolation control has been verified, so it refuses every run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {stale ? (
            <Alert variant="warning">
              <ShieldAlert aria-hidden="true" />
              <AlertTitle>The disclosure changed</AlertTitle>
              <AlertDescription>
                <p>
                  You accepted version {trustedLocal.acceptedDisclosureVersion}. No agent runs until
                  you accept the current version.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
          <ul className="list-disc space-y-2 pl-5 text-sm leading-6">
            {disclosure.statements.map((statement) => (
              <li key={statement}>{statement}</li>
            ))}
          </ul>
          <div className="space-y-2 text-sm">
            <p className="font-medium">Risks you accept (controls that are not enforced):</p>
            <ul className="flex flex-wrap gap-2">
              {disclosure.acceptedRisks.map((risk) => (
                <li key={risk}>
                  <Badge variant="outline" className="font-mono">
                    {risk}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
          {trustedLocal.current && trustedLocal.acceptedAt !== null ? (
            <p className="text-sm text-muted-foreground">
              Accepted {formatTimestamp(trustedLocal.acceptedAt)}.
            </p>
          ) : null}
          <TrustedLocalSettings settings={settings} />
        </CardContent>
      </Card>
    </>
  );
};

export default SettingsPage;
