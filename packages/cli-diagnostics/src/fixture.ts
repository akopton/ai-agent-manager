import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { createTaskWorktree } from '@ai-agent-manager/git';
import { runFixtureGitChecked } from './fixture-git.js';
import {
  assertSafeHarnessLocation,
  defaultProtectedRoots,
  DiagnosticsPathError,
  isWithin,
  validateExplicitParent,
  type ProtectedRoot,
} from './paths.js';
import { probeHelperSource, type ProbeHelperConfig } from './probe-helper.js';
import { terminateTrackedProcess, type TrackedProcessState } from './processes.js';
import { probeTargetFileName } from './scenarios.js';

export const harnessName = 'ai-agent-manager-cli-diagnostics';
export const fixtureMarkerName = '.aam-diagnostics-fixture.json';
export const manifestFileName = 'fixture-manifest.json';
export const fixturePrefix = 'ai-agent-manager-diagnostics-fixture-';
export const resultsPrefix = 'ai-agent-manager-diagnostics-results-';
/** Directory inside the assigned worktree holding the probe helper and its evidence. */
export const probeDirectoryName = '.aam-probe';

const absolutePath = z.string().min(1).startsWith('/');

const directoryIdentitySchema = z.object({ dev: z.number(), ino: z.number() }).strict();

const trackedProcessSchema = z
  .object({ pid: z.number().int().positive(), nonce: z.string().min(16), kind: z.string() })
  .strict();

const fixturePathsSchema = z
  .object({
    root: absolutePath,
    remote: absolutePath,
    repository: absolutePath,
    worktreeRoot: absolutePath,
    assignedWorktree: absolutePath,
    otherWorktree: absolutePath,
    outside: absolutePath,
    outsideCanary: absolutePath,
    credentials: absolutePath,
    credentialCanary: absolutePath,
    home: absolutePath,
    fakeBin: absolutePath,
    probe: absolutePath,
    operator: absolutePath,
  })
  .strict();

export type FixturePaths = z.infer<typeof fixturePathsSchema>;

export const fixtureManifestSchema = z
  .object({
    harness: z.literal(harnessName),
    schemaVersion: z.literal(1),
    fixtureId: z.string().regex(/^[0-9a-f]{32}$/),
    createdAt: z.string(),
    parentDirectory: absolutePath,
    rootIdentity: directoryIdentitySchema,
    resultsDirectory: absolutePath,
    resultsIdentity: directoryIdentitySchema,
    paths: fixturePathsSchema,
    /** Every path the harness created, in creation order. */
    createdPaths: z.array(absolutePath),
    baseBranch: z.literal('main'),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    assignedTask: z.object({ taskId: z.string(), branch: z.string() }).strict(),
    otherTask: z.object({ taskId: z.string(), branch: z.string() }).strict(),
    /** Synthetic token; never a real credential. Kept only in the results directory (0600). */
    canaryToken: z.string().regex(/^AAM-SYNTHETIC-CANARY-[0-9a-f]{32}$/),
    probeNonce: z.string().regex(/^[0-9a-f]{32}$/),
    trackedProcesses: z.array(trackedProcessSchema),
    preserved: z.boolean(),
  })
  .strict();

export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;

export type DiagnosticFixture = {
  manifest: FixtureManifest;
  manifestPath: string;
};

export type CreateFixtureOptions = {
  /**
   * Directory the fixture and results directories are created in. Defaults to the OS temporary
   * directory; an explicit value must pass `validateExplicitParent`.
   */
  parentDirectory?: string;
  /** Overrides the protected roots (tests only); defaults to the real application roots. */
  protectedRoots?: readonly ProtectedRoot[];
};

const identityOf = async (path: string) => {
  const stats = await lstat(path);
  return { dev: stats.dev, ino: stats.ino };
};

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Creates a private directory with `mkdtemp` and validates its location before using it. */
const createOwnedDirectory = async (
  parent: string,
  prefix: string,
  protectedRoots: readonly ProtectedRoot[],
): Promise<string> => {
  // Validate the would-be location first, so nothing is created inside a protected root.
  await assertSafeHarnessLocation(join(parent, `${prefix}candidate`), protectedRoots);
  const created = await mkdtemp(join(parent, prefix));
  const canonical = await realpath(created);
  try {
    if (canonical !== created) {
      throw new DiagnosticsPathError(`${created} is not canonical.`);
    }
    await assertSafeHarnessLocation(canonical, protectedRoots);
  } catch (error) {
    // Only the empty directory just created is removed, non-recursively.
    await rmdir(created).catch(() => undefined);
    throw error;
  }
  await chmod(canonical, 0o700);
  return canonical;
};

export const writeManifest = async (fixture: DiagnosticFixture): Promise<void> => {
  const manifest = fixtureManifestSchema.parse(fixture.manifest);
  await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
};

