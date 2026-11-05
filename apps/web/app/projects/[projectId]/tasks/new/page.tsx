import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ArrowLeft } from 'lucide-react';

import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { TaskForm } from '@/components/tasks/task-form';
import { Button } from '@/components/ui/button';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { getProjectDetails } from '@/lib/server/projects';
import { taskBoardUrl } from '@/lib/tasks/board';

export const metadata: Metadata = { title: 'New task · AI Agent Manager' };

const NewTaskPage = async ({ params }: { params: Promise<{ projectId: string }> }) => {
  await connection();
  const { projectId } = await params;
  // Branches for the base branch select are read live (read-only) from the registered repository.
  const result = await loadForPage(() => getProjectDetails(getDatabase(), projectId));

  if (!result.ok) {
    return <DatabaseNotReady message={result.message} />;
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project, repository } = result.data;
  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href={taskBoardUrl(project.id)}>
            <ArrowLeft aria-hidden="true" />
            Back to board
          </Link>
        </Button>
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
          New task
        </h1>
        <p className="text-sm text-muted-foreground">In {project.name}</p>
      </section>
      <TaskForm
        project={{ id: project.id, defaultBaseBranch: project.defaultBaseBranch }}
        branches={repository.status === 'available' ? repository.branches : null}
      />
    </>
  );
};

export default NewTaskPage;
