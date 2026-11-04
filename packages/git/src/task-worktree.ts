import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rmdir, stat } from 'node:fs/promises';
import type { BigIntStats, Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  GitCommandError,
  GitInputError,
  TaskWorktreeError,
  type TaskWorktreeRecoveryState,
} from './errors.js';
import { readFilterOverrides, runGit, runGitChecked, type RunGitOptions } from './process.js';
import { getHead, hasLocalBranch, resolveLocalBranch, type HeadState } from './refs.js';
import { validateRepository } from './repository.js';
import { parseAbsolutePath, parseBranchName, type GitCommandOptions } from './schemas.js';
import { getWorkingTreeStatus, listIgnoredPaths, type WorkingTreeStatus } from './status.js';
import { listWorktrees, type WorktreeEntry } from './worktree-list.js';

/** Stable identity of a repository: its main working tree and shared Git directory. */
export type RepositoryIdentity = {
  /** Canonical main working tree root. */
  root: string;
  /** Canonical common Git directory; identical for the main and all linked worktrees. */
  commonDir: string;
  /** Directory name under the worktree root: `<basename-slug>-<sha256(commonDir) prefix>`. */
  key: string;
};

export type TaskWorktree = {
  taskId: string;
  branch: string;
  /** Canonical worktree directory. */
  path: string;
  baseBranch: string;
  /** Full SHA of `baseBranch` at creation time; the task branch was created at this commit. */
  baseCommit: string;
  repository: RepositoryIdentity;
  /** Lock reason recorded in Git; marks the worktree as managed by AI Agent Manager. */
  lockReason: string;
};

export type CreateTaskWorktreeOptions = GitCommandOptions & {
  /** Main working tree of the repository. */
  repositoryPath: string;
  /** Existing local branch to start from. Remote state is not fetched. */
  baseBranch: string;
  /** Lowercase letters, digits, `-` and `_`; at most 64 characters. Used as the directory name. */
  taskId: string;
  /** Defaults to `agent/<taskId>`. Must not exist yet. */
  branchName?: string;
  /** Managed worktree root, such as `resolveRuntimePaths().worktreeRoot`. Created if missing. */
  worktreeRoot: string;
};

export type TaskWorktreeTarget = GitCommandOptions & {
  repositoryPath: string;
  worktreePath: string;
  branchName: string;
};

export type TaskWorktreeIssue =
  | 'path_is_symlink'
  | 'path_not_directory'
  /** A directory exists at the path but Git has not registered it as a worktree. */
  | 'not_registered'
  /** Git has the worktree registered but its directory is missing. */
  | 'path_missing'
  | 'registration_prunable'
  | 'main_worktree'
  | 'not_linked_worktree'
  | 'different_repository'
  | 'branch_missing'
  | 'branch_mismatch'
  | 'lock_missing'
  | 'lock_reason_mismatch';

export type TaskWorktreeInspection = {
  /**
   * - `ready`: registered linked worktree of this repository on the expected branch, with the
   *   AI Agent Manager lock marker.
   * - `absent`: no directory, registration, or branch.
   * - `branch_only`: the branch exists without a worktree (removed, or creation interrupted).
   * - `inconsistent`: anything else; see `issues`. Requires manual review.
   */
  state: 'ready' | 'absent' | 'branch_only' | 'inconsistent';
  issues: TaskWorktreeIssue[];
  repository: RepositoryIdentity;
  /** Canonical location checked (parent directories resolved, final component not followed). */
  path: string;
  branch: string;
  branchCommit: string | null;
  pathExists: boolean;
  registered: boolean;
  locked: boolean;
  lockReason: string | null;
  /** HEAD of the worktree, when it is a linked worktree of this repository. */
  head: HeadState | null;
  workingTree: WorkingTreeStatus | null;
};

export type RemoveTaskWorktreeOptions = TaskWorktreeTarget & {
  /**
   * `git worktree remove` deletes Git-ignored files (for example `.env` or build output) along with
   * a clean worktree. Removal is refused while any exist unless this is `true`.
   */
  allowIgnoredFiles?: boolean;
};