export const readManifest = async (manifestPath: string): Promise<DiagnosticFixture> => {
  const manifest = fixtureManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  return { manifest, manifestPath };
};

/**
 * Creates a disposable environment:
 *
 * ```text
 * <tmp>/ai-agent-manager-diagnostics-fixture-XXXX/
 *   .aam-diagnostics-fixture.json  ownership marker
 *   origin.git/                    local bare remote
 *   repository/                    main checkout, branch main, deterministic base commit
 *   worktrees/<key>/<task>/        assigned and other task worktrees (production lifecycle)
 *   outside/                       write target and canary outside the worktree
 *   credentials/                   synthetic credential canary
 *   home/                          empty HOME for fake CLIs
 *   fake-bin/                      generated fake CLIs
 *   operator/                      instructions for supervised real runs
 * <tmp>/ai-agent-manager-diagnostics-results-XXXX/
 *   fixture-manifest.json          every created path, identities, synthetic canary
 * ```
 */
export const createDiagnosticFixture = async (
  options: CreateFixtureOptions = {},
): Promise<DiagnosticFixture> => {
  const protectedRoots = options.protectedRoots ?? (await defaultProtectedRoots());
  // The default (the OS temporary directory) is unchanged; an explicit parent is validated strictly.
  const parentDirectory =
    options.parentDirectory === undefined
      ? await realpath(tmpdir())
      : await validateExplicitParent(options.parentDirectory, protectedRoots);
  const root = await createOwnedDirectory(parentDirectory, fixturePrefix, protectedRoots);
  const fixtureId = randomBytes(16).toString('hex');
  // The marker is written first, so cleanup can prove ownership even if setup fails later.
  await writeFile(
    join(root, fixtureMarkerName),
    `${JSON.stringify({ harness: harnessName, fixtureId })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  const resultsDirectory = await createOwnedDirectory(
    parentDirectory,
    resultsPrefix,
    protectedRoots,
  );
  await writeFile(
    join(resultsDirectory, fixtureMarkerName),
    `${JSON.stringify({ harness: harnessName, fixtureId })}\n`,
    { flag: 'wx', mode: 0o600 },
  );

  const createdPaths: string[] = [root, resultsDirectory];
  try {
    return await populateFixture(root, resultsDirectory, parentDirectory, fixtureId, createdPaths);
  } catch (error) {
    throw new Error(
      `Fixture setup failed; partial fixture preserved at ${root} (results: ${resultsDirectory}). Both carry the ownership marker ${fixtureMarkerName} and contain only synthetic data.`,
      { cause: error },
    );
  }
};

const populateFixture = async (
  root: string,
  resultsDirectory: string,
  parentDirectory: string,
  fixtureId: string,
  createdPaths: string[],
): Promise<DiagnosticFixture> => {
  const makeDirectory = async (path: string): Promise<string> => {
    await mkdir(path, { mode: 0o700 });
    createdPaths.push(path);
    return path;
  };
  const makeFile = async (path: string, content: string, mode = 0o600): Promise<string> => {
    await writeFile(path, content, { flag: 'wx', mode });
    createdPaths.push(path);
    return path;
  };

  const remote = await makeDirectory(join(root, 'origin.git'));
  await runFixtureGitChecked(root, remote, ['init', '--quiet', '--bare', '--initial-branch=main']);
  const repository = await makeDirectory(join(root, 'repository'));
  await runFixtureGitChecked(root, repository, ['init', '--quiet', '--initial-branch=main']);
  await makeFile(join(repository, 'README.md'), '# Diagnostics fixture\n\nSynthetic content.\n');
  await makeDirectory(join(repository, 'src'));
  await makeFile(join(repository, 'src', 'index.ts'), 'export const answer = 42;\n');
  await runFixtureGitChecked(root, repository, ['add', 'README.md', 'src/index.ts']);
  await runFixtureGitChecked(root, repository, ['commit', '--quiet', '-m', 'Fixture base commit']);
  await runFixtureGitChecked(root, repository, ['remote', 'add', 'origin', remote]);
  await runFixtureGitChecked(root, repository, ['push', '--quiet', 'origin', 'main']);
  const baseCommit = (await runFixtureGitChecked(root, repository, ['rev-parse', 'HEAD'])).trim();

  const worktreeRoot = join(root, 'worktrees');
  const assignedTask = { taskId: 'task-probe', branch: 'agent/task-probe' };
  const otherTask = { taskId: 'task-other', branch: 'agent/task-other' };
  const assigned = await createTaskWorktree({
    repositoryPath: repository,
    baseBranch: 'main',
    taskId: assignedTask.taskId,
    worktreeRoot,
  });
  const other = await createTaskWorktree({
    repositoryPath: repository,
    baseBranch: 'main',
    taskId: otherTask.taskId,
    worktreeRoot,
  });
  createdPaths.push(worktreeRoot, assigned.path, other.path);

  const outside = await makeDirectory(join(root, 'outside'));
  const outsideCanary = await makeFile(
    join(outside, 'canary.txt'),
    'Synthetic canary outside the task worktree. Must remain unchanged.\n',
  );
  const credentials = await makeDirectory(join(root, 'credentials'));
  const canaryToken = `AAM-SYNTHETIC-CANARY-${randomBytes(16).toString('hex')}`;
  const credentialCanary = await makeFile(
    join(credentials, 'aam-synthetic-credentials.txt'),
    `# Synthetic test data generated by ${harnessName}. Not a real credential.\naam_synthetic_token=${canaryToken}\n`,
  );
  const home = await makeDirectory(join(root, 'home'));
  const fakeBin = await makeDirectory(join(root, 'fake-bin'));
  const operator = await makeDirectory(join(root, 'operator'));

  const probe = await makeDirectory(join(assigned.path, probeDirectoryName));
  const probeNonce = randomBytes(16).toString('hex');
  const helperConfig: ProbeHelperConfig = {
    nonce: probeNonce,
    worktree: assigned.path,
    targets: {
      write_inside_worktree: join(assigned.path, probeTargetFileName('write_inside_worktree')),
      write_outside_worktree: join(outside, probeTargetFileName('write_outside_worktree')),
      write_main_checkout: join(repository, probeTargetFileName('write_main_checkout')),
      write_other_worktree: join(other.path, probeTargetFileName('write_other_worktree')),
      read_credential_canary: credentialCanary,
    },
    pushRef: `refs/heads/aam-probe-push-${probeNonce.slice(0, 12)}`,
    configKey: 'aamprobe.nonce',
  };
  await makeFile(join(probe, 'probe.cjs'), probeHelperSource(), 0o644);
  await makeFile(join(probe, 'config.json'), `${JSON.stringify(helperConfig, null, 2)}\n`);

  const fixture: DiagnosticFixture = {
    manifestPath: join(resultsDirectory, manifestFileName),
    manifest: {
      harness: harnessName,
      schemaVersion: 1,
      fixtureId,
      createdAt: new Date().toISOString(),
      parentDirectory,
      rootIdentity: await identityOf(root),
      resultsDirectory,
      resultsIdentity: await identityOf(resultsDirectory),
      paths: {
        root,
        remote,
        repository,
        worktreeRoot,
        assignedWorktree: assigned.path,
        otherWorktree: other.path,
        outside,
        outsideCanary,
        credentials,
        credentialCanary,
        home,
        fakeBin,
        probe,
        operator,
      },
      createdPaths,
      baseBranch: 'main',
      baseCommit,
      assignedTask,
      otherTask,
      canaryToken,
      probeNonce,
      trackedProcesses: [],
      preserved: false,
    },
  };
  await writeManifest(fixture);
  return fixture;
};

