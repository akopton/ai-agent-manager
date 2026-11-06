import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ArrowLeft } from 'lucide-react';

import { ConversationSettingsForm } from '@/components/conversations/conversation-settings-form';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { conversationsUrl } from '@/lib/conversations/format';
import { getProjectConversations } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';

export const metadata: Metadata = { title: 'New conversation · AI Agent Manager' };

const NewConversationPage = async ({ params }: { params: Promise<{ projectId: string }> }) => {
  await connection();
  const { projectId } = await params;
  const result = await loadForPage(() => getProjectConversations(getDatabase(), projectId));

  if (!result.ok) {
    return <DatabaseNotReady message={result.message} />;
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project } = result.data;
  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href={conversationsUrl(project.id)}>
            <ArrowLeft aria-hidden="true" />
            {project.name} conversations
          </Link>
        </Button>
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight">
          New conversation
        </h1>
      </section>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>
            <h2>Conversation settings</h2>
          </CardTitle>
          <CardDescription>
            You can change these at any time. Creating a conversation starts no agent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConversationSettingsForm projectId={project.id} />
        </CardContent>
      </Card>
    </>
  );
};

export default NewConversationPage;