export type RemovedTaskWorktree = {
  path: string;
  branch: string;
  /** The task branch is preserved; this is the commit it points to. */
  branchCommit: string;
};

const branchRefPrefix = 'refs/heads/';
const defaultMutationTimeoutMs = 120_000;

const taskIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/** Additional config for mutating commands: no network transports, no submodule recursion. */
const mutationConfig: ReadonlyArray<readonly [string, string]> = [
  ['protocol.allow', 'never'],
  ['submodule.recurse', 'false'],
];

export const defaultTaskBranchName = (taskId: string): string => `agent/${parseTaskId(taskId)}`;

export const taskWorktreeLockReason = (branch: string): string =>
  `ai-agent-manager task worktree: ${branch}`;

const parseTaskId = (value: unknown): string => {
  if (!taskIdSchema.safeParse(value).success) {
    throw new GitInputError(
      'Task identifiers must be 1-64 lowercase letters, digits, "-" or "_", starting with a letter or digit.',
    );
  }
  return String(value);
};

/** True when `child` is `parent` itself or inside it. */
const isWithin = (parent: string, child: string): boolean => {
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
};

const lstatOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

/** Resolves symlinks in the parent directories but never follows the final path component. */
const canonicalLocation = async (path: string): Promise<string> => {
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch {
    return resolve(path);
  }
};

