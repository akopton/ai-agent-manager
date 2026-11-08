import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Suspense, type ReactNode } from 'react';
import { findProjectById } from '@ai-agent-manager/database';
import { projectIdSchema } from '@ai-agent-manager/core';
import { ProjectContent } from '@/components/projects/project-content';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import {
  ProjectWorkspaceLinks,
  ProjectWorkspaceNav,
} from '@/components/projects/project-workspace-nav';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';

const ProjectLayout = async ({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) => {
  await connection();
  const { projectId } = await params;
  if (!projectIdSchema.safeParse(projectId).success) notFound();
  const result = await loadForPage(() => findProjectById(getDatabase(), projectId));
  if (!result.ok) return <DatabaseNotReady message={result.message} />;
  if (result.data === undefined) notFound();

  return (
    <section
      data-project-workspace
      className="flex h-[800px] min-h-0 min-w-0 flex-col gap-4 md:h-full"
    >
      <header className="shrink-0 space-y-2 border-b pb-3 lg:flex lg:items-center lg:justify-between lg:gap-4 lg:space-y-0">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 text-lg font-semibold break-words">{result.data.name}</p>
          <Link
            href="/projects"
            className="rounded text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            All projects / Switch project
          </Link>
        </div>
        <Suspense fallback={<ProjectWorkspaceLinks projectId={projectId} pathname="" />}>
          <ProjectWorkspaceNav projectId={projectId} />
        </Suspense>
      </header>
      <ProjectContent>{children}</ProjectContent>
    </section>
  );
};

export default ProjectLayout;
