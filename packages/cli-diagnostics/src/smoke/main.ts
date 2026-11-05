import { runSmokeCommand } from './cli.js';

// Process entry of `pnpm --filter @ai-agent-manager/cli-diagnostics smoke <command>`.

// A closed terminal or pipe must not crash the runner mid-run (EPIPE/EIO on write): the stop,
// the integrity check and the report must still happen. Output is then lost, the report is not.
const ignoreStreamError = (): void => undefined;
process.stdout.on('error', ignoreStreamError);
process.stderr.on('error', ignoreStreamError);
runSmokeCommand(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
