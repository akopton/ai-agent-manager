import { createHash } from 'node:crypto';

/**
 * Variables every CLI child receives when present in the source environment. Everything else is
 * dropped, notably `GIT_*` overrides, `SSH_AUTH_SOCK` (the SSH agent would allow pushes), cloud
 * credentials, and API keys. Dropping them reduces exposure; it is **not** credential isolation,
 * because the child can still read credential files on disk.
 */
const baseVariableNames = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
] as const;

/** Variables forced on every child: no colors, no pagers, no Git credential prompts. */
const forcedVariables: Readonly<Record<string, string>> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * Builds a child environment from an allow list. `runtimeVariableNames` adds runtime-specific
 * configuration locations (never API keys: API-key authentication is not supported yet).
 */
export const buildChildEnvironment = (
  source: NodeJS.ProcessEnv,
  runtimeVariableNames: readonly string[],
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [...baseVariableNames, ...runtimeVariableNames]) {
    const value = source[name];
    if (typeof value === 'string' && value.length > 0 && !value.includes('\0')) {
      environment[name] = value;
    }
  }
  return { ...environment, ...forcedVariables };
};

/**
 * `sha256:<hex>` over the complete environment, sorted by name. Binds the environment in an
 * authorization without storing values (which may include paths of the user's machine).
 */
export const digestEnvironment = (environment: NodeJS.ProcessEnv): string => {
  const entries = Object.entries(environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`;
};
