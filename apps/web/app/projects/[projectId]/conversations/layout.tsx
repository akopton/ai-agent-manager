import { Suspense, type ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ConversationRouteContent } from '@/components/conversations/conversation-route-content';
import { ConversationNavigation } from '@/components/conversations/conversation-navigation';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { getProjectConversations } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';

const ConversationsLayout = async ({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) => {
  await connection();
  const { projectId } = await params;
  const result = await loadForPage(() => getProjectConversations(getDatabase(), projectId));
  if (!result.ok) return <DatabaseNotReady message={result.message} />;
  if (result.data === undefined) notFound();
  return (
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] items-start gap-4 lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)]">
      <Suspense>
        <ConversationNavigation projectId={projectId} conversations={result.data.conversations} />
      </Suspense>
      <ConversationRouteContent>{children}</ConversationRouteContent>
    </div>
  );
};

export default ConversationsLayout;
