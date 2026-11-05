import { createDatabase } from '@ai-agent-manager/database';
import { createExecutionService } from '../src/execution/execution-service.js';

// Child-process worker for the crash test: claims pending start requests, then waits to be killed
// with SIGKILL (no shutdown, no lease release). Arguments: one JSON object.
const { databasePath, worktreeRoot, codexPath } = JSON.parse(process.argv[2] ?? '{}') as {
  databasePath: string;
  worktreeRoot: string;
  codexPath: string;
};
const connection = createDatabase({ path: databasePath });
const service = createExecutionService({
  db: connection.db,
  logger: { info: () => undefined, error: () => undefined },
  worktreeRoot,
  pollIntervalMs: 25,
  leaseTtlMs: 300,
  runTimeoutMs: 60_000,
  limits: { stopGraceMs: 300 },
  detectionOptions: { codex: { executablePath: codexPath } },
});
await service.start();
setInterval(() => void service.tick(), 25);
process.stdout.write('ready\n');
