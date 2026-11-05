import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Eye, GitBranch, Globe } from 'lucide-react';

import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ProjectDetails, RepositoryState } from '@/lib/projects/contracts';
import { describeHead, describeWorkingTree, formatTimestamp } from '@/lib/projects/format';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { getProjectDetails } from '@/lib/server/projects';

export const metadata: Metadata = { title: 'Project · AI Agent Manager' };

const maxListedBranches = 50;

type AvailableRepository = Extract<RepositoryState, { status: 'available' }>;

const BackLink = () => (
  <Button asChild variant="ghost" size="sm" className="-ml-2.5">
    <Link href="/projects">
      <ArrowLeft aria-hidden="true" />
      All projects
    </Link>
  </Button>
);

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0">{children}</dd>
  </>
);

const RepositoryProblem = ({ repository }: { repository: RepositoryState }) => {
  if (repository.status === 'available') {
    return null;
  }
  const title = {
    unavailable: 'Repository unavailable',
    identity_changed: 'Repository changed',
    inspection_failed: 'Repository could not be inspected',
  }[repository.status];
  return (
    <Alert variant="warning">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{repository.message}</p>
        <p>The project registration is unchanged. Nothing was modified on disk.</p>
      </AlertDescription>
    </Alert>
  );
};

const RepositoryCards = ({
  project,
  repository,
}: {
  project: ProjectDetails['project'];
  repository: AvailableRepository;
}) => {
  const remote = repository.remotes.find(({ name }) => name === project.remoteName);
  const listedBranches = repository.branches.slice(0, maxListedBranches);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Branches</h2>
          </CardTitle>
          <CardDescription>
            {repository.branches.length} local{' '}
            {repository.branches.length === 1 ? 'branch' : 'branches'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-wrap gap-2">
            {listedBranches.map((branch) => (
              <li key={branch}>
                <Badge variant={branch === project.defaultBaseBranch ? 'secondary' : 'outline'}>
                  <GitBranch aria-hidden="true" />
                  {branch}
                  {branch === project.defaultBaseBranch ? (
                    <span className="text-muted-foreground">(base)</span>
                  ) : null}
                </Badge>
              </li>
            ))}
          </ul>
          {repository.branches.length > listedBranches.length ? (
            <p className="mt-3 text-xs text-muted-foreground">
              and {repository.branches.length - listedBranches.length} more
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Remotes</h2>
          </CardTitle>
          <CardDescription>
            {repository.remotes.length === 0
              ? 'No remotes are configured.'
              : `${repository.remotes.length} configured`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {repository.remotes.map(({ name, fetchUrl }) => (
              <li key={name} className="space-y-1">
                <p className="flex items-center gap-2 font-medium">
                  <Globe className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {name}
                  {name === remote?.name ? <Badge variant="secondary">Project remote</Badge> : null}
                </p>
                <p className="font-mono text-xs break-all text-muted-foreground">
                  {fetchUrl ?? 'No URL configured'}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};

const ProjectPage = async ({ params }: { params: Promise<{ projectId: string }> }) => {
  await connection();
  const { projectId } = await params;
  const result = await loadForPage(() => getProjectDetails(getDatabase(), projectId));

  if (!result.ok) {
    return (
      <>
        <BackLink />
        <DatabaseNotReady message={result.message} />
      </>
    );
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project, repository } = result.data;
  const available = repository.status === 'available' ? repository : undefined;

  return (
    <>
      <section aria-labelledby="page-title" className="space-y-3">
        <BackLink />
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight break-words">
          {project.name}
        </h1>
        <p className="font-mono text-sm break-all text-muted-foreground">{project.localPath}</p>
      </section>

      <RepositoryProblem repository={repository} />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Repository</h2>
          </CardTitle>
          <CardDescription className="flex items-center gap-2">
            <Eye className="size-3.5" aria-hidden="true" />
            Read live from the repository each time this page loads. Nothing is changed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[11rem_1fr]">
            <Field label="Default base branch">
              <span className="flex flex-wrap items-center gap-2">
                {project.defaultBaseBranch}
                {available !== undefined && !available.baseBranchExists ? (
                  <Badge variant="destructive">Branch not found</Badge>
                ) : null}
              </span>
            </Field>
            <Field label="Remote">
              <span className="flex flex-wrap items-center gap-2">
                {project.remoteName ?? 'None'}
                {available !== undefined &&
                project.remoteName !== null &&
                !available.remoteExists ? (
                  <Badge variant="destructive">Remote not found</Badge>
                ) : null}
              </span>
            </Field>
            {available !== undefined ? (
              <>
                <Field label="Current HEAD">{describeHead(available.head)}</Field>
                <Field label="Working tree">
                  <Badge variant={available.workingTree.isClean ? 'secondary' : 'outline'}>
                    {describeWorkingTree(available.workingTree)}
                  </Badge>
                </Field>
              </>
            ) : null}
            <Field label="Git directory">
              <span className="font-mono text-xs break-all">{project.gitCommonDir}</span>
            </Field>
            <Field label="Added">{formatTimestamp(project.createdAt)}</Field>
          </dl>
        </CardContent>
      </Card>

      {available !== undefined ? (
        <RepositoryCards project={project} repository={available} />
      ) : null}
    </>
  );
};

export default ProjectPage;
