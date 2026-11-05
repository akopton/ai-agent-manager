import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ArrowLeft } from 'lucide-react';

import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { EditProjectForm } from '@/components/projects/edit-project-form';
import { Button } from '@/components/ui/button';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { getProjectDetails } from '@/lib/server/projects';

export const metadata: Metadata = { title: 'Edit project · AI Agent Manager' };

const EditProjectPage = async ({ params }: { params: Promise<{ projectId: string }> }) => {
  await connection();
  const { projectId } = await params;
  // Branches and remotes for the selects are read live from the registered repository.
  const result = await loadForPage(() => getProjectDetails(getDatabase(), projectId));

  const backLink = (
    <Button asChild variant="ghost" size="sm" className="-ml-2.5">
      <Link href={result.ok && result.data !== undefined ? `/projects/${projectId}` : '/projects'}>
        <ArrowLeft aria-hidden="true" />
        {result.ok && result.data !== undefined ? 'Back to project' : 'All projects'}
      </Link>
    </Button>
  );

  if (!result.ok) {
    return (
      <>
        {backLink}
        <DatabaseNotReady message={result.message} />
      </>
    );
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project, repository } = result.data;
  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        {backLink}
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
          Edit {project.name}
        </h1>
        <p className="font-mono text-sm break-all text-muted-foreground">{project.localPath}</p>
      </section>
      <EditProjectForm project={project} repository={repository} />
    </>
  );
};

export default EditProjectPage;
