import { spawn } from 'node:child_process';
import type { LingeringProcessState } from './contract.js';
import { createLineSplitter, type SplitLine } from './line-splitter.js';

export type TerminationReason = 'requested' | 'timeout' | 'output_limit' | 'event_handler_failed';

export type SupervisedProcessSpec = {
  executablePath: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. */
  stdin: string;
  timeoutMs?: number;
  /** Delay between SIGTERM and SIGKILL. */
  stopGraceMs: number;
  /** Total stdout bytes before the process is terminated with `output_limit`. */
  maxStdoutBytes: number;
  maxLineBytes: number;
};

export type SupervisorHooks = {
  onStarted: (pid: number, processGroupId: number | null) => void;
  onStdoutLine: (line: SplitLine) => void;
  onStderrLine: (line: SplitLine) => void;
  onTerminating: (reason: TerminationReason) => void;
};

export type ProcessExit = {
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: Error | null;
  /** Why AI Agent Manager terminated the process, or `null` when it exited by itself. */
  termination: TerminationReason | null;
  stdoutBytes: number;
  stderrBytes: number;
  lingeringProcesses: LingeringProcessState;
};

export type SupervisedProcess = {
  pid: number | null;
  terminate: (reason: TerminationReason) => void;
  exited: Promise<ProcessExit>;
};

/**
 * Whether stop, timeout and cleanup can signal the CLI's process group on this platform. Trusted
 * Local launches are refused where they cannot (`process_group_stop` safeguard).
 */
export const supervisorUsesProcessGroups = process.platform !== 'win32';
const pollIntervalMs = 25;
/** How long to wait for stdio to close after the process and its group are gone. */
const streamCloseTimeoutMs = 2_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts one process with an argument array (`shell: false`) and supervises it:
 *
 * - On POSIX it leads its own process group, so stop signals reach the descendants that stay in
 *   the group. Descendants that create their own session or group are **not** reached.
 * - `terminate` sends SIGTERM to the group, then SIGKILL after `stopGraceMs`. It is idempotent;
 *   the first reason wins.
 * - After the main process exits, processes still in its group are terminated the same way and
 *   reported as `lingeringProcesses: 'terminated'` (or `'unknown'` if they survive SIGKILL).
 *   `'none'` only means the group is empty: a descendant that called `setsid`/`setpgid` (for
 *   example a daemonizing tool) survives stop and timeout and is reported nowhere. There is no
 *   process-tree tracking; containing such descendants needs an OS-level mechanism.
 * - Hook exceptions terminate the process with `event_handler_failed`.
 * - `exited` never rejects.
 */
export const startSupervisedProcess = (
  spec: SupervisedProcessSpec,
  hooks: SupervisorHooks,
): SupervisedProcess => {
  const child = spawn(spec.executablePath, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    detached: supervisorUsesProcessGroups,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pid = child.pid ?? null;
  const processGroupId = supervisorUsesProcessGroups ? pid : null;
  let termination: TerminationReason | null = null;
  let mainExited = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutClosed = false;
  const timers: NodeJS.Timeout[] = [];
  const stdoutLines = createLineSplitter(spec.maxLineBytes);
  const stderrLines = createLineSplitter(spec.maxLineBytes);

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (pid === null) {
      return;
    }
    try {
      if (processGroupId !== null) {
        process.kill(-processGroupId, signal);
      } else if (!mainExited) {
        child.kill(signal);
      }
    } catch {
      // ESRCH: nothing left to signal.
    }
  };

  const groupAlive = (): boolean => {
    if (processGroupId === null) {
      return false;
    }
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error) {
      // EPERM means a process exists in the group but cannot be signalled.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };

  const terminate = (reason: TerminationReason): void => {
    if (termination !== null || mainExited) {
      return;
    }
    termination = reason;
    try {
      hooks.onTerminating(reason);
    } catch {
      // Already terminating; a failing hook cannot change the outcome.
    }
    signalGroup('SIGTERM');
    const escalation = setTimeout(() => signalGroup('SIGKILL'), spec.stopGraceMs);
    escalation.unref();
    timers.push(escalation);
  };

  const guard =
    <Args extends unknown[]>(hook: (...args: Args) => void) =>
    (...args: Args): void => {
      try {
        hook(...args);
      } catch {
        terminate('event_handler_failed');
      }
    };
  const onStdoutLine = guard(hooks.onStdoutLine);
  const onStderrLine = guard(hooks.onStderrLine);

  child.stdout.on('data', (chunk: Buffer) => {
    if (stdoutClosed) {
      return;
    }
    stdoutBytes += chunk.length;
    if (stdoutBytes > spec.maxStdoutBytes) {
      stdoutClosed = true;
      terminate('output_limit');
      return;
    }
    for (const line of stdoutLines.push(chunk)) onStdoutLine(line);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    for (const line of stderrLines.push(chunk)) onStderrLine(line);
  });
  // The CLI may exit before reading the prompt; a broken pipe is not a supervisor error.
  child.stdin.on('error', () => undefined);

  if (spec.timeoutMs !== undefined) {
    const timeout = setTimeout(() => terminate('timeout'), spec.timeoutMs);
    timeout.unref();
    timers.push(timeout);
  }

  const reapGroup = async (): Promise<LingeringProcessState> => {
    if (!groupAlive()) {
      return 'none';
    }
    signalGroup('SIGTERM');
    const deadline = Date.now() + spec.stopGraceMs;
    while (groupAlive() && Date.now() < deadline) await delay(pollIntervalMs);
    if (groupAlive()) {
      signalGroup('SIGKILL');
      const killDeadline = Date.now() + 1_000;
      while (groupAlive() && Date.now() < killDeadline) await delay(pollIntervalMs);
    }
    return groupAlive() ? 'unknown' : 'terminated';
  };

  const streamsClosed = new Promise<void>((resolve) => {
    if (pid === null) {
      resolve();
      return;
    }
    child.once('close', () => resolve());
  });

  const exited = new Promise<ProcessExit>((resolve) => {
    const finish = (exit: Omit<ProcessExit, 'stdoutBytes' | 'stderrBytes' | 'termination'>) => {
      for (const timer of timers) clearTimeout(timer);
      if (!stdoutClosed) {
        const rest = stdoutLines.flush();
        if (rest !== null) onStdoutLine(rest);
      }
      const restErr = stderrLines.flush();
      if (restErr !== null) onStderrLine(restErr);
      resolve({ ...exit, termination, stdoutBytes, stderrBytes });
    };

    child.once('error', (error) => {
      if (pid !== null) {
        return;
      }
      mainExited = true;
      finish({
        pid,
        exitCode: null,
        signal: null,
        spawnError: error,
        lingeringProcesses: 'none',
      });
    });

    child.once('exit', (exitCode, signal) => {
      mainExited = true;
      void (async () => {
        const lingeringProcesses = await reapGroup();
        await Promise.race([streamsClosed, delay(streamCloseTimeoutMs)]);
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ pid, exitCode, signal, spawnError: null, lingeringProcesses });
      })();
    });
  });

  if (pid !== null) {
    child.once(
      'spawn',
      guard(() => hooks.onStarted(pid, processGroupId)),
    );
    child.stdin.end(spec.stdin);
  }

  return { pid, terminate, exited };
};
