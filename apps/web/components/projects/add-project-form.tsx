'use client';

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, FolderSearch, Info, Loader2, ShieldCheck } from 'lucide-react';
import { z } from 'zod';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { postJson, type ClientError } from '@/lib/projects/api-client';
import {
  projectResponseSchema,
  repositoryPreviewResponseSchema,
  type RepositoryPreview,
} from '@/lib/projects/contracts';
import { describeHead, describeWorkingTree } from '@/lib/projects/format';

const repositoryRootDetailsSchema = z.object({ root: z.string() });
const existingProjectDetailsSchema = z.object({ projectId: z.string(), projectName: z.string() });

/** Value of the remote select that registers the project without a remote. */
const noRemote = '';

const ErrorAlert = ({
  error,
  onUseRoot,
}: {
  error: ClientError;
  onUseRoot: (root: string) => void;
}) => {
  const root = repositoryRootDetailsSchema.safeParse(error.details);
  const existing = existingProjectDetailsSchema.safeParse(error.details);
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>The repository could not be added</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {error.code === 'not_repository_root' && root.success ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all text-foreground">
              {root.data.root}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onUseRoot(root.data.root)}
            >
              Use repository root
            </Button>
          </div>
        ) : null}
        {error.code === 'project_already_registered' && existing.success ? (
          <Link
            href={`/projects/${existing.data.projectId}`}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Open {existing.data.projectName}
          </Link>
        ) : null}
      </AlertDescription>
    </Alert>
  );
};

const ReadOnlyNote = () => (
  <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
    <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
    Adding a project only reads the repository. Files, branches, remotes, and Git configuration are
    not changed.
  </p>
);

export const AddProjectForm = () => {
  const router = useRouter();
  const fieldId = useId();
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<RepositoryPreview | null>(null);
  const [name, setName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [remoteName, setRemoteName] = useState(noRemote);
  const [error, setError] = useState<ClientError | null>(null);
  const [pending, setPending] = useState<'inspect' | 'register' | null>(null);

  const inspect = async (target: string): Promise<void> => {
    setPending('inspect');
    setError(null);
    const result = await postJson(
      '/api/projects/preview',
      { path: target },
      repositoryPreviewResponseSchema,
    );
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const { preview: next } = result.data;
    setPreview(next);
    setName(next.suggestedName);
    setBaseBranch(next.suggestedBaseBranch);
    setRemoteName(next.suggestedRemoteName ?? noRemote);
  };

  const handleInspect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void inspect(path);
  };

  const handleUseRoot = (root: string) => {
    setPath(root);
    void inspect(root);
  };

  const handleRegister = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (preview === null) {
      return;
    }
    setPending('register');
    setError(null);
    const result = await postJson(
      '/api/projects',
      {
        // Registration re-validates the canonical path on the server.
        path: preview.path,
        name,
        defaultBaseBranch: baseBranch,
        remoteName: remoteName === noRemote ? null : remoteName,
      },
      projectResponseSchema,
    );
    if (!result.ok) {
      setPending(null);
      setError(result.error);
      return;
    }
    router.push(`/projects/${result.data.project.id}`);
    router.refresh();
  };

  const handleChangePath = () => {
    setPreview(null);
    setError(null);
  };

  if (preview === null) {
    return (
      <Card>
        <form onSubmit={handleInspect} className="contents" noValidate>
          <CardHeader>
            <CardTitle>
              <h2>Repository location</h2>
            </CardTitle>
            <CardDescription>
              Enter the folder of an existing local Git repository. It can be anywhere on this
              computer.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-path`}>Repository path</Label>
              <Input
                id={`${fieldId}-path`}
                name="path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="~/repos/my-project"
                autoComplete="off"
                spellCheck={false}
                required
                aria-invalid={error !== null}
                aria-describedby={`${fieldId}-path-hint`}
                className="font-mono"
              />
              <p id={`${fieldId}-path-hint`} className="text-xs text-muted-foreground">
                Use an absolute path or one starting with ~/. Use the repository’s root folder.
              </p>
            </div>
            {error !== null ? <ErrorAlert error={error} onUseRoot={handleUseRoot} /> : null}
            <ReadOnlyNote />
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button asChild variant="ghost">
              <Link href="/projects">Cancel</Link>
            </Button>
            <Button type="submit" disabled={pending !== null || path.trim() === ''}>
              {pending === 'inspect' ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <FolderSearch aria-hidden="true" />
              )}
              {pending === 'inspect' ? 'Checking…' : 'Check repository'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    );
  }

  const selectedRemote = preview.remotes.find((remote) => remote.name === remoteName);

  return (
    <Card>
      <form onSubmit={handleRegister} className="contents">
        <CardHeader>
          <CardTitle>
            <h2>Review repository</h2>
          </CardTitle>
          <CardDescription>Confirm the details below to add this project.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <dl className="grid gap-x-6 gap-y-3 rounded-lg border bg-inset p-4 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Repository root</dt>
            <dd className="font-mono text-xs break-all">{preview.path}</dd>
            <dt className="text-muted-foreground">Current HEAD</dt>
            <dd>{describeHead(preview.head)}</dd>
            <dt className="text-muted-foreground">Working tree</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <Badge variant={preview.workingTree.isClean ? 'secondary' : 'outline'}>
                {describeWorkingTree(preview.workingTree)}
              </Badge>
            </dd>
          </dl>

          {preview.existingProject !== null ? (
            <Alert>
              <Info aria-hidden="true" />
              <AlertTitle>Already registered</AlertTitle>
              <AlertDescription>
                <p>This repository is already registered as “{preview.existingProject.name}”.</p>
                <Link
                  href={`/projects/${preview.existingProject.id}`}
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  Open project
                </Link>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor={`${fieldId}-name`}>Project name</Label>
                <Input
                  id={`${fieldId}-name`}
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={100}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-branch`}>Default base branch</Label>
                <NativeSelect
                  id={`${fieldId}-branch`}
                  name="defaultBaseBranch"
                  value={baseBranch}
                  onChange={(event) => setBaseBranch(event.target.value)}
                  required
                >
                  {preview.branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </NativeSelect>
                <p className="text-xs text-muted-foreground">
                  New tasks start from this branch unless they choose another.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-remote`}>Remote</Label>
                <NativeSelect
                  id={`${fieldId}-remote`}
                  name="remoteName"
                  value={remoteName}
                  onChange={(event) => setRemoteName(event.target.value)}
                >
                  {preview.remotes.map((remote) => (
                    <option key={remote.name} value={remote.name}>
                      {remote.name}
                    </option>
                  ))}
                  <option value={noRemote}>No remote</option>
                </NativeSelect>
                <p className="text-xs break-all text-muted-foreground">
                  {selectedRemote === undefined
                    ? preview.remotes.length === 0
                      ? 'No remotes are configured in this repository.'
                      : 'Task branches will not have a push destination yet.'
                    : (selectedRemote.fetchUrl ?? 'No URL configured.')}
                </p>
              </div>
            </div>
          )}

          {error !== null ? <ErrorAlert error={error} onUseRoot={handleUseRoot} /> : null}
          <ReadOnlyNote />
        </CardContent>
        <CardFooter className="justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={handleChangePath}
            disabled={pending !== null}
          >
            <ArrowLeft aria-hidden="true" />
            Choose another path
          </Button>
          {preview.existingProject === null ? (
            <Button type="submit" disabled={pending !== null || name.trim() === ''}>
              {pending === 'register' ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : null}
              {pending === 'register' ? 'Adding…' : 'Add project'}
            </Button>
          ) : null}
        </CardFooter>
      </form>
    </Card>
  );
};
