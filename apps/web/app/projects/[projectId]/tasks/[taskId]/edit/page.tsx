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
import { findProjectTask, findTaskWorktreeBase } from '@/lib/server/tasks';
import { taskUrl } from '@/lib/tasks/board';

export const metadata: Metadata = { title: 'Edit task · AI Agent Manager' };

const EditTaskPage = async ({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}) => {
  await connection();
  const { projectId, taskId } = await params;
  const result = await loadForPage(async () => {
    const db = getDatabase();
    const found = findProjectTask(db, projectId, taskId);
    if (found === undefined) {
      return undefined;
    }
    // Branches for the base branch select are read live (read-only) from the repository.
    const details = await getProjectDetails(db, projectId);
    return details === undefined
      ? undefined
      : {
          ...found,
          repository: details.repository,
          worktreeBaseBranch: findTaskWorktreeBase(db, found.task.id),
        };
  });

  if (!result.ok) {
    return <DatabaseNotReady message={result.message} />;
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project, task, repository, worktreeBaseBranch } = result.data;
  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href={taskUrl(project.id, task.id)}>
            <ArrowLeft aria-hidden="true" />
            Back to task
          </Link>
        </Button>
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
          Edit {task.title}
        </h1>
        <p className="text-sm text-muted-foreground">In {project.name}</p>
      </section>
      <TaskForm
        project={{ id: project.id, defaultBaseBranch: project.defaultBaseBranch }}
        branches={repository.status === 'available' ? repository.branches : null}
        task={task}
        worktreeBaseBranch={worktreeBaseBranch}
      />
    </>
  );
};

export default EditTaskPage;
