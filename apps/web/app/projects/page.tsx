import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { ChevronRight, FolderGit2, GitBranch, Globe, Plus } from 'lucide-react';

import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTimestamp } from '@/lib/projects/format';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { listProjects } from '@/lib/server/projects';

export const metadata: Metadata = { title: 'Projects · AI Agent Manager' };

const AddProjectButton = () => (
  <Button asChild>
    <Link href="/projects/new">
      <Plus aria-hidden="true" />
      Add project
    </Link>
  </Button>
);

const ProjectsPage = async () => {
  // SQLite reads are synchronous; render per request instead of at build time.
  await connection();
  const result = await loadForPage(() => listProjects(getDatabase()));

  return (
    <>
      <section
        aria-labelledby="page-title"
        className="flex flex-wrap items-start justify-between gap-4"
      >
        <div>
          <h1 id="page-title" className="text-3xl font-semibold tracking-tight">
            Projects
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Local Git repositories connected to AI Agent Manager.
          </p>
        </div>
        {result.ok && result.data.length > 0 ? <AddProjectButton /> : null}
      </section>

      {!result.ok ? (
        <DatabaseNotReady message={result.message} />
      ) : result.data.length === 0 ? (
        <Card className="items-center px-6 py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
            <FolderGit2 className="size-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <CardHeader className="w-full max-w-md justify-items-center">
            <CardTitle>
              <h2 className="text-lg font-semibold">No projects yet</h2>
            </CardTitle>
            <CardDescription className="leading-6">
              Add an existing local Git repository to get started. The repository stays where it is
              and is not modified.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AddProjectButton />
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3" aria-label="Registered projects">
          {result.data.map((project) => (
            <li key={project.id}>
              <Link
                href={`/projects/${project.id}`}
                className="group block rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <Card className="transition-colors group-hover:bg-muted/40">
                  <CardContent className="flex items-center gap-4">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <FolderGit2 className="size-5 text-muted-foreground" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <p className="truncate font-medium">{project.name}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {project.localPath}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">
                          <GitBranch aria-hidden="true" />
                          {project.defaultBaseBranch}
                        </Badge>
                        <Badge variant="outline">
                          <Globe aria-hidden="true" />
                          {project.remoteName ?? 'No remote'}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          Added {formatTimestamp(project.createdAt)}
                        </span>
                      </div>
                    </div>
                    <ChevronRight
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

export default ProjectsPage;
