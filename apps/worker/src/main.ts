import { runWorker } from './run-worker.js';

// Execution is enabled for explicit operator start requests only. Agents still run only in
// Trusted Local Mode after the operator accepted the disclosure and trusted the project.
const { exitCode } = await runWorker({ execution: {} });
process.exitCode = exitCode;
