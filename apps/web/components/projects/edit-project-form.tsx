'use client';

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Info, Loader2, ShieldCheck } from 'lucide-react';
import { z } from 'zod';
import {
  projectInstructionsMaxLength,
  projectNameMaxLength,
  projectPriorityDefault,
  projectPriorityMax,
  projectPriorityMin,
  type Project,
} from '@ai-agent-manager/core';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { requestJson, type ClientError } from '@/lib/projects/api-client';
import { projectResponseSchema, type RepositoryState } from '@/lib/projects/contracts';
import { savedProjectUrl } from '@/lib/projects/feedback';
import {
  buildProjectUpdate,
  noRemote,
  settingsValuesFromProject,
  type ProjectSettingsField,
  type ProjectSettingsValues,
} from '@/lib/projects/settings';

type FieldErrors = Partial<Record<ProjectSettingsField, string>>;

const invalidRequestDetailsSchema = z.object({ fields: z.record(z.string(), z.string()) });

const settingsFields = new Set<string>([
  'name',
  'priority',
  'instructions',
  'defaultBaseBranch',
  'remoteName',
]);

const isSettingsField = (key: string): key is ProjectSettingsField => settingsFields.has(key);

/** Moves server-side validation errors next to the field they belong to, where possible. */
const fieldErrorsFromServer = (error: ClientError): FieldErrors | undefined => {
  if (error.code === 'base_branch_not_found') {
    return { defaultBaseBranch: error.message };
  }
  if (error.code === 'remote_not_found') {
    return { remoteName: error.message };
  }
  const details = invalidRequestDetailsSchema.safeParse(error.details);
  if (error.code !== 'invalid_request' || !details.success) {
    return undefined;
  }
  const entries = Object.entries(details.data.fields).filter(([key]) => isSettingsField(key));
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

type Option = { value: string; label: string };

/** Lists the live values and keeps the stored one selectable even when it no longer exists. */
const withStoredOption = (live: readonly string[], stored: string | null): Option[] => {
  const options = live.map((value) => ({ value, label: value }));
  return stored === null || live.includes(stored)
    ? options
    : [{ value: stored, label: `${stored} (not found)` }, ...options];
};

type AvailableRepository = Extract<RepositoryState, { status: 'available' }>;

const remoteHint = (
  remoteName: string,
  repository: AvailableRepository | undefined,
  selected: AvailableRepository['remotes'][number] | undefined,
): string => {
  if (remoteName === noRemote) {
    return 'Task branches will not have a push destination yet.';
  }
  if (repository === undefined) {
    return 'Remote details are unavailable.';
  }
  if (selected === undefined) {
    return 'This remote is no longer configured in the repository.';
  }
  return selected.fetchUrl ?? 'No URL configured.';
};

const FieldError = ({ id, message }: { id: string; message: string | undefined }) =>
  message === undefined ? null : (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );

type EditProjectFormProps = {
  project: Project;
  repository: RepositoryState;
};

export const EditProjectForm = ({ project, repository }: EditProjectFormProps) => {
  const router = useRouter();
  const fieldId = useId();
  const initial = settingsValuesFromProject(project);
  const [values, setValues] = useState<ProjectSettingsValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<ClientError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const available = repository.status === 'available' ? repository : undefined;
  const branchOptions = withStoredOption(available?.branches ?? [], project.defaultBaseBranch);
  const remoteOptions = withStoredOption(
    available?.remotes.map(({ name }) => name) ?? [],
    project.remoteName,
  );
  const selectedRemote = available?.remotes.find(({ name }) => name === values.remoteName);
  const isDirty = (Object.keys(initial) as ProjectSettingsField[]).some(
    (key) => values[key] !== initial[key],
  );

  const setValue = (field: ProjectSettingsField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setNotice(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const result = buildProjectUpdate(project, values);
    if (!result.ok) {
      setFieldErrors(result.fields);
      return;
    }
    setFieldErrors({});
    if (result.update === null) {
      setNotice('There are no changes to save.');
      return;
    }

    setPending(true);
    const response = await requestJson(
      'PATCH',
      `/api/projects/${project.id}`,
      projectResponseSchema,
      result.update,
    );
    if (!response.ok) {
      setPending(false);
      const fromServer = fieldErrorsFromServer(response.error);
      if (fromServer === undefined) {
        setError(response.error);
      } else {
        setFieldErrors(fromServer);
      }
      return;
    }
    router.push(savedProjectUrl(project.id));
    router.refresh();
  };

  const describedBy = (field: ProjectSettingsField, hint?: string) =>
    [hint, fieldErrors[field] === undefined ? undefined : `${fieldId}-${field}-error`]
      .filter((value) => value !== undefined)
      .join(' ') || undefined;

  return (
    <Card>
      <form onSubmit={handleSubmit} className="contents" noValidate>
        <CardHeader>
          <CardTitle>
            <h2>Project settings</h2>
          </CardTitle>
          <CardDescription>
            The repository location cannot be changed. To use a repository at a different path,
            disconnect this project and add the repository again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${fieldId}-name`}>Project name</Label>
              <Input
                id={`${fieldId}-name`}
                name="name"
                value={values.name}
                onChange={(event) => setValue('name', event.target.value)}
                maxLength={projectNameMaxLength}
                required
                aria-invalid={fieldErrors.name !== undefined}
                aria-describedby={describedBy('name')}
              />
              <FieldError id={`${fieldId}-name-error`} message={fieldErrors.name} />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-priority`}>Priority</Label>
              <Input
                id={`${fieldId}-priority`}
                name="priority"
                type="number"
                inputMode="numeric"
                step={1}
                min={projectPriorityMin}
                max={projectPriorityMax}
                value={values.priority}
                onChange={(event) => setValue('priority', event.target.value)}
                required
                aria-invalid={fieldErrors.priority !== undefined}
                aria-describedby={describedBy('priority', `${fieldId}-priority-hint`)}
              />
              <p id={`${fieldId}-priority-hint`} className="text-xs text-muted-foreground">
                Lower numbers are scheduled first ({projectPriorityMin} to {projectPriorityMax};
                default {projectPriorityDefault}).
              </p>
              <FieldError id={`${fieldId}-priority-error`} message={fieldErrors.priority} />
            </div>

            <div className="hidden sm:block" aria-hidden="true" />

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-branch`}>Default base branch</Label>
              <NativeSelect
                id={`${fieldId}-branch`}
                name="defaultBaseBranch"
                value={values.defaultBaseBranch}
                onChange={(event) => setValue('defaultBaseBranch', event.target.value)}
                disabled={available === undefined}
                required
                aria-invalid={fieldErrors.defaultBaseBranch !== undefined}
                aria-describedby={describedBy('defaultBaseBranch', `${fieldId}-branch-hint`)}
              >
                {branchOptions.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
              <p id={`${fieldId}-branch-hint`} className="text-xs text-muted-foreground">
                New tasks start from this branch unless they choose another.
              </p>
              <FieldError
                id={`${fieldId}-defaultBaseBranch-error`}
                message={fieldErrors.defaultBaseBranch}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-remote`}>Remote</Label>
              <NativeSelect
                id={`${fieldId}-remote`}
                name="remoteName"
                value={values.remoteName}
                onChange={(event) => setValue('remoteName', event.target.value)}
                disabled={available === undefined}
                aria-invalid={fieldErrors.remoteName !== undefined}
                aria-describedby={describedBy('remoteName', `${fieldId}-remote-hint`)}
              >
                {remoteOptions.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
                <option value={noRemote}>No remote</option>
              </NativeSelect>
              <p id={`${fieldId}-remote-hint`} className="text-xs break-all text-muted-foreground">
                {remoteHint(values.remoteName, available, selectedRemote)}
              </p>
              <FieldError id={`${fieldId}-remoteName-error`} message={fieldErrors.remoteName} />
            </div>

            {available === undefined ? (
              <Alert variant="warning" className="sm:col-span-2">
                <Info aria-hidden="true" />
                <AlertTitle>Base branch and remote are locked</AlertTitle>
                <AlertDescription>
                  <p>
                    The repository cannot be read at its registered path, so its branches and
                    remotes cannot be checked. Name, priority and instructions can still be edited.
                  </p>
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${fieldId}-instructions`}>Project instructions</Label>
              <Textarea
                id={`${fieldId}-instructions`}
                name="instructions"
                value={values.instructions}
                onChange={(event) => setValue('instructions', event.target.value)}
                maxLength={projectInstructionsMaxLength}
                rows={8}
                placeholder="For example: Use pnpm. Run the unit tests before finishing."
                aria-invalid={fieldErrors.instructions !== undefined}
                aria-describedby={describedBy('instructions', `${fieldId}-instructions-hint`)}
              />
              <p id={`${fieldId}-instructions-hint`} className="text-xs text-muted-foreground">
                Given to agents for every task in this project, in addition to global instructions
                and the repository’s own instruction files (which are never changed).{' '}
                {values.instructions.length.toLocaleString('en')} /{' '}
                {projectInstructionsMaxLength.toLocaleString('en')} characters.
              </p>
              <FieldError id={`${fieldId}-instructions-error`} message={fieldErrors.instructions} />
            </div>
          </div>

          {error !== null ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>The settings were not saved</AlertTitle>
              <AlertDescription>
                <p>{error.message}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          {notice !== null ? (
            <Alert>
              <Info aria-hidden="true" />
              <AlertDescription>
                <p>{notice}</p>
              </AlertDescription>
            </Alert>
          ) : null}

          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Settings are stored in AI Agent Manager only. Saving reads the repository to check the
            branch and remote, and never changes its files, branches, remotes, or Git configuration.
          </p>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button asChild variant="ghost">
            <Link href={`/projects/${project.id}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={pending || !isDirty}>
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
};
