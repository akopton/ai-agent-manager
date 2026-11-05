import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  createTaskWorktree,
  inspectTaskChanges,
  inspectTaskWorktree,
  listRemotes,
} from '@ai-agent-manager/git';
import { runFixtureGitChecked } from '../fixture-git.js';
import {
  createOwnedDirectory,
  identityOf,
  verifyOwnedDirectory,
  type DirectoryIdentity,
} from '../owned-directory.js';
import {
  defaultProtectedRoots,
  isWithin,
  validateExplicitParent,
  type ProtectedRoot,
} from '../paths.js';

// SEC-02e compatibility fixture. Unlike the diagnostics fixture it contains no probe helper,
// credential canary or `outside/` directory: only a synthetic repository, a local bare remote and
// two task worktrees. It has its own prefixes and marker, so neither harness accepts the other's
// directories.

export const smokeHarnessName = 'ai-agent-manager-smoke';
export const smokeMarkerName = '.aam-smoke-fixture.json';
export const smokeManifestFileName = 'smoke-manifest.json';
export const smokeFixturePrefix = 'ai-agent-manager-smoke-fixture-';
export const smokeResultsPrefix = 'ai-agent-manager-smoke-results-';
/** Created in the results directory when a run is approved; a fixture is used at most once. */
export const smokeClaimFileName = 'run-claim.json';
/** Recovery record written when the CLI process started: its PID and process group. */
export const smokeProcessFileName = 'run-process.json';

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && !value.includes('\0'), 'must be an absolute path');
const identitySchema = z.object({ dev: z.number(), ino: z.number() }).strict();
const taskSchema = z
  .object({ taskId: z.string().regex(/^[a-z0-9-]+$/), branch: z.string().min(1) })
  .strict();

export const smokeManifestSchema = z
  .object({
    harness: z.literal(smokeHarnessName),
    schemaVersion: z.literal(1),
    profile: z.literal('compatibility'),
    fixtureId: z.string().regex(/^[0-9a-f]{32}$/),
    createdAt: z.iso.datetime(),
    parentDirectory: absolutePath,
    rootIdentity: identitySchema,
    resultsDirectory: absolutePath,
    resultsIdentity: identitySchema,
    paths: z
      .object({
        root: absolutePath,
        remote: absolutePath,
        repository: absolutePath,
        worktreeRoot: absolutePath,
        assignedWorktree: absolutePath,
        otherWorktree: absolutePath,
      })
      .strict(),
    remoteIdentity: identitySchema,
    repository: z
      .object({
        root: absolutePath,
        commonDir: absolutePath,
        rootIdentity: identitySchema,
        commonDirIdentity: identitySchema,
      })
      .strict(),
    baseBranch: z.literal('main'),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    assignedTask: taskSchema,
    otherTask: taskSchema,
  })
  .strict();

export type SmokeManifest = z.infer<typeof smokeManifestSchema>;

/** Raised when a smoke fixture cannot be created, verified or removed safely. */
export class SmokeFixtureError extends Error {
  override name = 'SmokeFixtureError';
  constructor(
    message: string,
    readonly reasons: readonly string[] = [message],
  ) {
    super(message);
  }
}

export type SmokeFixtureOptions = {
  /** Overrides the protected roots (tests only); defaults to the real application roots. */
  protectedRoots?: readonly ProtectedRoot[];
};

const marker = (fixtureId: string) => ({
  fileName: smokeMarkerName,
  harness: smokeHarnessName,
  fixtureId,
});

const sameIdentity = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

/**
 * Creates a fresh compatibility fixture under an explicit, validated parent:
 *
 * ```text
 * <parent>/ai-agent-manager-smoke-fixture-XXXX/
 *   .aam-smoke-fixture.json       ownership marker
 *   origin.git/                   local bare remote (main pushed)
 *   repository/                   main checkout, synthetic README.md and src/index.ts
 *   worktrees/<key>/task-smoke/   assigned task worktree (createTaskWorktree)
 *   worktrees/<key>/task-other/   another task worktree
 * <parent>/ai-agent-manager-smoke-results-XXXX/
 *   smoke-manifest.json           creation record (0600); reports are written here
 * ```
 */
