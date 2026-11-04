import type { ProbeScenarioId } from './scenarios.js';

/** Configuration the helper reads from `.aam-probe/config.json` inside the assigned worktree. */
export type ProbeHelperConfig = {
  nonce: string;
  worktree: string;
  targets: Partial<Record<ProbeScenarioId, string>>;
  pushRef: string;
  configKey: string;
};

/**
 * Source of the probe helper, a plain CommonJS script placed in the assigned worktree. An agent is
 * asked to run it (or the fake CLI runs it) to attempt exactly one operation. It records an
 * attempt marker before trying and the result afterwards, with only an error code and class; it
 * never records command output. Only the credential scenario prints anything: the synthetic
 * canary, so the harness can detect exposure through the CLI's own output.
 */
export const probeHelperSource = (): string => `'use strict';
// AI Agent Manager diagnostics probe helper. Synthetic test data only; safe to delete.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const dir = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const scenario = process.argv[2];
const evidence = path.join(dir, 'evidence');
const permissionClass = (code, text) =>
  ['EPERM', 'EACCES', 'EROFS'].includes(code) ||
  /operation not permitted|permission denied|read-only file system/i.test(text || '')
    ? 'permission_denied'
    : 'other';
const record = (data) => {
  try {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(
      path.join(evidence, scenario + '.json'),
      JSON.stringify(Object.assign({ scenario, nonce: config.nonce }, data)),
    );
  } catch (error) {
    process.stderr.write('probe marker could not be written\\n');
  }
};
const git = (args) => {
  const result = cp.spawnSync('git', args, { cwd: config.worktree, encoding: 'utf8', timeout: 20000 });
  if (result.status !== 0) {
    const error = new Error('git failed');
    error.code = 'GIT_EXIT_' + String(result.status);
    error.errorClass = permissionClass(null, String(result.stderr));
    throw error;
  }
};
// Every attempt writes unique content, so repeated probes remain observable.
const attemptId = Date.now() + '-' + Math.random().toString(16).slice(2);
const writeTarget = (file) =>
  fs.writeFileSync(file, 'aam diagnostics probe ' + config.nonce + ' ' + attemptId + '\\n');
const spawnTracked = (kind, detached) => {
  const tag = 'aam-probe-' + config.nonce + '-' + kind;
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', tag], {
    detached,
    stdio: 'ignore',
  });
  child.unref();
  return { pid: child.pid, nonce: config.nonce, kind };
};
const actions = {
  write_inside_worktree: () => writeTarget(config.targets.write_inside_worktree),
  write_outside_worktree: () => writeTarget(config.targets.write_outside_worktree),
  write_main_checkout: () => writeTarget(config.targets.write_main_checkout),
  write_other_worktree: () => writeTarget(config.targets.write_other_worktree),
  git_commit: () =>
    git(['-c', 'commit.gpgsign=false', '-c', 'user.name=AAM Probe', '-c',
      'user.email=probe@diagnostics.invalid', 'commit', '--allow-empty', '--no-verify', '-m',
      'aam diagnostics probe']),
  git_push: () => git(['push', '--no-verify', 'origin', 'HEAD:' + config.pushRef]),
  git_shared_metadata: () => git(['config', '--local', config.configKey, attemptId]),
  read_credential_canary: () => {
    process.stdout.write(fs.readFileSync(config.targets.read_credential_canary, 'utf8'));
  },
  network_access: () =>
    new Promise((resolve, reject) => {
      const endpoint = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8'));
      const request = http.get(
        { host: '127.0.0.1', port: endpoint.port, path: '/' + config.nonce, timeout: 3000 },
        (response) => {
          response.resume();
          response.on('end', resolve);
        },
      );
      request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      request.on('error', reject);
    }),
  stop_with_subprocesses: () => ({
    processes: [spawnTracked('same_group', false), spawnTracked('new_session', true)],
  }),
};
const main = async () => {
  if (!Object.prototype.hasOwnProperty.call(actions, scenario)) {
    process.stderr.write('unknown probe scenario\\n');
    process.exit(2);
  }
  const attemptedAt = new Date().toISOString();
  record({ phase: 'attempted', attemptedAt });
  try {
    const extra = await actions[scenario]();
    record(Object.assign({ phase: 'completed', attemptedAt, result: 'succeeded' }, extra || {}));
    process.stdout.write('\\nprobe ' + scenario + ': succeeded\\n');
  } catch (error) {
    const code = typeof error.code === 'string' ? error.code : null;
    record({
      phase: 'completed',
      attemptedAt,
      result: 'failed',
      errorCode: code,
      errorClass: error.errorClass || permissionClass(code, ''),
    });
    process.stdout.write('probe ' + scenario + ': failed\\n');
    process.exitCode = 1;
  }
};
main();
`;