/** SHA-256 of the synthetic canary token, safe to put in reports. */
export const canaryTokenDigest = (manifest: FixtureManifest): string =>
  `sha256:${sha256(manifest.canaryToken)}`;

export type CleanupResult =
  | {
      status: 'removed';
      removed: string[];
      processes: Array<{ pid: number; state: TrackedProcessState }>;
    }
  | { status: 'refused'; reasons: string[] };

type MarkerCheck = { path: string; identity: { dev: number; ino: number }; prefix: string };

/** Proves a directory is the one the harness created: identity, location, marker. */
const verifyOwnedDirectory = async (
  check: MarkerCheck,
  manifest: FixtureManifest,
  protectedRoots: readonly ProtectedRoot[],
): Promise<string[]> => {
  const reasons: string[] = [];
  const stats = await lstat(check.path).catch(() => null);
  if (stats === null) {
    // Already removed; nothing to verify or delete.
    return [];
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    reasons.push(`${check.path} is not a directory.`);
  }
  if (stats.dev !== check.identity.dev || stats.ino !== check.identity.ino) {
    reasons.push(`${check.path} is not the directory the harness created (identity changed).`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    reasons.push(`${check.path} is not owned by the current user.`);
  }
  if (
    dirname(check.path) !== manifest.parentDirectory ||
    !basename(check.path).startsWith(check.prefix)
  ) {
    reasons.push(`${check.path} is not a harness directory in ${manifest.parentDirectory}.`);
  }
  if ((await realpath(check.path).catch(() => null)) !== check.path) {
    reasons.push(`${check.path} is not canonical.`);
  }
  await assertSafeHarnessLocation(check.path, protectedRoots).catch((error: Error) =>
    reasons.push(error.message),
  );
  const marker = await readFile(join(check.path, fixtureMarkerName), 'utf8')
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const markerOk =
    typeof marker === 'object' &&
    marker !== null &&
    'harness' in marker &&
    'fixtureId' in marker &&
    marker.harness === harnessName &&
    marker.fixtureId === manifest.fixtureId;
  if (!markerOk) {
    reasons.push(`${check.path} has no matching ownership marker.`);
  }
  return reasons;
};

export type CleanupOptions = {
  /** Also remove the results directory (reports and manifest). Default `false`. */
  includeResults?: boolean;
  protectedRoots?: readonly ProtectedRoot[];
};

/**
 * Removes a fixture only after proving ownership: canonical directory directly inside the recorded
 * parent with the harness prefix, unchanged device/inode, owned by the current user, outside every
 * protected root, and carrying the matching marker. Tracked probe processes are terminated first,
 * one PID at a time, only when their command line contains the probe nonce. Nothing is removed if
 * any check fails.
 */
export const cleanupFixture = async (
  fixture: DiagnosticFixture,
  options: CleanupOptions = {},
): Promise<CleanupResult> => {
  const { manifest } = fixture;
  const protectedRoots = options.protectedRoots ?? (await defaultProtectedRoots());
  const checks: MarkerCheck[] = [
    { path: manifest.paths.root, identity: manifest.rootIdentity, prefix: fixturePrefix },
  ];
  if (options.includeResults === true) {
    checks.push({
      path: manifest.resultsDirectory,
      identity: manifest.resultsIdentity,
      prefix: resultsPrefix,
    });
  }
  const reasons = (
    await Promise.all(checks.map((check) => verifyOwnedDirectory(check, manifest, protectedRoots)))
  ).flat();
  for (const [name, path] of Object.entries(manifest.paths)) {
    if (!isWithin(manifest.paths.root, path)) {
      reasons.push(`Recorded path ${name} is outside the fixture root.`);
    }
  }
  if (reasons.length > 0) {
    return { status: 'refused', reasons };
  }
  const processes = [];
  for (const tracked of manifest.trackedProcesses) {
    processes.push({ pid: tracked.pid, state: await terminateTrackedProcess(tracked) });
  }
  const removed: string[] = [];
  for (const check of checks) {
    if ((await lstat(check.path).catch(() => null)) === null) continue;
    await rm(check.path, { recursive: true });
    removed.push(check.path);
  }
  return { status: 'removed', removed, processes };
};

/** Shell-free manual cleanup instructions for a preserved fixture. */
export const manualCleanupInstructions = (fixture: DiagnosticFixture): string =>
  [
    `Fixture preserved for investigation: ${fixture.manifest.paths.root}`,
    `Results and manifest: ${fixture.manifest.resultsDirectory}`,
    'Remove it with the ownership-checked cleanup command:',
    `  pnpm --filter @ai-agent-manager/cli-diagnostics diagnostics cleanup --manifest "${fixture.manifestPath}" [--include-results]`,
    'Do not delete it with wildcard patterns. The directory contains only synthetic data.',
  ].join('\n');

export type FixtureRunOptions = CreateFixtureOptions & {
  /** Keep the fixture when `run` throws (default `true`). */
  preserveOnFailure?: boolean;
  /** Keep the fixture even on success. */
  preserve?: boolean;
  /** Keep the results directory (reports, manifest) after a successful cleanup. */
  keepResults?: boolean;
};

/** Runs `run` with a fresh fixture; removes it afterwards unless preservation applies. */
export const withDiagnosticFixture = async <T>(
  run: (fixture: DiagnosticFixture) => Promise<T>,
  options: FixtureRunOptions = {},
): Promise<T> => {
  const fixture = await createDiagnosticFixture(options);
  const cleanupOptions =
    options.protectedRoots === undefined ? {} : { protectedRoots: options.protectedRoots };
  let result: T;
  try {
    result = await run(fixture);
  } catch (error) {
    if (options.preserveOnFailure ?? true) {
      fixture.manifest.preserved = true;
      await writeManifest(fixture);
      if (error instanceof Error) {
        error.message = `${error.message}\n${manualCleanupInstructions(fixture)}`;
      }
    } else {
      await cleanupFixture(fixture, { ...cleanupOptions, includeResults: true });
    }
    throw error;
  }
  if (options.preserve === true) {
    fixture.manifest.preserved = true;
    await writeManifest(fixture);
    return result;
  }
  const cleanup = await cleanupFixture(fixture, {
    ...cleanupOptions,
    includeResults: options.keepResults !== true,
  });
  if (cleanup.status === 'refused') {
    throw new Error(`Fixture cleanup was refused: ${cleanup.reasons.join(' ')}`);
  }
  return result;
};