const assertOwnedDirectory = (stats: Stats, path: string): void => {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new TaskWorktreeError('UNSAFE_PATH', `${path} must be a directory, not a symlink.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new TaskWorktreeError('UNSAFE_PATH', `${path} is not owned by the current user.`);
  }
};

const repositoryKey = (root: string, commonDir: string): string => {
  const slug =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'repository';
  return `${slug}-${createHash('sha256').update(commonDir).digest('hex').slice(0, 12)}`;
};

/** Validates that `path` is the root of a repository's main working tree. */
const resolveRepository = async (
  path: string,
  options: GitCommandOptions,
): Promise<RepositoryIdentity> => {
  const validation = await validateRepository(parseAbsolutePath(path, 'Repository path'), options);
  if (!validation.valid) {
    throw new TaskWorktreeError('INVALID_REPOSITORY', validation.message);
  }
  const { root, commonDir, isLinkedWorktree } = validation.repository;
  if (isLinkedWorktree) {
    throw new TaskWorktreeError(
      'INVALID_REPOSITORY',
      'The repository path must be the main working tree, not a linked worktree.',
    );
  }
  return { root, commonDir, key: repositoryKey(root, commonDir) };
};

/** Validates a branch name with the local schema and with Git itself. */
const parseBranch = async (
  value: string,
  root: string,
  options: GitCommandOptions,
): Promise<string> => {
  const name = parseBranchName(value);
  const result = await runGit(['check-ref-format', `${branchRefPrefix}${name}`], {
    ...options,
    cwd: root,
  });
  if (result.exitCode !== 0) {
    throw new GitInputError(`Invalid branch name: ${JSON.stringify(value)}.`);
  }
  return name;
};

const mutationOptions = async (
  cwd: string,
  options: GitCommandOptions,
): Promise<RunGitOptions> => ({
  maxOutputBytes: options.maxOutputBytes,
  timeoutMs: options.timeoutMs ?? defaultMutationTimeoutMs,
  cwd,
  config: [...mutationConfig, ...(await readFilterOverrides(cwd, options))],
});

const observeRecoveryState = async (
  repository: RepositoryIdentity,
  branch: string,
  path: string,
  options: GitCommandOptions,
): Promise<TaskWorktreeRecoveryState> => {
  const [branchCommit, worktrees, stats] = await Promise.all([
    resolveLocalBranch(repository.root, branch, options),
    listWorktrees(repository.root, options),
    lstatOrNull(path),
  ]);
  return {
    branch,
    branchCommit,
    path,
    pathExists: stats !== null,
    registered: worktrees.some((entry) => entry.path === path),
  };
};

/** Identity of the destination directory this operation created; compared before any cleanup. */
export type DestinationClaim = { path: string; dev: bigint; ino: bigint; birthtimeNs: bigint };

const describeIdentity = (stats: BigIntStats) => ({
  dev: stats.dev,
  ino: stats.ino,
  birthtimeNs: stats.birthtimeNs,
});

/**
 * Atomically claims `path` by creating it with an exclusive, non-recursive `mkdir`. Any existing
 * entry (directory, file, or dangling symlink), including one created concurrently, makes the
 * claim fail with `DESTINATION_EXISTS`; it is never adopted. Git accepts the empty claimed
 * directory as the worktree destination.
 *
 * @internal Exported for tests only; not part of the public entry point.
 */
export const claimDestination = async (path: string): Promise<DestinationClaim> => {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new TaskWorktreeError('DESTINATION_EXISTS', `${path} already exists.`);
    }
    throw new TaskWorktreeError('CREATE_FAILED', `Could not create ${path}.`, { cause: error });
  }
  const claim = { path, ...describeIdentity(await lstat(path, { bigint: true })) };
  if ((await realpath(path)) !== path) {
    // A parent was swapped for a symlink after validation; release what we created and stop.
    await releaseClaim(claim);
    throw new TaskWorktreeError('UNSAFE_PATH', `${path} resolves elsewhere.`);
  }
  return claim;
};

type ClaimStatus = 'absent' | 'owned_empty' | 'owned_not_empty' | 'foreign';

const claimStatus = async (claim: DestinationClaim): Promise<ClaimStatus> => {
  let stats: BigIntStats;
  try {
    stats = await lstat(claim.path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 'absent';
    }
    throw error;
  }
  const identity = describeIdentity(stats);
  if (
    !stats.isDirectory() ||
    identity.dev !== claim.dev ||
    identity.ino !== claim.ino ||
    identity.birthtimeNs !== claim.birthtimeNs
  ) {
    return 'foreign';
  }
  return (await readdir(claim.path)).length === 0 ? 'owned_empty' : 'owned_not_empty';
};

/**
 * Removes the claimed directory only if it is still the directory we created and is empty, using a
 * non-recursive `rmdir`. Returns whether the claim is gone; anything else is left untouched.
 */
const releaseClaim = async (claim: DestinationClaim): Promise<boolean> => {
  const status = await claimStatus(claim);
  if (status === 'absent') {
    return true;
  }
  if (status !== 'owned_empty') {
    return false;
  }
  try {
    await rmdir(claim.path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Inspects the expected task worktree without modifying anything. Ownership is established from
 * Git's own records (worktree registration, common Git directory, checked-out branch, and the AI
 * Agent Manager lock marker), never from the directory name.
 */
export const inspectTaskWorktree = async ({
  repositoryPath,
  worktreePath,
  branchName,
  ...options
}: TaskWorktreeTarget): Promise<TaskWorktreeInspection> => {
  const repository = await resolveRepository(repositoryPath, options);
  const branch = await parseBranch(branchName, repository.root, options);
  const path = await canonicalLocation(parseAbsolutePath(worktreePath, 'Worktree path'));

  const [worktrees, branchCommit, stats] = await Promise.all([
    listWorktrees(repository.root, options),
    resolveLocalBranch(repository.root, branch, options),
    lstatOrNull(path),
  ]);
  const entryIndex = worktrees.findIndex((entry) => entry.path === path);
  const entry: WorktreeEntry | undefined = worktrees[entryIndex];
  const issues = new Set<TaskWorktreeIssue>();
  let head: HeadState | null = null;
  let workingTree: WorkingTreeStatus | null = null;

  if (entryIndex === 0 || path === repository.root) {
    issues.add('main_worktree');
  }
  if (entry !== undefined) {
    if (entry.prunable) issues.add('registration_prunable');
    if (stats === null) issues.add('path_missing');
    if (entry.branch !== `${branchRefPrefix}${branch}`) issues.add('branch_mismatch');
    if (!entry.locked) issues.add('lock_missing');
    else if (entry.lockReason !== taskWorktreeLockReason(branch)) {
      issues.add('lock_reason_mismatch');
    }
  } else if (stats !== null) {
    issues.add('not_registered');
  }

  if (stats?.isSymbolicLink()) {
    issues.add('path_is_symlink');
  } else if (stats !== null && !stats.isDirectory()) {
    issues.add('path_not_directory');
  } else if (stats !== null) {
    const validation = await validateRepository(path, options);
    if (!validation.valid || !validation.repository.isLinkedWorktree) {
      issues.add('not_linked_worktree');
    } else if (validation.repository.commonDir !== repository.commonDir) {
      issues.add('different_repository');
    } else {
      head = await getHead(path, options);
      if (head.kind !== 'branch' || head.branch !== branch) issues.add('branch_mismatch');
      workingTree = await getWorkingTreeStatus(path, options);
    }
  }

  const occupied = stats !== null || entry !== undefined;
  if (occupied && branchCommit === null) {
    issues.add('branch_missing');
  }

  let state: TaskWorktreeInspection['state'];
  if (!occupied) {
    state = branchCommit === null ? 'absent' : 'branch_only';
  } else {
    state = issues.size === 0 && head !== null ? 'ready' : 'inconsistent';
  }

  return {
    state,
    issues: [...issues],
    repository,
    path,
    branch,
    branchCommit,
    pathExists: stats !== null,
    registered: entry !== undefined,
    locked: entry?.locked ?? false,
    lockReason: entry?.lockReason ?? null,
    head,
    workingTree,
  };
};

/**
 * Creates `<worktreeRoot>/<repository key>/<taskId>` as a locked linked worktree on a new task
 * branch that starts at the current local commit of `baseBranch`. The main working tree's
 * branch, index, and files are not touched; nothing is fetched, committed, or pushed.
 *
 * The destination is claimed with an exclusive `mkdir` before any Git mutation, so a directory
 * that exists already or appears concurrently is never adopted.
 */
export const createTaskWorktree = async ({
  repositoryPath,
  baseBranch,
  taskId,
  branchName,
  worktreeRoot,
  ...options
}: CreateTaskWorktreeOptions): Promise<TaskWorktree> => {
  const id = parseTaskId(taskId);
  const requestedRoot = parseAbsolutePath(worktreeRoot, 'Worktree root');
  const repository = await resolveRepository(repositoryPath, options);
  const { root } = repository;
  const base = await parseBranch(baseBranch, root, options);
  const branch = await parseBranch(branchName ?? defaultTaskBranchName(id), root, options);
  if (branch === base) {
    throw new GitInputError('The task branch must differ from the base branch.');
  }

  const baseCommit = await resolveLocalBranch(root, base, options);
  if (baseCommit === null) {
    throw new TaskWorktreeError('BASE_BRANCH_NOT_FOUND', `Local branch "${base}" does not exist.`);
  }
  if (await hasLocalBranch(root, branch, options)) {
    throw new TaskWorktreeError('BRANCH_EXISTS', `Branch "${branch}" already exists.`);
  }

  const worktrees = await listWorktrees(root, options);
  const protectedPaths = [repository.commonDir, ...worktrees.map((entry) => entry.path)];

  if ((await lstatOrNull(requestedRoot)) === null) {
    await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  }
  const canonicalRoot = await realpath(requestedRoot);
  assertOwnedDirectory(await stat(canonicalRoot), canonicalRoot);
  if (protectedPaths.some((protectedPath) => isWithin(protectedPath, canonicalRoot))) {
    throw new TaskWorktreeError(
      'UNSAFE_PATH',
      'The worktree root must be outside the repository, its worktrees, and its Git directory.',
    );
  }

  // Shared by all tasks of this repository and possibly by concurrent operations: created if
  // missing (tolerating a concurrent creation), validated, and never removed here.
  const repositoryDirectory = join(canonicalRoot, repository.key);
  await mkdir(repositoryDirectory, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  });
  assertOwnedDirectory(await lstat(repositoryDirectory), repositoryDirectory);
  if ((await realpath(repositoryDirectory)) !== repositoryDirectory) {
    throw new TaskWorktreeError('UNSAFE_PATH', `${repositoryDirectory} resolves elsewhere.`);
  }

  const path = join(repositoryDirectory, id);
  if (worktrees.some((entry) => entry.path === path)) {
    throw new TaskWorktreeError('DESTINATION_EXISTS', `${path} is registered as a worktree.`);
  }
  if (protectedPaths.some((protectedPath) => isWithin(protectedPath, path))) {
    throw new TaskWorktreeError('UNSAFE_PATH', `${path} is inside the repository.`);
  }
  const claim = await claimDestination(path);

  const mutation = await mutationOptions(root, options);
  const branchRef = `${branchRefPrefix}${branch}`;

  // Create-only: an empty old value makes Git refuse if the ref appeared in the meantime.
  try {
    await runGitChecked(
      ['update-ref', '-m', `ai-agent-manager: create ${branch}`, branchRef, baseCommit, ''],
      mutation,
    );
  } catch (error) {
    const refused =
      error instanceof GitCommandError &&
      error.code === 'GIT_FAILED' &&
      error.stderr.includes('reference already exists');
    const recovery = await observeRecoveryState(repository, branch, path, options);
    // Either Git refused because another process owns the branch, or the branch does not exist:
    // in both cases this operation created no branch, and only its own claim is released.
    if (refused || recovery.branchCommit === null) {
      if (!(await releaseClaim(claim))) {
        throw new TaskWorktreeError(
          'RECOVERY_REQUIRED',
          `Creating branch "${branch}" failed and ${path} was changed by another process; it was preserved.`,
          { cause: error, recovery },
        );
      }
      throw refused
        ? new TaskWorktreeError('BRANCH_EXISTS', `Branch "${branch}" already exists.`, {
            cause: error,
          })
        : new TaskWorktreeError('CREATE_FAILED', `Creating branch "${branch}" failed.`, {
            cause: error,
          });
    }
    throw new TaskWorktreeError(
      'RECOVERY_REQUIRED',
      `Creating branch "${branch}" failed, but the branch now exists; it was preserved.`,
      { cause: error, recovery },
    );
  }

  const lockReason = taskWorktreeLockReason(branch);
  try {
    await runGitChecked(
      ['worktree', 'add', '--lock', '--reason', lockReason, '--', path, branch],
      mutation,
    );
  } catch (error) {
    await rollBackBranch(repository, branch, baseCommit, claim, error, options);
  }

  const [inspection, status] = await Promise.all([
    inspectTaskWorktree({
      ...options,
      repositoryPath: root,
      worktreePath: path,
      branchName: branch,
    }),
    claimStatus(claim),
  ]);
  if (
    status === 'absent' ||
    status === 'foreign' ||
    inspection.state !== 'ready' ||
    inspection.head?.commit !== baseCommit ||
    inspection.workingTree?.isClean !== true
  ) {
    throw new TaskWorktreeError(
      'RECOVERY_REQUIRED',
      status === 'foreign' || status === 'absent'
        ? 'The worktree directory is not the directory this operation claimed; it was preserved.'
        : 'The worktree was created but could not be verified; it was preserved.',
      {
        recovery: await observeRecoveryState(repository, branch, path, options),
        inspection,
      },
    );
  }

  return { taskId: id, branch, path, baseBranch: base, baseCommit, repository, lockReason };
};

/**
 * After `worktree add` failed, releases this operation's claim and deletes the task branch only if
 * both are definitely owned by it and nothing else references them; otherwise preserves
 * everything. Always throws.
 *
 * @internal Exported for tests only; not part of the public entry point.
 */
export const rollBackBranch = async (
  repository: RepositoryIdentity,
  branch: string,
  baseCommit: string,
  claim: DestinationClaim,
  cause: unknown,
  options: GitCommandOptions,
): Promise<never> => {
  const { path } = claim;
  try {
    const [recovery, worktrees, status] = await Promise.all([
      observeRecoveryState(repository, branch, path, options),
      listWorktrees(repository.root, options),
      claimStatus(claim),
    ]);
    const checkedOut = worktrees.some((entry) => entry.branch === `${branchRefPrefix}${branch}`);
    // Git removes the destination on failure. If it is still there, it must be our empty claim.
    const destinationReleasable = status === 'absent' || status === 'owned_empty';
    if (
      !destinationReleasable ||
      recovery.registered ||
      checkedOut ||
      recovery.branchCommit !== baseCommit
    ) {
      throw new TaskWorktreeError(
        'RECOVERY_REQUIRED',
        'Creating the worktree failed and left resources that could not be safely rolled back; they were preserved.',
        { cause, recovery },
      );
    }
    if (!(await releaseClaim(claim))) {
      throw new TaskWorktreeError(
        'RECOVERY_REQUIRED',
        'Creating the worktree failed and its directory changed during rollback; resources were preserved.',
        { cause, recovery: await observeRecoveryState(repository, branch, path, options) },
      );
    }
    // Compare-and-delete: only removes the ref if it still points at the commit we created it at.
    await runGitChecked(
      ['update-ref', '-d', `${branchRefPrefix}${branch}`, baseCommit],
      await mutationOptions(repository.root, options),
    );
  } catch (error) {
    if (error instanceof TaskWorktreeError) {
      throw error;
    }
    throw new TaskWorktreeError(
      'RECOVERY_REQUIRED',
      'Creating the worktree failed and rollback could not be completed; resources were preserved.',
      {
        cause: error instanceof GitCommandError ? error : cause,
        recovery: await observeRecoveryState(repository, branch, path, options).catch(
          () => undefined,
        ),
      },
    );
  }
  throw new TaskWorktreeError(
    'CREATE_FAILED',
    'Creating the worktree failed; the directory and task branch created for it were rolled back.',
    { cause },
  );
};

/**
 * Removes a verified, clean task worktree with a non-forced `git worktree remove`. The task branch
 * is always preserved. Never cleans, resets, or recursively deletes files itself.
 */
export const removeTaskWorktree = async ({
  allowIgnoredFiles = false,
  ...target
}: RemoveTaskWorktreeOptions): Promise<RemovedTaskWorktree> => {
  const options: GitCommandOptions = {
    timeoutMs: target.timeoutMs,
    maxOutputBytes: target.maxOutputBytes,
  };
  const inspection = await inspectTaskWorktree(target);
  if (inspection.state !== 'ready' || inspection.workingTree === null) {
    throw new TaskWorktreeError(
      'NOT_VERIFIED',
      `The worktree could not be verified as an AI Agent Manager task worktree (${inspection.state}${
        inspection.issues.length > 0 ? `: ${inspection.issues.join(', ')}` : ''
      }).`,
      { inspection },
    );
  }
  if (!inspection.workingTree.isClean) {
    throw new TaskWorktreeError(
      'WORKTREE_DIRTY',
      'The worktree has uncommitted or untracked changes; it was preserved.',
      { inspection },
    );
  }
  if (!allowIgnoredFiles && (await listIgnoredPaths(inspection.path, options)).length > 0) {
    throw new TaskWorktreeError(
      'WORKTREE_DIRTY',
      'The worktree contains Git-ignored files that removal would delete; it was preserved.',
      { inspection },
    );
  }

  const { path, branch, repository } = inspection;
  const mutation = await mutationOptions(repository.root, options);
  try {
    await runGitChecked(['worktree', 'unlock', '--', path], mutation);
  } catch (error) {
    throw new TaskWorktreeError(
      'REMOVE_FAILED',
      'Could not unlock the worktree; it was preserved.',
      {
        cause: error,
      },
    );
  }
  try {
    // Not forced: Git re-checks that the worktree is clean and refuses otherwise.
    await runGitChecked(['worktree', 'remove', '--', path], mutation);
  } catch (error) {
    const relock = await runGit(
      ['worktree', 'lock', '--reason', taskWorktreeLockReason(branch), '--', path],
      mutation,
    ).catch(() => undefined);
    throw new TaskWorktreeError(
      'REMOVE_FAILED',
      `Git did not remove the worktree; it was preserved${
        relock?.exitCode === 0 ? ' and locked again' : ''
      }.`,
      { cause: error },
    );
  }

  const branchCommit = await resolveLocalBranch(repository.root, branch, options);
  if (branchCommit === null) {
    throw new TaskWorktreeError(
      'RECOVERY_REQUIRED',
      `The worktree was removed, but branch "${branch}" is missing.`,
    );
  }
  return { path, branch, branchCommit };
};
