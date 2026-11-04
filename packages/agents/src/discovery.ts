import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AgentRuntime } from '@ai-agent-manager/core';
import type {
  CliDetection,
  CliDetectionOptions,
  CliUnavailableReason,
  ExecutableFingerprint,
} from './contract.js';
import { buildChildEnvironment } from './environment.js';
import { compareVersions, parseVersionOutput } from './version.js';

/** Static facts an adapter declares about its CLI for discovery. */
export type CliDefinition = {
  runtime: AgentRuntime;
  displayName: string;
  executableName: string;
  /** Matches the first `--version` line; group 1 is the version. */
  versionPattern: RegExp;
  /**
   * Oldest version whose command-line interface was inspected. Older versions are rejected
   * because their options were never assessed; newer ones must still list `requiredOptions`.
   */
  minimumVersion: string;
  /** Arguments that print the help for the non-interactive mode. */
  helpArguments: readonly string[];
  /** Long options that must appear in that help output. */
  requiredOptions: readonly string[];
  /** Long options recorded when present (for capability reporting), not required. */
  optionalOptions: readonly string[];
  environmentNames: readonly string[];
};

const defaultProbeTimeoutMs = 15_000;
const maxProbeOutputBytes = 512 * 1024;

type ProbeResult =
  { ok: true; exitCode: number; stdout: string; stderr: string } | { ok: false; message: string };

const spawnProbe = (
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  stdoutFd: number,
): Promise<{ ok: true; exitCode: number; stderr: string } | { ok: false; message: string }> =>
  new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', stdoutFd, 'pipe'],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let failure: string | null = null;
    const fail = (message: string): void => {
      if (failure === null) {
        failure = message;
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs} ms`), timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxProbeOutputBytes) {
        fail(`printed more than ${maxProbeOutputBytes} bytes`);
        return;
      }
      stderr.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: `could not be started: ${error.message}` });
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (failure !== null || exitCode === null) {
        resolve({ ok: false, message: failure ?? `was terminated by ${signal ?? 'a signal'}` });
        return;
      }
      resolve({ ok: true, exitCode, stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });

/**
 * Runs a short, non-interactive probe (`--version`, `--help`) with bounded output.
 *
 * Stdout goes to a file in a private temporary directory, not a pipe: Claude Code 2.1.317 exits
 * before flushing `--help` to a pipe, truncating it at an unpredictable point (observed around
 * 8 KiB), which made required options appear missing. Writes to a regular file are not lost.
 */
const runProbe = async (
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ProbeResult> => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ai-agent-manager-probe-'));
  try {
    const path = join(directory, 'stdout');
    const file = await open(path, 'wx', 0o600);
    let result: Awaited<ReturnType<typeof spawnProbe>>;
    try {
      result = await spawnProbe(executable, args, cwd, env, timeoutMs, file.fd);
    } finally {
      await file.close();
    }
    if (!result.ok) {
      return result;
    }
    const { size } = await stat(path);
    if (size > maxProbeOutputBytes) {
      return { ok: false, message: `printed more than ${maxProbeOutputBytes} bytes` };
    }
    return { ...result, stdout: await readFile(path, 'utf8') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** Reads the identity of a canonical executable path. */
export const fingerprintExecutable = async (path: string): Promise<ExecutableFingerprint> => {
  const stats = await stat(path);
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
};

type ResolvedExecutable =
  | { ok: true; path: string }
  | { ok: false; reason: CliUnavailableReason; message: string; path?: string };

const resolveCandidate = async (candidate: string): Promise<ResolvedExecutable> => {
  const canonical = await realpath(candidate).catch(() => null);
  if (canonical === null) {
    return { ok: false, reason: 'not_found', message: `${candidate} does not exist.` };
  }
  const stats = await stat(canonical).catch(() => null);
  if (stats === null || !stats.isFile()) {
    return {
      ok: false,
      reason: 'not_executable',
      message: `${canonical} is not a regular file.`,
      path: canonical,
    };
  }
  const executable = await access(canonical, constants.X_OK).then(
    () => true,
    () => false,
  );
  if (!executable) {
    return {
      ok: false,
      reason: 'not_executable',
      message: `${canonical} is not executable.`,
      path: canonical,
    };
  }
  return { ok: true, path: canonical };
};

/**
 * Finds the executable without a shell: an explicit absolute path, or the first matching regular,
 * executable file on the search path. Relative search path entries are ignored.
 */
const resolveExecutable = async (
  definition: CliDefinition,
  options: CliDetectionOptions,
  source: NodeJS.ProcessEnv,
): Promise<ResolvedExecutable> => {
  if (options.executablePath !== undefined) {
    if (!isAbsolute(options.executablePath) || options.executablePath.includes('\0')) {
      return {
        ok: false,
        reason: 'not_found',
        message: 'The configured executable path must be absolute.',
      };
    }
    return resolveCandidate(options.executablePath);
  }
  const directories = options.searchPath ?? (source.PATH ?? '').split(delimiter);
  for (const directory of directories) {
    if (directory === '' || !isAbsolute(directory)) {
      continue;
    }
    const candidate = await resolveCandidate(join(directory, definition.executableName));
    if (candidate.ok) {
      return candidate;
    }
  }
  return {
    ok: false,
    reason: 'not_found',
    message: `${definition.displayName} (${definition.executableName}) was not found on the search path.`,
  };
};

/** Extracts long options (`--name`) from help output. */
export const parseHelpOptions = (help: string): Set<string> =>
  new Set(
    [...help.matchAll(/(?:^|[\s,[])(--[a-z0-9][a-z0-9-]*)/gm)].map((match) => match[1] ?? ''),
  );

const describeProbeFailure = (result: ProbeResult): string =>
  result.ok
    ? `exited with code ${result.exitCode}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim().slice(0, 300)}`}`
    : result.message;

