import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ProjectSourceAccessCard } from '@/components/conversations/project-source-access-card';
import { ProjectTrustCard } from '@/components/execution/project-trust-card';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { DisconnectProjectDialog } from '@/components/projects/disconnect-project-dialog';
import { EditProjectForm } from '@/components/projects/edit-project-form';
import { getDatabase } from '@/lib/server/database';
import { getExecutionSettings, getProjectTrust } from '@/lib/server/execution';
import { getProjectSourceAccess } from '@/lib/server/project-source-access';
import { loadForPage } from '@/lib/server/load';
import { getProjectDetails } from '@/lib/server/projects';
import { countProjectTasks } from '@/lib/server/tasks';

export const metadata: Metadata = { title: 'Project Settings · AI Agent Manager' };

const ProjectSettingsPage = async ({ params }: { params: Promise<{ projectId: string }> }) => {
  await connection();
  const { projectId } = await params;
  const result = await loadForPage(async () => {
    const db = getDatabase();
    const details = await getProjectDetails(db, projectId);
    if (details === undefined) return undefined;
    return {
      ...details,
      trust: getProjectTrust(db, projectId),
      trustedLocalEnabled: getExecutionSettings(db).trustedLocal.current,
      sourceAccess: getProjectSourceAccess(db, projectId),
      taskCount: countProjectTasks(db).get(projectId)?.total ?? 0,
    };
  });
  if (!result.ok) return <DatabaseNotReady message={result.message} />;
  if (result.data === undefined) notFound();
  const { project, repository, trust, trustedLocalEnabled, sourceAccess, taskCount } = result.data;
  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight">
          Project Settings
        </h1>
        <p className="font-mono text-sm break-all text-muted-foreground">{project.localPath}</p>
        <p className="text-sm text-muted-foreground">
          These settings apply to this project only. Execution and source sharing are independent
          permissions. Global consent and appearance are in{' '}
          <Link href="/settings" className="text-primary underline underline-offset-4">
            App Settings
          </Link>
          .
        </p>
      </section>
      <EditProjectForm project={project} repository={repository} />
      <ProjectTrustCard
        project={project}
        trust={trust}
        trustedLocalEnabled={trustedLocalEnabled}
        repositoryAvailable={repository.status === 'available'}
      />
      <section id="source-sharing" aria-label="Project source-sharing permission">
        <ProjectSourceAccessCard
          projectId={project.id}
          projectName={project.name}
          sourceAccess={sourceAccess}
        />
      </section>
      <DisconnectProjectDialog project={project} taskCount={taskCount} />
    </>
  );
};

export default ProjectSettingsPage;
