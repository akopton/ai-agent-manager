import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isWithin } from './paths.js';

const execFileAsync = promisify(execFile);

/** Fixed identity and dates make the fixture's base commit SHA reproducible. */
export const fixtureCommitIdentity = Object.freeze({
  name: 'AAM Diagnostics Fixture',
  email: 'fixture@diagnostics.invalid',
  date: '2026-01-01T00:00:00Z',
});

/**
 * Environment for the harness's own Git commands: no system or global configuration (the
 * developer's settings, hooks, credential helpers and signing cannot apply), no prompts, fixed
 * identity and dates, and no inherited `GIT_*` overrides.
 */
const fixtureGitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  LC_ALL: 'C',
  LANG: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: fixtureCommitIdentity.name,
  GIT_AUTHOR_EMAIL: fixtureCommitIdentity.email,
  GIT_AUTHOR_DATE: fixtureCommitIdentity.date,
  GIT_COMMITTER_NAME: fixtureCommitIdentity.name,
  GIT_COMMITTER_EMAIL: fixtureCommitIdentity.email,
  GIT_COMMITTER_DATE: fixtureCommitIdentity.date,
});

export type FixtureGitResult = { exitCode: number; stdout: string };

/**
 * Runs Git for fixture setup and evidence collection. Refuses any `cwd` outside the fixture root,
 * so it can never be pointed at a real repository. Hooks are disabled for every command.
 */
export const runFixtureGit = async (
  fixtureRoot: string,
  cwd: string,
  args: readonly string[],
): Promise<FixtureGitResult> => {
  if (!isWithin(fixtureRoot, cwd)) {
    throw new Error(`Refusing to run Git outside the fixture root: ${cwd}`);
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd, env: fixtureGitEnvironment(), maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
    );
    return { exitCode: 0, stdout };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (typeof failure.code === 'number') {
      return {
        exitCode: failure.code,
        stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      };
    }
    throw error;
  }
};

export const runFixtureGitChecked = async (
  fixtureRoot: string,
  cwd: string,
  args: readonly string[],
): Promise<string> => {
  const result = await runFixtureGit(fixtureRoot, cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`Fixture git ${args[0] ?? ''} failed with exit code ${result.exitCode}.`);
  }
  return result.stdout;
};
