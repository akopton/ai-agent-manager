import { parseArgs } from 'node:util';
import { createTerminalApproval } from './approval.js';
import { smokeCheckIds, smokeChecks, smokeRuntimes } from './checks.js';
import { cleanupSmokeFixture, createSmokeFixture } from './fixture.js';
import { createSmokeRunner } from './runner.js';

// SEC-02e smoke entry point. Separate from the `diagnostics` CLI: this process never loads the
// unguarded diagnostics supervisor or fake CLI runner (ESLint and an import-graph test enforce it).

const usage = `Usage (SEC-02e Trusted Local smoke runs; see docs/trusted-local-smoke-runs.md):
  smoke prepare --parent DIR
  smoke run --manifest M --runtime ${smokeRuntimes.join('|')} --check ID
  smoke cleanup --manifest M [--include-results]
  smoke checks

Checks: ${smokeCheckIds.join(', ')}
"run" performs exactly one check after interactive approval and requires a terminal.`;

export type SmokeCommandIo = {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
};

const parse = (args: string[]) =>
  parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      parent: { type: 'string' },
      manifest: { type: 'string' },
      runtime: { type: 'string' },
      check: { type: 'string' },
      'include-results': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });

/** Runs one smoke command and returns the process exit code. */
export const runSmokeCommand = async (args: string[], io: SmokeCommandIo): Promise<number> => {
  const out = (line: string) => io.stdout.write(`${line}\n`);
  const err = (line: string) => io.stderr.write(`${line}\n`);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (error) {
    err(`${(error as Error).message}\n${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...extra] = positionals;
  if (values.help === true || command === undefined || extra.length > 0) {
    (values.help === true ? out : err)(usage);
    return values.help === true ? 0 : 2;
  }
  const allowed: Record<string, readonly string[]> = {
    prepare: ['parent'],
    run: ['manifest', 'runtime', 'check'],
    cleanup: ['manifest', 'include-results'],
    checks: [],
  };
  const permitted = allowed[command];
  if (permitted === undefined) {
    err(`Unknown command "${command}".\n${usage}`);
    return 2;
  }
  const unexpected = Object.keys(values).filter((name) => !permitted.includes(name));
  if (unexpected.length > 0) {
    err(`Option(s) not accepted by "${command}": ${unexpected.map((n) => `--${n}`).join(', ')}`);
    return 2;
  }

  switch (command) {
    case 'checks': {
      for (const check of Object.values(smokeChecks)) {
        const status =
          check.support.status === 'supported' ? 'supported' : `blocked: ${check.support.reason}`;
        out(`${check.id} [${check.covers.join(' ')}] ${status}\n  ${check.objective}`);
      }
      return 0;
    }
    case 'prepare': {
      if (values.parent === undefined) {
        err(
          'prepare requires --parent DIR (an existing private directory outside Git repositories).',
        );
        return 2;
      }
      const fixture = await createSmokeFixture(values.parent);
      out(`Smoke fixture created: ${fixture.manifest.paths.root}`);
      out(`Task worktree: ${fixture.manifest.paths.assignedWorktree}`);
      out(`Manifest: ${fixture.manifestPath}`);
      return 0;
    }
    case 'cleanup': {
      if (values.manifest === undefined) {
        err('cleanup requires --manifest M.');
        return 2;
      }
      const result = await cleanupSmokeFixture(values.manifest, {
        includeResults: values['include-results'] === true,
      });
      if (result.status === 'refused') {
        err(`Cleanup refused; nothing was removed:\n- ${result.reasons.join('\n- ')}`);
        return 1;
      }
      out(`Removed:\n- ${result.removed.join('\n- ') || '(nothing left to remove)'}`);
      return 0;
    }
    case 'run': {
      // Checked before anything else, so a non-interactive invocation never detects or runs a CLI.
      if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) {
        err(
          'smoke run requires an interactive terminal for the per-run approval. Nothing was run.',
        );
        return 2;
      }
      if (
        values.manifest === undefined ||
        values.runtime === undefined ||
        values.check === undefined
      ) {
        err('run requires --manifest M --runtime R --check ID.');
        return 2;
      }
      // SIGINT (Ctrl+C), SIGTERM and SIGHUP (terminal closed) all request a stop through the
      // AgentHandle. The CLI runs in its own process group, so without these handlers a signal
      // to the runner would orphan it and skip the integrity check and the report. Repeated
      // signals are acknowledged and ignored until the stop, check and report are done. Only
      // SIGKILL can bypass this (see the runbook's recovery procedure).
      const controller = new AbortController();
      let signals = 0;
      const onSignal = (signal: NodeJS.Signals) => {
        signals += 1;
        if (signals === 1) {
          err(
            `${signal} received: stopping through AgentHandle.stop(), then the Git integrity check and the report. Further signals are ignored until then.`,
          );
          controller.abort();
          return;
        }
        err(
          `${signal} ignored: still finishing the stop, integrity check and report. Please wait.`,
        );
      };
      const handledSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      for (const signal of handledSignals) process.on(signal, onSignal);
      try {
        const runner = createSmokeRunner({
          confirm: createTerminalApproval(io.stdin, io.stdout),
          verification: 'operator_supervised_real_cli',
          log: out,
        });
        const outcome = await runner({
          manifestPath: values.manifest,
          runtime: values.runtime,
          checkId: values.check,
          signal: controller.signal,
        });
        out(`Classification: ${outcome.classification}`);
        for (const reason of outcome.reasons) out(`- ${reason}`);
        if (outcome.report !== null) {
          out(`Integrity: ${outcome.report.integrity.status} (diagnostic only)`);
          out('Process containment: process_group_only (SEC-01)');
        }
        out(outcome.reportPath === null ? 'No report written.' : `Report: ${outcome.reportPath}`);
        out('The fixture is preserved. Remove it only after review: smoke cleanup --manifest M');
        return outcome.classification === 'pass' ? 0 : 1;
      } catch (error) {
        err(
          `The smoke runner failed before a report could be written: ${error instanceof Error ? error.message : String(error)}`,
        );
        err(
          'Treat the run as failed. The fixture is preserved. Before cleanup, check that no CLI process is left: ps -o pid,pgid,command -U "$USER"',
        );
        return 1;
      } finally {
        for (const signal of handledSignals) process.off(signal, onSignal);
      }
    }
  }
  return 2;
};
