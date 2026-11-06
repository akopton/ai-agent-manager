import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ArrowLeft, MessagesSquare, Plus } from 'lucide-react';

import { ConversationList } from '@/components/conversations/conversation-list';
import { NotesOnlyNotice } from '@/components/conversations/conversation-notice';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { newConversationUrl } from '@/lib/conversations/format';
import { getProjectConversations } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';

export const metadata: Metadata = { title: 'Conversations · AI Agent Manager' };

const NewConversationButton = ({ projectId }: { projectId: string }) => (
  <Button asChild>
    <Link href={newConversationUrl(projectId)}>
      <Plus aria-hidden="true" />
      New conversation
    </Link>
  </Button>
);

const ProjectConversationsPage = async ({ params }: { params: Promise<{ projectId: string }> }) => {
  await connection();
  const { projectId } = await params;
  const result = await loadForPage(() => getProjectConversations(getDatabase(), projectId));

  if (!result.ok) {
    return (
      <>
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href="/conversations">
            <ArrowLeft aria-hidden="true" />
            All conversations
          </Link>
        </Button>
        <DatabaseNotReady message={result.message} />
      </>
    );
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project, conversations } = result.data;
  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href={`/projects/${project.id}`}>
            <ArrowLeft aria-hidden="true" />
            Back to project
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-3">
            <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
              {project.name} conversations
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Each conversation has its own history, agent runtime, model and language.
            </p>
          </div>
          {conversations.length > 0 ? <NewConversationButton projectId={project.id} /> : null}
        </div>
      </section>

      <NotesOnlyNotice />

      {conversations.length === 0 ? (
        <Card className="items-center px-6 py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
            <MessagesSquare className="size-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <CardHeader className="w-full max-w-md justify-items-center">
            <CardTitle>
              <h2 className="text-lg font-semibold">No conversations yet</h2>
            </CardTitle>
            <CardDescription className="leading-6">
              Start a conversation for a topic such as a redesign or a test strategy. For now it
              collects your notes; AI replies will be enabled in C2.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NewConversationButton projectId={project.id} />
          </CardContent>
        </Card>
      ) : (
        <ConversationList projectId={project.id} conversations={conversations} />
      )}
    </>
  );
};

export default ProjectConversationsPage;
