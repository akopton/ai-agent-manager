import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, open, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Darwin's public O_NOFOLLOW_ANY flag (sys/fcntl.h). Unlike O_NOFOLLOW it applies to
// every component in a single kernel path lookup. Node/libuv forwards numeric Unix flags.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
const noFollowAny = 0x20000000;
const flags = constants.O_RDONLY | constants.O_NONBLOCK | noFollowAny;

let capability: Promise<void> | undefined;
const checkCapability = async (): Promise<void> => {
  if (process.platform !== 'darwin') {
    throw new Error('Working-tree source reads require verified macOS O_NOFOLLOW_ANY support.');
  }
  try {
    await access(new URL('../native-dist/source-reader', import.meta.url), constants.X_OK);
  } catch {
    throw new Error(
      'The trusted source reader is unavailable. Run pnpm build with Xcode Command Line Tools installed.',
    );
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aam-source-read-')));
  try {
    await mkdir(join(directory, 'target'));
    await mkdir(join(directory, 'target/child'));
    await symlink('target', join(directory, 'link'));
    // Verify ancestor and final-component rejection, without reading any repository content.
    for (const path of ['link', 'link/child']) {
      try {
        const handle = await open(join(directory, path), flags);
        await handle.close();
        throw new Error('The OS did not enforce O_NOFOLLOW_ANY.');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ELOOP')) throw error;
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const requireWorkingTreeReadSupport = (): Promise<void> =>
  (capability ??= checkCapability());

export type DirectoryIdentity = { dev: bigint; ino: bigint };

export const directoryIdentity = async (path: string): Promise<DirectoryIdentity> => {
  await requireWorkingTreeReadSupport();
  const handle = await open(path, flags | constants.O_DIRECTORY);
  try {
    return await handle.stat({ bigint: true });
  } finally {
    await handle.close();
  }
};

export const sameIdentity = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

export type WorkingTreeRead = {
  bytes: Buffer;
  contentHash: string;
  readAt: string;
};

/** Caller supplies an exact eligible Git path. This repeats lexical validation at the I/O boundary. */
export const readWorkingTreeFile = async (
  root: string,
  path: string,
  maxBytes: number,
  expectedRoot: DirectoryIdentity,
): Promise<WorkingTreeRead> => {
  await requireWorkingTreeReadSupport();
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.includes(':') ||
    /\p{Default_Ignorable_Code_Point}/u.test(path) ||
    // eslint-disable-next-line no-control-regex -- reject control characters at the I/O boundary.
    /[\u0000-\u001f\u007f]/.test(path) ||
    path
      .split('/')
      .some(
        (part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git',
      ) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  ) {
    throw new Error('Invalid working-tree source read.');
  }
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const helper = spawn(
      fileURLToPath(new URL('../native-dist/source-reader', import.meta.url)),
      [root, String(expectedRoot.dev), String(expectedRoot.ino), path, String(maxBytes)],
      { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { NODE_ENV: 'production' } },
    );
    const chunks: Buffer[] = [];
    let length = 0;
    const timeout = setTimeout(() => {
      helper.kill('SIGKILL');
    }, 20_000);
    helper.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxBytes) helper.kill('SIGKILL');
      else chunks.push(chunk);
    });
    helper.once('error', reject);
    helper.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || length > maxBytes) {
        reject(new Error('Source is missing, unsafe, oversized or changed during retrieval.'));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
  return {
    bytes,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    readAt: new Date().toISOString(),
  };
};
