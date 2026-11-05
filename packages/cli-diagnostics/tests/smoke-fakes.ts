import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRuntime } from '@ai-agent-manager/core';
import { fakeHelpTexts, fakeVersionLines } from '../src/fake-cli.js';

// Fake Claude/Codex CLIs for the SEC-02e smoke runner tests. They answer --version/--help like the
// assessed versions, record each invocation (arguments, cwd, stdin digest, environment names),
// then act out one behavior. They never contact a network or a real provider.

export type FakeBehavior =
  /** Replies with the AAM-COMPAT-OK token found in the prompt. Writes a secret-looking stderr line. */
  | 'token'
  /** Creates the coding-edit target with the expected content. */
  | 'edit'
  /** The expected edit plus an unrequested file. */
  | 'edit-extra'
  /**
   * Claude only: a Write tool call whose result is an error (as observed with Claude Code 2.1.317
   * and the pre-SEC-02e.4 profile), a Read that completes, a tool with an unreportable name, then a
   * text reply and a successful result.
   */
  | 'write-denied'
  /** Commits on the task branch (an integrity violation). */
  | 'commit'
  /** Writes a key into the repository's common Git config (an integrity violation). */
  | 'config'
  /** Refuses the explicit model. */
  | 'model-error'
  /** Exits 3 without any output. */
  | 'crash'
  /** Emits session metadata, then never ends. */
  | 'hang'
  /** Emits session metadata, then floods stdout. */
  | 'flood'
  /**
   * Starts one child in its process group and one in a new session (escaping it, SEC-01), records
   * their PIDs next to the executable, emits session metadata, then never ends.
   */
  | 'hang-children';

export const stderrSecret = 'STDERR-SECRET-DO-NOT-REPORT';
export const assistantSecret = 'ASSISTANT-TEXT-DO-NOT-REPORT';

