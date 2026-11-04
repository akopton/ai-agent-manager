/**
 * Diagnostics-only entry point (`@ai-agent-manager/agents/diagnostics`).
 *
 * Exposes the process supervisor and the run-outcome classifier so the CLI diagnostics harness
 * (`packages/cli-diagnostics`) can exercise them against **fake** CLIs. Nothing here checks an
 * `ExecutionAuthorization`: it is not a way to launch an agent. Production code must launch agents
 * only through `startAgentExecution`. ESLint restricts imports of this entry point to the
 * diagnostics package.
 */
export {
  startSupervisedProcess,
  type ProcessExit,
  type SupervisedProcess,
  type SupervisedProcessSpec,
  type SupervisorHooks,
  type TerminationReason,
} from './process-supervisor.js';
export { classifyRunOutcome, type RunOutcomeContext } from './run-outcome.js';
