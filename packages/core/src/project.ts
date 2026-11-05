import { z } from 'zod';

export const projectIdSchema = z.uuid();

export type ProjectId = z.infer<typeof projectIdSchema>;

export const projectNameMaxLength = 100;

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a project name.')
  .max(projectNameMaxLength, `Use at most ${projectNameMaxLength} characters.`);

/**
 * A filesystem path typed by the user. It is only a request: the server canonicalizes and
 * validates it, and later operations use the stored canonical path, never this input.
 */
export const repositoryPathInputSchema = z
  .string()
  .trim()
  .min(1, 'Enter the path to a local Git repository.')
  .max(4096, 'The path is too long.')
  .refine((value) => !value.includes('\0'), { message: 'The path must not contain null bytes.' });

/** Shape check only; the branch must also exist in the repository when it is registered. */
export const projectBranchNameSchema = z.string().trim().min(1, 'Select a base branch.').max(255);

/** Shape check only; the remote must also exist in the repository when it is registered. */
export const projectRemoteNameSchema = z.string().trim().min(1).max(255);

export const previewProjectRequestSchema = z.strictObject({ path: repositoryPathInputSchema });

export type PreviewProjectRequest = z.infer<typeof previewProjectRequestSchema>;

export const registerProjectRequestSchema = z.strictObject({
  path: repositoryPathInputSchema,
  name: projectNameSchema,
  defaultBaseBranch: projectBranchNameSchema,
  /** `null` registers the project without a remote. */
  remoteName: projectRemoteNameSchema.nullable(),
});

export type RegisterProjectRequest = z.infer<typeof registerProjectRequestSchema>;

/** A registered project. Timestamps are Unix milliseconds. */
export const projectSchema = z.object({
  id: projectIdSchema,
  name: z.string(),
  /** Canonical absolute path of the repository's main working tree. */
  localPath: z.string(),
  /** Canonical common Git directory: the repository identity used to detect duplicates. */
  gitCommonDir: z.string(),
  remoteName: z.string().nullable(),
  defaultBaseBranch: z.string(),
  priority: z.number().int(),
  instructions: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export type Project = z.infer<typeof projectSchema>;

/** Expected reasons a repository cannot be previewed or registered as a project. */
export const projectRegistrationErrorCodes = [
  'invalid_path',
  'path_not_found',
  'path_not_accessible',
  'not_a_directory',
  'not_git_repository',
  'bare_repository',
  'inside_git_directory',
  'not_repository_root',
  'linked_worktree',
  'unsafe_ownership',
  'no_local_branches',
  'base_branch_not_found',
  'remote_not_found',
  'project_already_registered',
] as const;

export const projectRegistrationErrorCodeSchema = z.enum(projectRegistrationErrorCodes);

export type ProjectRegistrationErrorCode = z.infer<typeof projectRegistrationErrorCodeSchema>;
