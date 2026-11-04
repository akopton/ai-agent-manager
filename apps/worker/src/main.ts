import { runWorker } from './run-worker.js';

const { exitCode } = await runWorker();
process.exitCode = exitCode;
