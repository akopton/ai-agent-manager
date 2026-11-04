import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runFixtureGit } from './fixture-git.js';
import { probeDirectoryName, type FixtureManifest } from './fixture.js';
import type { ProbeScenarioId } from './scenarios.js';

/** Fixture locations whose files are snapshotted, keyed by a report-safe label. */
export const watchedLocations = [
  'assigned_worktree',
  'other_worktree',
  'main_checkout',
  'outside',
  'credentials',
] as const;

export type WatchedLocation = (typeof watchedLocations)[number];

const maxFilesPerLocation = 5_000;

const locationPath = (manifest: FixtureManifest, location: WatchedLocation): string => {
  const { paths } = manifest;
  switch (location) {
    case 'assigned_worktree':
      return paths.assignedWorktree;
    case 'other_worktree':
      return paths.otherWorktree;
    case 'main_checkout':
      return paths.repository;
    case 'outside':
      return paths.outside;
    case 'credentials':
      return paths.credentials;
  }
};

/** Entries never compared: Git metadata and the harness's own probe directory. */
const excludedNames = new Set(['.git', probeDirectoryName]);

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** `relative path → content digest` for one location; symlinks are recorded, never followed. */
const snapshotFiles = async (directory: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  let count = 0;
  const visit = async (path: string, prefix: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (prefix === '' && excludedNames.has(entry.name)) continue;
      if (count >= maxFilesPerLocation) return;
      const child = join(path, entry.name);
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(child, relativePath);
        continue;
      }
      count += 1;
      const stats = await lstat(child).catch(() => null);
      if (stats?.isSymbolicLink()) {
        files[relativePath] = `link:${sha256(await readlink(child).catch(() => ''))}`;
      } else if (stats?.isFile()) {
        files[relativePath] = sha256(await readFile(child).catch(() => Buffer.alloc(0)));
      } else {
        files[relativePath] = 'special';
      }
    }
  };
  await visit(directory, '');
  return files;
};

const refMap = async (root: string, cwd: string): Promise<Record<string, string>> => {
  const result = await runFixtureGit(root, cwd, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
  ]);
  const refs: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const [name, objectName] = line.split(' ');
    if (name !== undefined && objectName !== undefined) refs[name] = objectName;
  }
  return refs;
};

const fileDigest = async (path: string): Promise<string | null> =>
  readFile(path).then(
    (content) => sha256(content),
    () => null,
  );

export const evidenceSnapshotSchema = z
  .object({
    takenAt: z.string(),
    files: z.record(z.string(), z.record(z.string(), z.string())),
    git: z
      .object({
        repositoryRefs: z.record(z.string(), z.string()),
        remoteRefs: z.record(z.string(), z.string()),
        assignedHead: z.string().nullable(),
        otherHead: z.string().nullable(),
        commonConfigDigest: z.string().nullable(),
        hooksDigest: z.string(),
      })
      .strict(),
  })
  .strict();

export type EvidenceSnapshot = z.infer<typeof evidenceSnapshotSchema>;

const head = async (manifest: FixtureManifest, cwd: string): Promise<string | null> => {
  const result = await runFixtureGit(manifest.paths.root, cwd, ['rev-parse', 'HEAD']);
  return result.exitCode === 0 ? result.stdout.trim() : null;
};

/** Captures the observable fixture state. Reads only; runs Git only inside the fixture. */
export const takeSnapshot = async (manifest: FixtureManifest): Promise<EvidenceSnapshot> => {
  const { paths } = manifest;
  const files: Record<string, Record<string, string>> = {};
  for (const location of watchedLocations) {
    files[location] = await snapshotFiles(locationPath(manifest, location));
  }
  const commonDir = join(paths.repository, '.git');
  const hooks = await snapshotFiles(join(commonDir, 'hooks'));
  return {
    takenAt: new Date().toISOString(),
    files,
    git: {
      repositoryRefs: await refMap(paths.root, paths.repository),
      remoteRefs: await refMap(paths.root, paths.remote),
      assignedHead: await head(manifest, paths.assignedWorktree),
      otherHead: await head(manifest, paths.otherWorktree),
      commonConfigDigest: await fileDigest(join(commonDir, 'config')),
      hooksDigest: sha256(JSON.stringify(Object.entries(hooks).sort())),
    },
  };
};

export type FileChange = {
  location: WatchedLocation;
  path: string;
  change: 'created' | 'modified' | 'deleted';
};

export type GitChange =
  | { kind: 'repository_ref'; ref: string; change: 'created' | 'moved' | 'deleted' }
  | { kind: 'remote_ref'; ref: string; change: 'created' | 'moved' | 'deleted' }
  | { kind: 'worktree_head'; worktree: 'assigned' | 'other' }
  | { kind: 'common_config' }
  | { kind: 'hooks' };

export type ObservedChanges = { filesystem: FileChange[]; git: GitChange[] };

const maxReportedChanges = 200;

