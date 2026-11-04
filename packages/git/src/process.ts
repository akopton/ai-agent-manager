import { spawn } from 'node:child_process';
import { GitCommandError } from './errors.js';
import { parseCommandOptions, type GitCommandOptions } from './schemas.js';

export type ProcessResult = { stdout: string; stderr: string; exitCode: number };

type RunProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Arguments reported in errors; defaults to `args`. */
  reportedArgs?: readonly string[];
};

const killGraceMs = 2_000;

/**
 * Runs an executable with an argument array (never through a shell), bounded by a timeout and a
 * combined stdout/stderr byte limit. Resolves for any exit code; rejects on start failure,
 * timeout, or output overflow.
 */
export const runProcess = (
  executable: string,
  args: readonly string[],
  { cwd, env, timeoutMs, maxOutputBytes, reportedArgs = args }: RunProcessOptions,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: Pick<GitCommandError, 'code' | 'message'> | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (code: GitCommandError['code'], message: string): void => {
      if (failure !== undefined) {
        return;
      }
      failure = { code, message };
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      killTimer.unref();
    };

    const timeout = setTimeout(
      () => terminate('GIT_TIMEOUT', `Git timed out after ${timeoutMs} ms.`),
      timeoutMs,
    );

    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (failure !== undefined) {
        return;
      }
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate('GIT_OUTPUT_LIMIT', `Git output exceeded ${maxOutputBytes} bytes.`);
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));

    const cleanUp = (): void => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
    };

    child.once('error', (error) => {
      cleanUp();
      reject(
        new GitCommandError(`Could not start ${executable}: ${error.message}`, {
          code: 'GIT_UNAVAILABLE',
          args: reportedArgs,
          exitCode: null,
          signal: null,
          stderr: '',
          cause: error,
        }),
      );
    });

    child.once('close', (exitCode, signal) => {
      cleanUp();
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (failure !== undefined || exitCode === null) {
        reject(
          new GitCommandError(
            failure?.message ?? `Git was terminated by ${signal ?? 'a signal'}.`,
            {
              code: failure?.code ?? 'GIT_FAILED',
              args: reportedArgs,
              exitCode,
              signal,
              stderr: stderrText,
            },
          ),
        );
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderrText, exitCode });
    });
  });

/**
 * Configuration forced on every inspection command. Passed through `GIT_CONFIG_COUNT` so keys and
 * values are never parsed from a combined string.
 */
const baseConfig: ReadonlyArray<readonly [string, string]> = [
  // Repository config could name an arbitrary fsmonitor command; `status` would execute it.
  ['core.fsmonitor', 'false'],
  // Inspection commands do not run hooks; this is defense in depth.
  ['core.hooksPath', '/dev/null'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
];

const buildEnvironment = (
  extraConfig: ReadonlyArray<readonly [string, string]>,
): NodeJS.ProcessEnv => {
  // Drop inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_*, ...) so the
  // caller's environment cannot redirect inspection to another repository or inject config.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  const config = [...baseConfig, ...extraConfig];
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return {
    ...env,
    GIT_CONFIG_COUNT: String(config.length),
    // Do not take optional locks or refresh the index on read commands.
    GIT_OPTIONAL_LOCKS: '0',
    // Never fetch missing objects of a partial clone from the network.
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    // Stable messages for the few cases where stderr is classified.
    LC_ALL: 'C',
    LANG: 'C',
  };
};

export type RunGitOptions = GitCommandOptions & {
  cwd: string;
  /** Additional config overrides for this command only. */
  config?: ReadonlyArray<readonly [string, string]>;
};

/** Runs a Git subcommand in `cwd` with the inspection safety environment. */
export const runGit = (args: readonly string[], options: RunGitOptions): Promise<ProcessResult> => {
  const { timeoutMs, maxOutputBytes } = parseCommandOptions(options);
  return runProcess('git', args, {
    cwd: options.cwd,
    env: buildEnvironment(options.config ?? []),
    timeoutMs,
    maxOutputBytes,
  });
};

/** Runs Git and requires exit code 0; any other exit is a `GIT_FAILED` error. */
export const runGitChecked = async (
  args: readonly string[],
  options: RunGitOptions,
): Promise<string> => {
  const result = await runGit(args, options);
  if (result.exitCode !== 0) {
    throw new GitCommandError(
      `git ${args[0] ?? ''} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
      {
        code: 'GIT_FAILED',
        args,
        exitCode: result.exitCode,
        signal: null,
        stderr: result.stderr,
      },
    );
  }
  return result.stdout;
};

/**
 * Checkout, `status`, and `worktree remove` may run clean/smudge filters named in repository config,
 * which an agent can modify. Returns overrides that neutralize every configured filter driver for
 * one command: an empty command disables the filter.
 */
export const readFilterOverrides = async (
  cwd: string,
  options: GitCommandOptions,
): Promise<Array<readonly [string, string]>> => {
  const result = await runGit(['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], {
    ...options,
    cwd,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new GitCommandError(`git config failed: ${result.stderr.trim()}`, {
      code: 'GIT_FAILED',
      args: ['config'],
      exitCode: result.exitCode,
      signal: null,
      stderr: result.stderr,
    });
  }
  const drivers = new Set(
    result.stdout
      .split('\0')
      .filter((key) => key.startsWith('filter.') && key.lastIndexOf('.') > 'filter'.length)
      .map((key) => key.slice('filter.'.length, key.lastIndexOf('.'))),
  );
  return [...drivers].flatMap((driver) => [
    [`filter.${driver}.clean`, ''] as const,
    [`filter.${driver}.smudge`, ''] as const,
    [`filter.${driver}.process`, ''] as const,
    [`filter.${driver}.required`, 'false'] as const,
  ]);
};
