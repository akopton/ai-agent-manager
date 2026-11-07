import Link from 'next/link';
import { connection } from 'next/server';
import { listRecentProjects } from '@ai-agent-manager/database';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { RecentProjects } from '@/components/projects/recent-projects';
import { Button } from '@/components/ui/button';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';

const HomePage = async () => {
  await connection();
  const result = await loadForPage(() => listRecentProjects(getDatabase()));
  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight">
          Overview
        </h1>
        <p className="text-sm text-muted-foreground">Continue work in your recent projects.</p>
      </section>
      <section aria-labelledby="recent-projects" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="recent-projects" className="text-lg font-semibold">
            Recent Projects
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link href="/projects/new">Add Project</Link>
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link href="/projects">View All Projects</Link>
            </Button>
          </div>
        </div>
        {result.ok ? (
          <RecentProjects projects={result.data} />
        ) : (
          <DatabaseNotReady message={result.message} />
        )}
      </section>
    </>
  );
};

export default HomePage;
