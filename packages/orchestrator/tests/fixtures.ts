import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

// Fixture repositories are created only inside temporary directories, with global and system Git
// configuration disabled so the developer's settings cannot affect them.
const fixtureEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
});

/** Runs Git for fixture setup only. Never point this at a non-temporary directory. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: fixtureEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export const writeFile = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

/** Creates a repository on branch `main` with one commit. */
export const createRepository = (path: string): string => {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '--quiet', '--initial-branch=main', '.');
  writeFile(join(path, 'README.md'), 'fixture\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '--quiet', '-m', 'Initial commit');
  return realpathSync(path);
};

/** Runs `run` with a canonical temporary directory whose name contains spaces, then removes it. */
export const withFixtures = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-agent-manager gate fixture ')));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** Captures every file under `directory` with its size, mtime, and content. */
export const snapshot = (directory: string): Map<string, string> => {
  const entries = new Map<string, string>();
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      const stats = lstatSync(child);
      const content = entry.isSymbolicLink()
        ? `link:${readlinkSync(child)}`
        : readFileSync(child).toString('base64');
      entries.set(relative(directory, child), `${stats.size}:${stats.mtimeMs}:${content}`);
    }
  };
  visit(directory);
  return entries;
};

/** What the fake Codex CLI does after reading its prompt from stdin. */
export type FakeCodexBehavior = 'succeed' | 'hang';

/**
 * Writes a fake `codex` executable (a Node script) into `directory`. It answers `--version` and
 * `exec --help` like Codex 0.166.0, records its invocation, then behaves as `behavior.txt` says.
 * It never contacts a network or a real CLI.
 */
export const createFakeCodexCli = (directory: string) => {
  mkdirSync(directory, { recursive: true });
  const executablePath = join(directory, 'codex');
  const help = [
    'Usage: codex exec [OPTIONS] [PROMPT]',
    'Options:',
    '  -m, --model <MODEL>',
    '  -s, --sandbox <SANDBOX_MODE>',
    '      --ignore-user-config',
    '      --ignore-rules',
    '      --json',
    '',
  ].join('\n');
  writeFileSync(
    executablePath,
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const out = (text, code) => process.stdout.write(text, () => process.exit(code));
if (args[0] === '--version') out('codex-cli 0.166.0\\n', 0);
else if (args.includes('--help')) out(${JSON.stringify(help)}, 0);
else {
  let stdin = '';
  process.stdin.on('data', (chunk) => (stdin += chunk));
  process.stdin.on('end', () => {
    fs.writeFileSync(path.join(__dirname, 'invocation.json'), JSON.stringify({ args, cwd: process.cwd(), stdin }));
    const behavior = fs.readFileSync(path.join(__dirname, 'behavior.txt'), 'utf8');
    if (behavior === 'hang') { setInterval(() => {}, 1000); return; }
    const events = [
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'Done.' } },
      { type: 'turn.completed', usage: {} },
    ];
    out(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n', 0);
  });
}
`,
    { mode: 0o755 },
  );
  const setBehavior = (behavior: FakeCodexBehavior): void =>
    writeFileSync(join(directory, 'behavior.txt'), behavior);
  setBehavior('succeed');
  return {
    executablePath: realpathSync(executablePath),
    setBehavior,
    invocation: (): { args: string[]; cwd: string; stdin: string } =>
      JSON.parse(readFileSync(join(directory, 'invocation.json'), 'utf8')),
    wasStarted: (): boolean => existsSync(join(directory, 'invocation.json')),
  };
};