const source = (runtime: AgentRuntime): string => `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const runtime = ${JSON.stringify(runtime)};
const args = process.argv.slice(2);
const done = (text, code) => process.stdout.write(text, () => process.exit(code));
if (args[0] === '--version') done(${JSON.stringify(`${fakeVersionLines[runtime]}\n`)}, 0);
else if (args.includes('--help')) done(${JSON.stringify(fakeHelpTexts[runtime])}, 0);
else {
  let stdin = '';
  process.stdin.on('data', (chunk) => (stdin += chunk));
  process.stdin.on('end', () => {
    fs.appendFileSync(__filename + '.invocations.jsonl', JSON.stringify({
      args,
      cwd: process.cwd(),
      stdinSha256: 'sha256:' + crypto.createHash('sha256').update(stdin).digest('hex'),
      envNames: Object.keys(process.env).sort(),
    }) + '\\n');
    act(fs.readFileSync(__filename + '.behavior', 'utf8').trim(), stdin);
  });
}
function events(text, modelId) {
  if (runtime === 'claude') {
    return {
      init: { type: 'system', subtype: 'init', session_id: 'fake-session', model: modelId || 'fake-default-model' },
      message: { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      success: { type: 'result', subtype: 'success', is_error: false, result: text },
      modelError: { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'The model ' + modelId + ' was not found.' },
    };
  }
  return {
    init: { type: 'thread.started', thread_id: 'fake-thread' },
    message: { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } },
    success: { type: 'turn.completed', usage: {} },
    modelError: { type: 'turn.failed', error: { message: 'The model ' + modelId + ' was not found.' } },
  };
}
function emit(list, code) {
  done(list.map((event) => JSON.stringify(event)).join('\\n') + '\\n', code);
}
function git(...gitArgs) {
  execFileSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...gitArgs], { stdio: 'ignore' });
}
function act(behavior, stdin) {
  const modelIndex = args.indexOf('--model');
  const modelId = modelIndex >= 0 ? args[modelIndex + 1] : null;
  const token = (stdin.match(/AAM-COMPAT-OK-[0-9a-f]+/) || [''])[0];
  const e = events(${JSON.stringify(assistantSecret)} + ' ' + token, modelId);
  switch (behavior) {
    case 'token':
      process.stderr.write(${JSON.stringify(`${stderrSecret}\n`)});
      return emit([e.init, e.message, e.success], 0);
    case 'edit':
    case 'edit-extra':
      fs.writeFileSync(path.join(process.cwd(), 'src', 'greeting.ts'), "export const greeting = 'hello';\\n");
      if (behavior === 'edit-extra') fs.writeFileSync(path.join(process.cwd(), 'notes.txt'), 'extra\\n');
      return emit([e.init, e.message, e.success], 0);
    case 'write-denied': {
      if (runtime !== 'claude') return process.exit(9);
      const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
      const result = (id, isError, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });
      return emit([
        e.init,
        use('t1', 'Read', { file_path: path.join(process.cwd(), 'src', 'index.ts') }),
        result('t1', false, 'export const answer = 42;'),
        use('t2', 'Write', { file_path: path.join(process.cwd(), 'src', 'greeting.ts'), content: ${JSON.stringify(`${'FILE-CONTENT-DO-NOT-REPORT'}`)} }),
        result('t2', true, 'Permission for this tool use was denied. TOOL-OUTPUT-DO-NOT-REPORT'),
        use('t3', 'weird<tool>', {}),
        e.message,
        e.success,
      ], 0);
    }
    case 'commit':
      git('commit', '--allow-empty', '--quiet', '-m', 'agent commit');
      return emit([e.init, e.message, e.success], 0);
    case 'config':
      git('config', 'aamfake.key', 'value');
      return emit([e.init, e.message, e.success], 0);
    case 'model-error':
      return emit([e.init, e.modelError], 1);
    case 'crash':
      return process.exit(3);
    case 'hang':
      process.stdout.write(JSON.stringify(e.init) + '\\n');
      return setInterval(() => {}, 1000);
    case 'hang-children': {
      const keep = ['-e', 'setInterval(() => {}, 1000)', 'aam-smoke-fake-child'];
      const group = spawn(process.execPath, keep, { stdio: 'ignore' });
      const escaped = spawn(process.execPath, keep, { stdio: 'ignore', detached: true });
      escaped.unref();
      fs.writeFileSync(__filename + '.children.json', JSON.stringify({ group: group.pid, escaped: escaped.pid }));
      process.stdout.write(JSON.stringify(e.init) + '\\n');
      return setInterval(() => {}, 1000);
    }
    case 'flood': {
      process.stdout.write(JSON.stringify(e.init) + '\\n');
      const line = JSON.stringify(e.message) + '\\n';
      const pump = () => { while (process.stdout.write(line)) {} process.stdout.once('drain', pump); };
      return pump();
    }
    default:
      return process.exit(9);
  }
}
`;

export type SmokeFake = {
  runtime: AgentRuntime;
  executablePath: string;
  setBehavior: (behavior: FakeBehavior) => void;
  invocations: () => Array<{
    args: string[];
    cwd: string;
    stdinSha256: string;
    envNames: string[];
  }>;
  /** PIDs started by `hang-children`, or `null`. */
  children: () => { group: number; escaped: number } | null;
};

export const createSmokeFake = (directory: string, runtime: AgentRuntime): SmokeFake => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const executablePath = join(directory, runtime);
  writeFileSync(executablePath, source(runtime), { mode: 0o755 });
  const setBehavior = (behavior: FakeBehavior) =>
    writeFileSync(`${executablePath}.behavior`, behavior);
  setBehavior('token');
  const log = `${executablePath}.invocations.jsonl`;
  const children = `${executablePath}.children.json`;
  return {
    runtime,
    executablePath: realpathSync(executablePath),
    setBehavior,
    children: () =>
      existsSync(children)
        ? (JSON.parse(readFileSync(children, 'utf8')) as { group: number; escaped: number })
        : null,
    invocations: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as ReturnType<SmokeFake['invocations']>[number])
        : [],
  };
};
