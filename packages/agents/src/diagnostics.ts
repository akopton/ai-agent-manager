/**
 * Diagnostics-only entry point (`@ai-agent-manager/agents/diagnostics`).
 *
 * Exposes the process supervisor, the run-outcome classifier and the stdout line splitter so the
 * CLI diagnostics harness (`packages/cli-diagnostics`) can exercise them against **fake** CLIs and
 * replay captured output offline with production semantics.
 *
 * **Not protected by any security gate.** `startSupervisedProcess` spawns whatever executable,
 * arguments, `cwd` and environment it is given. It checks no authorization (Strict Isolated or
 * Trusted Local), no profile, no deny list and no executable identity. Production code must launch
 * agents only through `startAgentExecution`. ESLint forbids importing this entry point outside the
 * diagnostics package; that is a static import rule, not a runtime boundary (dynamic `import()`
 * and `require` are not covered). No application entry point (worker, web) depends on it.
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
export { createLineSplitter, type SplitLine } from './line-splitter.js';
