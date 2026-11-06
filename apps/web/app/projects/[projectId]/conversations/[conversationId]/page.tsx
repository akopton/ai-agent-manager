import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ArrowLeft } from 'lucide-react';

import { ConversationHistory } from '@/components/conversations/conversation-history';
import { NotesOnlyNotice } from '@/components/conversations/conversation-notice';
import { ConversationSettingsForm } from '@/components/conversations/conversation-settings-form';
import { MessageComposer } from '@/components/conversations/message-composer';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { conversationsUrl, describeLanguageMode, describeModel } from '@/lib/conversations/format';
import { findConversationDetail } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { agentRuntimeLabels } from '@/lib/tasks/board';

export const metadata: Metadata = { title: 'Conversation · AI Agent Manager' };

const ConversationPage = async ({
  params,
}: {
  params: Promise<{ projectId: string; conversationId: string }>;
}) => {
  await connection();
  const { projectId, conversationId } = await params;
  const result = await loadForPage(() =>
    findConversationDetail(getDatabase(), projectId, conversationId),
  );

  if (!result.ok) {
    return <DatabaseNotReady message={result.message} />;
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project, conversation, messages } = result.data;
  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href={conversationsUrl(project.id)}>
            <ArrowLeft aria-hidden="true" />
            {project.name} conversations
          </Link>
        </Button>
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
          {conversation.title}
        </h1>
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Runtime</dt>
            <dd className="font-medium">{agentRuntimeLabels[conversation.agentRuntime]}</dd>
          </div>
          <div className="flex min-w-0 gap-2">
            <dt className="text-muted-foreground">Model</dt>
            <dd className="font-medium break-all">{describeModel(conversation.modelId)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Language</dt>
            <dd className="font-medium">{describeLanguageMode(conversation.languageMode)}</dd>
          </div>
        </dl>
      </section>

      <NotesOnlyNotice />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="history-title" className="min-w-0 space-y-4">
          <h2 id="history-title" className="sr-only">
            History
          </h2>
          <ConversationHistory messages={messages} />
          <Card>
            <CardContent>
              <MessageComposer projectId={project.id} conversationId={conversation.id} />
            </CardContent>
          </Card>
        </section>

        <Card className="lg:sticky lg:top-6">
          <CardHeader>
            <CardTitle>
              <h2>Settings</h2>
            </CardTitle>
            <CardDescription>
              Used for future replies. Changing them never alters saved notes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConversationSettingsForm projectId={project.id} conversation={conversation} />
          </CardContent>
        </Card>
      </div>
    </>
  );
};

export default ConversationPage;