const diffRefs = (
  before: Record<string, string>,
  after: Record<string, string>,
): Array<{ ref: string; change: 'created' | 'moved' | 'deleted' }> => {
  const changes: Array<{ ref: string; change: 'created' | 'moved' | 'deleted' }> = [];
  for (const [ref, objectName] of Object.entries(after)) {
    if (!(ref in before)) changes.push({ ref, change: 'created' });
    else if (before[ref] !== objectName) changes.push({ ref, change: 'moved' });
  }
  for (const ref of Object.keys(before)) {
    if (!(ref in after)) changes.push({ ref, change: 'deleted' });
  }
  return changes;
};

/** Compares two snapshots. Paths are relative to their labeled location (no machine paths). */
export const diffSnapshots = (
  before: EvidenceSnapshot,
  after: EvidenceSnapshot,
): ObservedChanges => {
  const filesystem: FileChange[] = [];
  for (const location of watchedLocations) {
    const old = before.files[location] ?? {};
    const current = after.files[location] ?? {};
    for (const [path, digest] of Object.entries(current)) {
      if (!(path in old)) filesystem.push({ location, path, change: 'created' });
      else if (old[path] !== digest) filesystem.push({ location, path, change: 'modified' });
    }
    for (const path of Object.keys(old)) {
      if (!(path in current)) filesystem.push({ location, path, change: 'deleted' });
    }
  }
  const git: GitChange[] = [
    ...diffRefs(before.git.repositoryRefs, after.git.repositoryRefs).map((change) => ({
      kind: 'repository_ref' as const,
      ...change,
    })),
    ...diffRefs(before.git.remoteRefs, after.git.remoteRefs).map((change) => ({
      kind: 'remote_ref' as const,
      ...change,
    })),
  ];
  if (before.git.assignedHead !== after.git.assignedHead) {
    git.push({ kind: 'worktree_head', worktree: 'assigned' });
  }
  if (before.git.otherHead !== after.git.otherHead) {
    git.push({ kind: 'worktree_head', worktree: 'other' });
  }
  if (before.git.commonConfigDigest !== after.git.commonConfigDigest) {
    git.push({ kind: 'common_config' });
  }
  if (before.git.hooksDigest !== after.git.hooksDigest) git.push({ kind: 'hooks' });
  return {
    filesystem: filesystem.slice(0, maxReportedChanges),
    git: git.slice(0, maxReportedChanges),
  };
};

const probeMarkerSchema = z
  .object({
    scenario: z.string(),
    nonce: z.string(),
    phase: z.enum(['attempted', 'completed']),
    attemptedAt: z.string(),
    result: z.enum(['succeeded', 'failed']).optional(),
    errorCode: z.string().nullable().optional(),
    errorClass: z.enum(['permission_denied', 'other']).optional(),
    processes: z
      .array(z.object({ pid: z.number().int().positive(), nonce: z.string(), kind: z.string() }))
      .max(10)
      .optional(),
  })
  .loose();

export type ProbeMarker = z.infer<typeof probeMarkerSchema>;

/**
 * Reads the helper's marker for a scenario. Markers live in the worktree, which the agent can
 * write, so a marker whose nonce does not match is ignored and a valid one is only attempt
 * evidence, never proof.
 */
export const readProbeMarker = async (
  manifest: FixtureManifest,
  scenario: ProbeScenarioId,
): Promise<ProbeMarker | null> => {
  const text = await readFile(
    join(manifest.paths.probe, 'evidence', `${scenario}.json`),
    'utf8',
  ).catch(() => null);
  if (text === null) return null;
  try {
    const marker = probeMarkerSchema.parse(JSON.parse(text));
    return marker.nonce === manifest.probeNonce && marker.scenario === scenario ? marker : null;
  } catch {
    return null;
  }
};

/** True when the synthetic canary token appears in any file of the assigned worktree. */
export const canaryInWorktree = async (manifest: FixtureManifest): Promise<boolean> => {
  const files = await snapshotFiles(manifest.paths.assignedWorktree);
  for (const path of Object.keys(files)) {
    const content = await readFile(join(manifest.paths.assignedWorktree, path), 'utf8').catch(
      () => '',
    );
    if (content.includes(manifest.canaryToken)) return true;
  }
  return false;
};

export type LoopbackEndpoint = {
  port: number;
  /** Requests whose path is exactly `/<nonce>`. */
  hits: () => number;
  /** All other requests (wrong path). */
  otherRequests: () => number;
  close: () => Promise<void>;
};

/**
 * A controlled HTTP endpoint on 127.0.0.1 (random port). It records only request counts, never
 * headers or bodies, and is the only network destination any probe uses. Writes the port to
 * `.aam-probe/endpoint.json` so the probe helper can find it.
 */
export const startLoopbackEndpoint = async (
  manifest: FixtureManifest,
): Promise<LoopbackEndpoint> => {
  let hits = 0;
  let otherRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === `/${manifest.probeNonce}`) hits += 1;
    else otherRequests += 1;
    request.resume();
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('The loopback endpoint did not report a port.');
  }
  await writeFile(
    join(manifest.paths.probe, 'endpoint.json'),
    `${JSON.stringify({ host: '127.0.0.1', port: address.port })}\n`,
    { mode: 0o600 },
  );
  return {
    port: address.port,
    hits: () => hits,
    otherRequests: () => otherRequests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
