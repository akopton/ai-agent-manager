import { Suspense, type ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
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
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <Suspense>
        <ConversationNavigation projectId={projectId} conversations={result.data.conversations} />
      </Suspense>
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  );
};

export default ConversationsLayout;
