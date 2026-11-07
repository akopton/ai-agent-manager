import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { newConversationUrl } from '@/lib/conversations/format';

export const metadata: Metadata = { title: 'Conversations · AI Agent Manager' };

const ProjectConversationsPage = async ({ params }: { params: Promise<{ projectId: string }> }) => {
  const { projectId } = await params;
  return (
    <section
      aria-labelledby="page-title"
      className="flex min-h-[50dvh] flex-col items-start justify-center gap-4 rounded-xl border border-dashed p-6 sm:p-10"
    >
      <h1 id="page-title" className="text-2xl font-semibold">
        Project conversations
      </h1>
      <p className="max-w-md text-sm leading-6 text-muted-foreground">
        Select a conversation from the project list, or start a new topic. Each conversation has its
        own chat, task proposals and local notes.
      </p>
      <Button asChild>
        <Link href={newConversationUrl(projectId)}>New conversation</Link>
      </Button>
    </section>
  );
};

export default ProjectConversationsPage;
