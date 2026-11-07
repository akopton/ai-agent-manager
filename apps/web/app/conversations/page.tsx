import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { ChevronRight, FolderGit2, Plus } from 'lucide-react';

import { ConversationAiNotice } from '@/components/conversations/conversation-notice';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { conversationsUrl } from '@/lib/conversations/format';
import { formatTimestamp } from '@/lib/projects/format';
import { getConversationAiStatus, listConversationOverview } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { listProjects } from '@/lib/server/projects';

export const metadata: Metadata = { title: 'Conversations · AI Agent Manager' };

const plural = (count: number): string =>
  count === 1 ? '1 conversation' : `${count.toLocaleString('en')} conversations`;

/** Entry point of the AI Conversations area: every conversation belongs to one project. */
const ConversationsPage = async () => {
  await connection();
  const result = await loadForPage(() => {
    const db = getDatabase();
    return {
      projects: listConversationOverview(db, listProjects(db)),
      ai: getConversationAiStatus(db),
    };
  });

  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight">
          Conversations
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Discuss and plan a project with Claude Code or Codex. Each conversation belongs to one
          project and keeps its own history.
        </p>
      </section>

      {!result.ok ? (
        <DatabaseNotReady message={result.message} />
      ) : result.data.projects.length === 0 ? (
        <Card className="items-center px-6 py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
            <FolderGit2 className="size-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <CardHeader className="w-full max-w-md justify-items-center">
            <CardTitle>
              <h2 className="text-lg font-semibold">Add a project first</h2>
            </CardTitle>
            <CardDescription className="leading-6">
              Conversations are organized by project. Connect a local Git repository to start one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/projects/new">
                <Plus aria-hidden="true" />
                Add project
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <ConversationAiNotice ai={result.data.ai} />
          <section aria-labelledby="projects-title" className="space-y-3">
            <h2 id="projects-title" className="text-sm font-medium text-muted-foreground">
              Projects
            </h2>
            <ul className="divide-y overflow-hidden rounded-xl border bg-card">
              {result.data.projects.map(({ project, count, lastUpdatedAt }) => (
                <li key={project.id}>
                  <Link
                    href={conversationsUrl(project.id)}
                    className="flex items-center gap-4 px-4 py-3.5 transition-colors outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate text-sm font-medium">{project.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {count === 0 ? 'No conversations yet' : plural(count)}
                        {lastUpdatedAt === null
                          ? null
                          : ` · last activity ${formatTimestamp(lastUpdatedAt)}`}
                      </p>
                    </div>
                    <ChevronRight
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
};

export default ConversationsPage;