/**
 * Detects a CLI: executable location, version, and the options the adapter needs. Runs only
 * `--version` and help commands. Says nothing about whether any security control is enforced.
 */
export const detectCli = async (
  definition: CliDefinition,
  options: CliDetectionOptions = {},
): Promise<CliDetection> => {
  const source = options.sourceEnvironment ?? process.env;
  const runtime = definition.runtime;
  const unavailable = (
    reason: CliUnavailableReason,
    message: string,
    extra: { executablePath?: string; version?: string } = {},
  ): CliDetection => ({ status: 'unavailable', runtime, reason, message, ...extra });

  const resolved = await resolveExecutable(definition, options, source);
  if (!resolved.ok) {
    return unavailable(
      resolved.reason,
      resolved.message,
      resolved.path === undefined ? {} : { executablePath: resolved.path },
    );
  }
  const executablePath = resolved.path;
  const fingerprint = await fingerprintExecutable(executablePath);
  const env = buildChildEnvironment(source, definition.environmentNames);
  const cwd = options.probeDirectory ?? (await realpath(tmpdir()));
  const timeoutMs = options.timeoutMs ?? defaultProbeTimeoutMs;

  const versionResult = await runProbe(executablePath, ['--version'], cwd, env, timeoutMs);
  if (!versionResult.ok || versionResult.exitCode !== 0) {
    return unavailable(
      'version_failed',
      `${definition.displayName} --version ${describeProbeFailure(versionResult)}.`,
      { executablePath },
    );
  }
  const parsed = parseVersionOutput(versionResult.stdout, definition.versionPattern);
  if (parsed === null) {
    return unavailable(
      'version_unrecognized',
      `${definition.displayName} printed an unrecognized version: ${JSON.stringify(
        versionResult.stdout.trim().slice(0, 120),
      )}.`,
      { executablePath },
    );
  }
  const minimum = parseVersionOutput(definition.minimumVersion, /^(.+)$/);
  if (minimum !== null && compareVersions(parsed, minimum) < 0) {
    return unavailable(
      'version_unsupported',
      `${definition.displayName} ${parsed.version} is older than ${definition.minimumVersion}, the oldest version whose command-line interface has been assessed.`,
      { executablePath, version: parsed.version },
    );
  }

  const helpResult = await runProbe(executablePath, definition.helpArguments, cwd, env, timeoutMs);
  if (!helpResult.ok || helpResult.exitCode !== 0) {
    return unavailable(
      'help_failed',
      `${definition.displayName} ${definition.helpArguments.join(' ')} ${describeProbeFailure(helpResult)}.`,
      { executablePath, version: parsed.version },
    );
  }
  const listed = parseHelpOptions(helpResult.stdout);
  const missing = definition.requiredOptions.filter((option) => !listed.has(option));
  if (missing.length > 0) {
    return unavailable(
      'options_missing',
      `${definition.displayName} ${parsed.version} does not list required options: ${missing.join(', ')}.`,
      { executablePath, version: parsed.version },
    );
  }
  const detectedOptions = [...definition.requiredOptions, ...definition.optionalOptions]
    .filter((option, index, all) => listed.has(option) && all.indexOf(option) === index)
    .sort();

  return {
    status: 'available',
    installation: Object.freeze({
      runtime,
      executablePath,
      fingerprint: Object.freeze(fingerprint),
      version: parsed.version,
      detectedOptions: Object.freeze(detectedOptions),
      detectedAt: (options.now?.() ?? new Date()).toISOString(),
    }),
  };
};
