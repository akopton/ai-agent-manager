import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ArrowLeft, Columns3, FolderArchive, Plus } from 'lucide-react';

import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { ArchivedTaskList, TaskBoard } from '@/components/tasks/task-board';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { getBoardRecoveryOptions } from '@/lib/server/recovery';
import { getProjectBoard } from '@/lib/server/tasks';
import { getBoardArchiveOptions } from '@/lib/server/workspace';
import { archivedTasksUrl, partitionArchivedTasks, taskBoardUrl } from '@/lib/tasks/board';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Board · AI Agent Manager' };

const NewTaskButton = ({ projectId }: { projectId: string }) => (
  <Button asChild>
    <Link href={`/projects/${projectId}/tasks/new`}>
      <Plus aria-hidden="true" />
      New task
    </Link>
  </Button>
);

/** Board cards offer Archive only for finished tasks; Task Details offers it for every eligible task. */
const cardArchiveStatuses = new Set(['done', 'discarded']);

const ViewSwitch = ({
  projectId,
  view,
  activeCount,
  archivedCount,
}: {
  projectId: string;
  view: 'active' | 'archived';
  activeCount: number;
  archivedCount: number;
}) => (
  <nav aria-label="Board view" className="inline-flex rounded-lg border bg-card p-0.5 text-sm">
    {(
      [
        ['active', 'Active', activeCount, taskBoardUrl(projectId)],
        ['archived', 'Archived', archivedCount, archivedTasksUrl(projectId)],
      ] as const
    ).map(([key, label, count, href]) => (
      <Link
        key={key}
        href={href}
        aria-current={view === key ? 'page' : undefined}
        className={cn(
          'rounded-md px-3 py-1.5 font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          view === key
            ? 'bg-primary/15 text-primary'
            : 'text-muted-foreground hover:bg-hover hover:text-foreground',
        )}
      >
        {label} <span className="tabular-nums">({count})</span>
      </Link>
    ))}
  </nav>
);

const BoardPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => {
  await connection();
  const { projectId } = await params;
  const view = (await searchParams).view === 'archived' ? 'archived' : 'active';
  const result = await loadForPage(() => {
    const db = getDatabase();
    const board = getProjectBoard(db, projectId);
    if (board === undefined) return undefined;
    const { active, archived } = partitionArchivedTasks(board.tasks);
    return {
      ...board,
      active,
      archived,
      recoveryOptions: getBoardRecoveryOptions(db, active),
      archiveOptions: getBoardArchiveOptions(
        db,
        view === 'archived'
          ? archived
          : active.filter((task) => cardArchiveStatuses.has(task.status)),
      ),
    };
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

  const { project, active, archived, recoveryOptions, archiveOptions } = result.data;
  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-3">
            <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
              {project.name} {view === 'archived' ? 'archived tasks' : 'board'}
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              {view === 'archived'
                ? 'Archived tasks are hidden from the board but keep their status, attempts, reviews, publications and worktree. Open one to inspect it, or restore it to the board.'
                : 'Only queued tasks are eligible to run. There is no automatic scheduler yet: open a queued task and start it explicitly (Trusted Local Mode and a trusted project are required).'}
            </p>
          </div>
          {active.length > 0 || archived.length > 0 ? (
            <NewTaskButton projectId={project.id} />
          ) : null}
        </div>
        {active.length > 0 || archived.length > 0 ? (
          <ViewSwitch
            projectId={project.id}
            view={view}
            activeCount={active.length}
            archivedCount={archived.length}
          />
        ) : null}
      </section>

      {view === 'archived' ? (
        archived.length === 0 ? (
          <Card className="items-center px-6 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
              <FolderArchive className="size-6 text-muted-foreground" aria-hidden="true" />
            </div>
            <CardHeader className="w-full max-w-md justify-items-center">
              <CardTitle>
                <h2 className="text-lg font-semibold">No archived tasks</h2>
              </CardTitle>
              <CardDescription className="leading-6">
                Archive finished tasks from the board or the task page to keep the board tidy.
                Archiving deletes nothing and can be undone.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <ArchivedTaskList
            tasks={archived}
            projectDefaultBranch={project.defaultBaseBranch}
            archiveOptions={archiveOptions}
          />
        )
      ) : active.length === 0 && archived.length === 0 ? (
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
          tasks={active}
          projectDefaultBranch={project.defaultBaseBranch}
          recoveryOptions={recoveryOptions}
          archiveOptions={archiveOptions}
        />
      )}
    </>
  );
};

export default BoardPage;
