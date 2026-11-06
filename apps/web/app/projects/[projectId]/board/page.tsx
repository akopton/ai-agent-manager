import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ArrowLeft, Columns3, Plus } from 'lucide-react';

import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { TaskBoard } from '@/components/tasks/task-board';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { getBoardRecoveryOptions } from '@/lib/server/recovery';
import { getProjectBoard } from '@/lib/server/tasks';

export const metadata: Metadata = { title: 'Board · AI Agent Manager' };

const NewTaskButton = ({ projectId }: { projectId: string }) => (
  <Button asChild>
    <Link href={`/projects/${projectId}/tasks/new`}>
      <Plus aria-hidden="true" />
      New task
    </Link>
  </Button>
);

const BoardPage = async ({ params }: { params: Promise<{ projectId: string }> }) => {
  await connection();
  const { projectId } = await params;
  const result = await loadForPage(() => {
    const db = getDatabase();
    const board = getProjectBoard(db, projectId);
    return board === undefined
      ? undefined
      : { ...board, recoveryOptions: getBoardRecoveryOptions(db, board.tasks) };
  });

  if (!result.ok) {
    return (
      <>
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href="/projects">
            <ArrowLeft aria-hidden="true" />
            All projects
          </Link>
        </Button>
        <DatabaseNotReady message={result.message} />
      </>
    );
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project, tasks, recoveryOptions } = result.data;
  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5">
          <Link href={`/projects/${project.id}`}>
            <ArrowLeft aria-hidden="true" />
            Back to project
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-3">
            <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
              {project.name} board
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Only queued tasks are eligible to run. There is no automatic scheduler yet: open a
              queued task and start it explicitly (Trusted Local Mode and a trusted project are
              required).
            </p>
          </div>
          {tasks.length > 0 ? <NewTaskButton projectId={project.id} /> : null}
        </div>
      </section>

      {tasks.length === 0 ? (
        <Card className="items-center px-6 py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
            <Columns3 className="size-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <CardHeader className="w-full max-w-md justify-items-center">
            <CardTitle>
              <h2 className="text-lg font-semibold">No tasks yet</h2>
            </CardTitle>
            <CardDescription className="leading-6">
              Create a task with a prompt and an agent runtime. It starts in Backlog and does not
              run until you queue it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NewTaskButton projectId={project.id} />
          </CardContent>
        </Card>
      ) : (
        <TaskBoard
          tasks={tasks}
          projectDefaultBranch={project.defaultBaseBranch}
          recoveryOptions={recoveryOptions}
        />
      )}
    </>
  );
};

export default BoardPage;
