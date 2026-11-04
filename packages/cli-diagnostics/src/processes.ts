import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A process started during a probe, identified by a nonce in its command line. */
export type TrackedProcess = { pid: number; nonce: string; kind: string };

/**
 * - `gone`: no process with this PID exists.
 * - `running`: the PID exists and its command line still contains the nonce (it is ours).
 * - `pid_reused`: the PID exists but belongs to another program, so ours is gone.
 * - `unverifiable`: the PID exists but its command line could not be read. It is **not** treated
 *   as gone, and it is never signalled.
 */
export type TrackedProcessLiveness = 'gone' | 'running' | 'pid_reused' | 'unverifiable';

export type TrackedProcessState =
  /** It was already gone (or its PID was reused). */
  | 'not_running'
  | 'terminated'
  /** Alive, but ownership could not be proven; left untouched. */
  | 'unverifiable'
  /** Still alive after SIGTERM and SIGKILL. */
  | 'survived';

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

type CommandLine = { state: 'absent' } | { state: 'present'; command: string } | { state: 'error' };

/** Reads the command line of `pid` with `ps`, distinguishing "no such process" from failure. */
export const readCommandLine = async (pid: number): Promise<CommandLine> => {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return { state: 'error' };
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], {
      timeout: 5_000,
    });
    const command = stdout.trim();
    return command === '' ? { state: 'absent' } : { state: 'present', command };
  } catch (error) {
    // `ps -p` exits with 1 and prints nothing when the PID does not exist.
    const failure = error as { code?: unknown; stdout?: unknown };
    return failure.code === 1 && typeof failure.stdout === 'string' && failure.stdout.trim() === ''
      ? { state: 'absent' }
      : { state: 'error' };
  }
};

/** Whether a tracked process is still running, judged by PID **and** nonce. */
export const inspectTrackedProcess = async (
  tracked: TrackedProcess,
): Promise<TrackedProcessLiveness> => {
  if (!isProcessAlive(tracked.pid)) {
    return 'gone';
  }
  const commandLine = await readCommandLine(tracked.pid);
  if (commandLine.state === 'absent') {
    return 'gone';
  }
  if (commandLine.state === 'error' || tracked.nonce.length < 16) {
    return 'unverifiable';
  }
  return commandLine.command.includes(tracked.nonce) ? 'running' : 'pid_reused';
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Terminates exactly one process, and only when its command line still contains the nonce the
 * harness gave it (guarding against PID reuse). Never signals process groups or matches by name.
 */
export const terminateTrackedProcess = async (
  tracked: TrackedProcess,
): Promise<TrackedProcessState> => {
  const liveness = await inspectTrackedProcess(tracked);
  if (liveness === 'gone' || liveness === 'pid_reused') {
    return 'not_running';
  }
  if (liveness === 'unverifiable') {
    return 'unverifiable';
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(tracked.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'terminated';
      return 'survived';
    }
    const deadline = Date.now() + 1_000;
    while (isProcessAlive(tracked.pid) && Date.now() < deadline) await delay(25);
    if (!isProcessAlive(tracked.pid)) {
      return 'terminated';
    }
  }
  return 'survived';
};
