import {
  projectBranchNameSchema,
  projectInstructionsSchema,
  projectNameSchema,
  projectPrioritySchema,
  type Project,
  type UpdateProjectRequest,
} from '@ai-agent-manager/core';

// Form state for the project settings editor. Kept free of React so it can be tested directly.

/** Value of the remote select that means "no remote". */
export const noRemote = '';

export type ProjectSettingsValues = {
  name: string;
  /** Raw text of the number input. */
  priority: string;
  instructions: string;
  defaultBaseBranch: string;
  /** A remote name, or `noRemote`. */
  remoteName: string;
};

export type ProjectSettingsField = keyof ProjectSettingsValues;

export type ProjectSettingsProject = Pick<
  Project,
  'name' | 'priority' | 'instructions' | 'defaultBaseBranch' | 'remoteName'
>;

export const settingsValuesFromProject = (
  project: ProjectSettingsProject,
): ProjectSettingsValues => ({
  name: project.name,
  priority: String(project.priority),
  instructions: project.instructions,
  defaultBaseBranch: project.defaultBaseBranch,
  remoteName: project.remoteName ?? noRemote,
});

export type ProjectUpdateResult =
  | { ok: true; update: UpdateProjectRequest | null }
  | { ok: false; fields: Partial<Record<ProjectSettingsField, string>> };

const parsePriority = (input: string): unknown => {
  const trimmed = input.trim();
  // `Number('')` is 0; an empty field must be reported instead.
  return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
};

/**
 * Validates the form values with the shared schemas and returns only the settings that differ from
 * `project` (`update: null` when nothing changed). The server validates again; this only gives
 * immediate feedback and keeps unchanged settings out of the request.
 */
export const buildProjectUpdate = (
  project: ProjectSettingsProject,
  values: ProjectSettingsValues,
): ProjectUpdateResult => {
  const fields: Partial<Record<ProjectSettingsField, string>> = {};
  const name = projectNameSchema.safeParse(values.name);
  const priority = projectPrioritySchema.safeParse(parsePriority(values.priority));
  const instructions = projectInstructionsSchema.safeParse(values.instructions);
  const branch = projectBranchNameSchema.safeParse(values.defaultBaseBranch);

  if (!name.success) {
    fields.name = name.error.issues[0]?.message;
  }
  if (!priority.success) {
    fields.priority = priority.error.issues[0]?.message;
  }
  if (!instructions.success) {
    fields.instructions = instructions.error.issues[0]?.message;
  }
  if (!branch.success) {
    fields.defaultBaseBranch = branch.error.issues[0]?.message;
  }
  if (!name.success || !priority.success || !instructions.success || !branch.success) {
    return { ok: false, fields };
  }

  const remoteName = values.remoteName === noRemote ? null : values.remoteName;
  const update: UpdateProjectRequest = {
    ...(name.data === project.name ? {} : { name: name.data }),
    ...(priority.data === project.priority ? {} : { priority: priority.data }),
    ...(instructions.data === project.instructions ? {} : { instructions: instructions.data }),
    ...(branch.data === project.defaultBaseBranch ? {} : { defaultBaseBranch: branch.data }),
    ...(remoteName === project.remoteName ? {} : { remoteName }),
  };
  return { ok: true, update: Object.keys(update).length === 0 ? null : update };
};