export const createSmokeFixture = async (
  parent: string,
  options: SmokeFixtureOptions = {},
): Promise<{ manifest: SmokeManifest; manifestPath: string }> => {
  const protectedRoots = options.protectedRoots ?? (await defaultProtectedRoots());
  const parentDirectory = await validateExplicitParent(parent, protectedRoots);
  const fixtureId = randomBytes(16).toString('hex');
  const markerText = `${JSON.stringify({ harness: smokeHarnessName, fixtureId })}\n`;
  const root = await createOwnedDirectory(parentDirectory, smokeFixturePrefix, protectedRoots);
  // The marker is written first, so cleanup can prove ownership even if setup fails later.
  await writeFile(join(root, smokeMarkerName), markerText, { flag: 'wx', mode: 0o600 });
  const resultsDirectory = await createOwnedDirectory(
    parentDirectory,
    smokeResultsPrefix,
    protectedRoots,
  );
  await writeFile(join(resultsDirectory, smokeMarkerName), markerText, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    const remote = join(root, 'origin.git');
    await mkdir(remote, { mode: 0o700 });
    await runFixtureGitChecked(root, remote, [
      'init',
      '--quiet',
      '--bare',
      '--initial-branch=main',
    ]);
    const repository = join(root, 'repository');
    await mkdir(join(repository, 'src'), { recursive: true, mode: 0o700 });
    await runFixtureGitChecked(root, repository, ['init', '--quiet', '--initial-branch=main']);
    await writeFile(join(repository, 'README.md'), '# Smoke fixture\n\nSynthetic content.\n', {
      flag: 'wx',
    });
    await writeFile(join(repository, 'src', 'index.ts'), 'export const answer = 42;\n', {
      flag: 'wx',
    });
    await runFixtureGitChecked(root, repository, ['add', 'README.md', 'src/index.ts']);
    await runFixtureGitChecked(root, repository, ['commit', '--quiet', '-m', 'Smoke base commit']);
    await runFixtureGitChecked(root, repository, ['remote', 'add', 'origin', remote]);
    await runFixtureGitChecked(root, repository, ['push', '--quiet', 'origin', 'main']);
    const baseCommit = (await runFixtureGitChecked(root, repository, ['rev-parse', 'HEAD'])).trim();

    const worktreeRoot = join(root, 'worktrees');
    const assigned = await createTaskWorktree({
      repositoryPath: repository,
      baseBranch: 'main',
      taskId: 'task-smoke',
      worktreeRoot,
    });
    const other = await createTaskWorktree({
      repositoryPath: repository,
      baseBranch: 'main',
      taskId: 'task-other',
      worktreeRoot,
    });
    const manifest = smokeManifestSchema.parse({
      harness: smokeHarnessName,
      schemaVersion: 1,
      profile: 'compatibility',
      fixtureId,
      createdAt: new Date().toISOString(),
      parentDirectory,
      rootIdentity: await identityOf(root),
      resultsDirectory,
      resultsIdentity: await identityOf(resultsDirectory),
      paths: {
        root,
        remote,
        repository: assigned.repository.root,
        worktreeRoot: await realpath(worktreeRoot),
        assignedWorktree: assigned.path,
        otherWorktree: other.path,
      },
      remoteIdentity: await identityOf(remote),
      repository: {
        root: assigned.repository.root,
        commonDir: assigned.repository.commonDir,
        rootIdentity: await identityOf(assigned.repository.root),
        commonDirIdentity: await identityOf(assigned.repository.commonDir),
      },
      baseBranch: 'main',
      baseCommit,
      assignedTask: { taskId: assigned.taskId, branch: assigned.branch },
      otherTask: { taskId: other.taskId, branch: other.branch },
    });
    const manifestPath = join(resultsDirectory, smokeManifestFileName);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return { manifest, manifestPath };
  } catch (error) {
    throw new SmokeFixtureError(
      `Smoke fixture setup failed; the partial fixture is preserved at ${root} (results: ${resultsDirectory}). Both carry the ownership marker ${smokeMarkerName} and contain only synthetic data. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Reads the manifest only from a private regular file that sits in its own results directory:
 * not a symbolic link, canonical, owned by the current user, not accessible by group or others.
 */
const readSmokeManifest = async (manifestPath: string): Promise<SmokeManifest> => {
  if (!isAbsolute(manifestPath) || manifestPath.includes('\0')) {
    throw new SmokeFixtureError('The manifest path must be absolute.');
  }
  const stats = await lstat(manifestPath).catch(() => null);
  if (stats === null || stats.isSymbolicLink() || !stats.isFile()) {
    throw new SmokeFixtureError(`${manifestPath} is not a regular file.`);
  }
  if ((await realpath(manifestPath)) !== manifestPath) {
    throw new SmokeFixtureError(`${manifestPath} is not canonical; pass the canonical path.`);
  }
  const uid = process.getuid?.();
  if ((uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    throw new SmokeFixtureError(`${manifestPath} must be private to the current user (0600).`);
  }
  const parsed = smokeManifestSchema.safeParse(
    JSON.parse(await readFile(manifestPath, 'utf8').catch(() => 'null')),
  );
  if (!parsed.success) {
    throw new SmokeFixtureError(`${manifestPath} is not a smoke fixture manifest.`);
  }
  const manifest = parsed.data;
  if (
    dirname(manifestPath) !== manifest.resultsDirectory ||
    basename(manifestPath) !== smokeManifestFileName
  ) {
    throw new SmokeFixtureError(`${manifestPath} is not inside its recorded results directory.`);
  }
  return manifest;
};

const ownedDirectoryChecks = (manifest: SmokeManifest, includeResults: boolean) => {
  const shared = { parentDirectory: manifest.parentDirectory, marker: marker(manifest.fixtureId) };
  const checks = [
    {
      ...shared,
      path: manifest.paths.root,
      identity: manifest.rootIdentity,
      prefix: smokeFixturePrefix,
    },
  ];
  if (includeResults) {
    checks.push({
      ...shared,
      path: manifest.resultsDirectory,
      identity: manifest.resultsIdentity,
      prefix: smokeResultsPrefix,
    });
  }
  return checks;
};

/** Every recorded path lies inside the fixture root; no path is the results directory. */
const recordedPathReasons = (manifest: SmokeManifest): string[] => {
  const reasons: string[] = [];
  for (const [name, path] of Object.entries(manifest.paths)) {
    if (!isWithin(manifest.paths.root, path)) {
      reasons.push(`Recorded path ${name} is outside the fixture root.`);
    }
  }
  if (
    manifest.repository.root !== manifest.paths.repository ||
    !isWithin(manifest.paths.root, manifest.repository.commonDir)
  ) {
    reasons.push('The recorded repository identity is outside the fixture.');
  }
  return reasons;
};

/** A real, canonical directory (no symbolic link anywhere in the path) with the given identity. */
const directoryReasons = async (
  name: string,
  path: string,
  identity?: DirectoryIdentity,
): Promise<string[]> => {
  const stats = await lstat(path).catch(() => null);
  if (stats === null) {
    return [`${name} (${path}) does not exist.`];
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return [`${name} (${path}) is not a directory.`];
  }
  if ((await realpath(path).catch(() => null)) !== path) {
    return [`${name} (${path}) is not canonical (symbolic link redirection).`];
  }
  if (identity !== undefined && !sameIdentity(identity, { dev: stats.dev, ino: stats.ino })) {
    return [`${name} (${path}) was replaced (identity changed).`];
  }
  return [];
};

/** A fixture whose identity was re-proven against the filesystem and Git, right now. */
export type VerifiedSmokeFixture = {
  manifest: SmokeManifest;
  manifestPath: string;
  /** From Git (`inspectTaskWorktree`), equal to the manifest's record. */
  repository: {
    root: string;
    commonDir: string;
    rootIdentity: DirectoryIdentity;
    commonDirIdentity: DirectoryIdentity;
  };
  worktree: { path: string; branch: string; baseCommit: string; worktreeRoot: string };
  taskId: string;
};

/**
 * Verifies a smoke fixture before it may be trusted for a run. The manifest is only a claim; each
 * fact is re-checked:
 *
 * - ownership: both harness directories (identity, prefix, parent, owner, marker, protected
 *   roots), a private canonical manifest inside its results directory;
 * - layout: every recorded path inside the fixture root, canonical, not a symbolic link, the
 *   repository, common Git directory and remote with their recorded identities;
 * - Git: both task worktrees `ready` (registered, locked, on their branch) for this repository,
 *   the task branch at the base commit, `origin` as the only remote, pointing at the fixture's
 *   bare remote;
 * - unused: no run claim, no changes in the assigned worktree.
 *
 * Throws `SmokeFixtureError` with every reason found; never modifies anything.
 */
export const verifySmokeFixture = async (
  manifestPath: string,
  options: SmokeFixtureOptions = {},
): Promise<VerifiedSmokeFixture> => {
  const protectedRoots = options.protectedRoots ?? (await defaultProtectedRoots());
  const manifest = await readSmokeManifest(manifestPath);
  const fail = (reasons: string[]): never => {
    throw new SmokeFixtureError(`The smoke fixture failed verification: ${reasons[0]}`, reasons);
  };
  const ownership = (
    await Promise.all(
      ownedDirectoryChecks(manifest, true).map((check) =>
        verifyOwnedDirectory(check, protectedRoots),
      ),
    )
  ).flat();
  const recorded = recordedPathReasons(manifest);
  if (ownership.length > 0 || recorded.length > 0) {
    fail([...ownership, ...recorded]);
  }
  const { paths } = manifest;
  const layout = (
    await Promise.all([
      directoryReasons('repository', paths.repository, manifest.repository.rootIdentity),
      directoryReasons(
        'common Git directory',
        manifest.repository.commonDir,
        manifest.repository.commonDirIdentity,
      ),
      directoryReasons('remote', paths.remote, manifest.remoteIdentity),
      directoryReasons('worktree root', paths.worktreeRoot),
      directoryReasons('assigned worktree', paths.assignedWorktree),
      directoryReasons('other worktree', paths.otherWorktree),
    ])
  ).flat();
  if (layout.length > 0) {
    fail(layout);
  }

  const git: string[] = [];
  const tasks = [
    { name: 'assigned', path: paths.assignedWorktree, task: manifest.assignedTask },
    { name: 'other', path: paths.otherWorktree, task: manifest.otherTask },
  ];
  for (const { name, path, task } of tasks) {
    const inspection = await inspectTaskWorktree({
      repositoryPath: paths.repository,
      worktreePath: path,
      branchName: task.branch,
    }).catch(() => null);
    if (inspection === null || inspection.state !== 'ready' || inspection.issues.length > 0) {
      git.push(`The ${name} task worktree is not ready (${inspection?.state ?? 'unreadable'}).`);
      continue;
    }
    if (
      inspection.repository.root !== manifest.repository.root ||
      inspection.repository.commonDir !== manifest.repository.commonDir
    ) {
      git.push(`The ${name} task worktree belongs to a different repository.`);
    }
    if (inspection.path !== path) {
      git.push(`The ${name} task worktree resolves to a different path.`);
    }
    if (name === 'assigned' && inspection.branchCommit !== manifest.baseCommit) {
      git.push('The task branch moved away from the base commit.');
    }
  }
  const remotes = await listRemotes(paths.repository).catch(() => null);
  const origin = remotes?.[0];
  if (
    remotes === null ||
    remotes.length !== 1 ||
    origin === undefined ||
    origin.name !== 'origin' ||
    origin.fetchUrls.length !== 1 ||
    origin.fetchUrls[0] !== paths.remote ||
    origin.pushUrls.length > 0
  ) {
    git.push("The repository's remotes differ from the fixture's single local bare remote.");
  }
  if (git.length > 0) {
    fail(git);
  }

  if (
    (await lstat(join(manifest.resultsDirectory, smokeClaimFileName)).catch(() => null)) !== null
  ) {
    fail(['This fixture was already used for a run. Prepare a fresh fixture for every run.']);
  }
  const changes = await inspectTaskChanges({
    repositoryPath: paths.repository,
    worktreePath: paths.assignedWorktree,
    branchName: manifest.assignedTask.branch,
    baseCommit: manifest.baseCommit,
  }).catch(() => null);
  if (
    changes === null ||
    changes.headCommit !== manifest.baseCommit ||
    changes.totalFiles > 0 ||
    changes.ignoredPaths.length > 0
  ) {
    fail(['The assigned worktree is not pristine. Prepare a fresh fixture for every run.']);
  }

  return {
    manifest,
    manifestPath,
    repository: { ...manifest.repository },
    worktree: {
      path: paths.assignedWorktree,
      branch: manifest.assignedTask.branch,
      baseCommit: manifest.baseCommit,
      worktreeRoot: paths.worktreeRoot,
    },
    taskId: manifest.assignedTask.taskId,
  };
};

/** Marks the fixture as used. Fails if another run claimed it first. */
export const claimSmokeFixture = async (
  fixture: VerifiedSmokeFixture,
  runId: string,
): Promise<void> => {
  await writeFile(
    join(fixture.manifest.resultsDirectory, smokeClaimFileName),
    `${JSON.stringify({ runId, claimedAt: new Date().toISOString(), runnerPid: process.pid })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
};

/**
 * Records the started CLI's PID (= its process group, the supervisor starts it detached), so an
 * operator can find it if the runner itself is killed with SIGKILL before writing a report.
 */
export const recordSmokeProcess = async (
  resultsDirectory: string,
  runId: string,
  cliPid: number | null,
): Promise<void> => {
  await writeFile(
    join(resultsDirectory, smokeProcessFileName),
    `${JSON.stringify({ runId, cliPid, processGroup: cliPid, startedAt: new Date().toISOString() })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
};

/** `true` unless the PID is known not to exist. A reused PID errs on the side of refusing. */
const mayBeAlive = (pid: unknown): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readJsonRecord = async (path: string): Promise<Record<string, unknown> | null> => {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * A claimed fixture without a report may still be in use: the runner can outlive its terminal
 * (for example when pnpm exits on a second Ctrl+C) while it stops the CLI, checks integrity and
 * writes the report. Cleanup is refused while the runner or the CLI may still be alive.
 */
const activeRunReasons = async (resultsDirectory: string): Promise<string[]> => {
  const claim = await readJsonRecord(join(resultsDirectory, smokeClaimFileName));
  if (claim === null) return [];
  const entries = await readdir(resultsDirectory).catch(() => [] as string[]);
  if (entries.some((name) => name.startsWith('smoke-report-'))) return [];
  const started = await readJsonRecord(join(resultsDirectory, smokeProcessFileName));
  const reasons: string[] = [];
  if (mayBeAlive(claim.runnerPid)) {
    reasons.push(
      `The smoke runner (pid ${String(claim.runnerPid)}) may still be finishing this run and has not written its report. Wait for it to exit.`,
    );
  }
  if (started !== null && mayBeAlive(started.cliPid)) {
    reasons.push(
      `The CLI (pid ${String(started.cliPid)}, process group ${String(started.processGroup)}) may still be running. Inspect it with: ps -o pid,pgid,command -g ${String(started.processGroup)}`,
    );
  }
  return reasons;
};

export type SmokeCleanupResult =
  { status: 'removed'; removed: string[] } | { status: 'refused'; reasons: string[] };

/**
 * Removes a smoke fixture only after proving ownership (as `verifySmokeFixture`, without the Git
 * and pristine checks: a used fixture must still be removable). Nothing is removed if any check
 * fails. The results directory is kept unless `includeResults` is set.
 */
export const cleanupSmokeFixture = async (
  manifestPath: string,
  options: SmokeFixtureOptions & { includeResults?: boolean } = {},
): Promise<SmokeCleanupResult> => {
  const protectedRoots = options.protectedRoots ?? (await defaultProtectedRoots());
  let manifest: SmokeManifest;
  try {
    manifest = await readSmokeManifest(manifestPath);
  } catch (error) {
    return { status: 'refused', reasons: [(error as Error).message] };
  }
  const checks = ownedDirectoryChecks(manifest, options.includeResults === true);
  const reasons = [
    ...(
      await Promise.all(
        checks.map((check) => verifyOwnedDirectory(check, protectedRoots, { allowMissing: true })),
      )
    ).flat(),
    ...recordedPathReasons(manifest),
    ...(await activeRunReasons(manifest.resultsDirectory)),
  ];
  if (reasons.length > 0) {
    return { status: 'refused', reasons };
  }
  const removed: string[] = [];
  for (const check of checks) {
    if ((await lstat(check.path).catch(() => null)) === null) continue;
    await rm(check.path, { recursive: true });
    removed.push(check.path);
  }
  return { status: 'removed', removed };
};
