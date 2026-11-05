import { chmod, lstat, mkdtemp, readFile, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { assertSafeHarnessLocation, DiagnosticsPathError, type ProtectedRoot } from './paths.js';

// Ownership primitives shared by the diagnostics fixture and the SEC-02e smoke fixture. Each
// harness uses its own directory prefixes, marker file and harness name, so one harness never
// accepts or removes the other's directories.

export type DirectoryIdentity = { dev: number; ino: number };

export const identityOf = async (path: string): Promise<DirectoryIdentity> => {
  const stats = await lstat(path);
  return { dev: stats.dev, ino: stats.ino };
};

/** Creates a private directory with `mkdtemp` and validates its location before using it. */
export const createOwnedDirectory = async (
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

/** What a harness directory must match: its creation record and the harness's marker. */
export type OwnedDirectoryCheck = {
  path: string;
  identity: DirectoryIdentity;
  prefix: string;
  parentDirectory: string;
  marker: { fileName: string; harness: string; fixtureId: string };
};

/**
 * Proves a directory is the one the harness created: identity, canonical location directly inside
 * the recorded parent with the harness prefix, owner, protected roots, and a matching marker.
 * Returns the reasons it is not; an empty list means verified. A missing directory yields no
 * reasons when `allowMissing` is set (already removed), and a reason otherwise.
 */
export const verifyOwnedDirectory = async (
  check: OwnedDirectoryCheck,
  protectedRoots: readonly ProtectedRoot[],
  options: { allowMissing?: boolean } = {},
): Promise<string[]> => {
  const reasons: string[] = [];
  const stats = await lstat(check.path).catch(() => null);
  if (stats === null) {
    return options.allowMissing === true ? [] : [`${check.path} does not exist.`];
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
    dirname(check.path) !== check.parentDirectory ||
    !basename(check.path).startsWith(check.prefix)
  ) {
    reasons.push(`${check.path} is not a harness directory in ${check.parentDirectory}.`);
  }
  if ((await realpath(check.path).catch(() => null)) !== check.path) {
    reasons.push(`${check.path} is not canonical.`);
  }
  await assertSafeHarnessLocation(check.path, protectedRoots).catch((error: Error) =>
    reasons.push(error.message),
  );
  const marker = await readFile(join(check.path, check.marker.fileName), 'utf8')
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const markerOk =
    typeof marker === 'object' &&
    marker !== null &&
    'harness' in marker &&
    'fixtureId' in marker &&
    marker.harness === check.marker.harness &&
    marker.fixtureId === check.marker.fixtureId;
  if (!markerOk) {
    reasons.push(`${check.path} has no matching ownership marker.`);
  }
  return reasons;
};
