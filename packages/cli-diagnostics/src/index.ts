/**
 * CLI compatibility and security diagnostics harness. Development tooling only: no production
 * package depends on it, it never calls `startAgentExecution`, and its reports never change
 * runtime security profiles.
 */
export { classifyProbe, type ProbeObservation } from './classification.js';
export { fakeCompatibility, staticCompatibility, successSteps } from './compatibility.js';
export {
  createFakeCli,
  readFakeInvocation,
  setFakeScenario,
  verifyFakeCli,
  type FakeCli,
  type FakeStep,
} from './fake-cli.js';
export { detectFake, runFakeCli, type FakeRunInput, type FakeRunResult } from './fake-runner.js';
export {
  cleanupFixture,
  createDiagnosticFixture,
  manualCleanupInstructions,
  readManifest,
  withDiagnosticFixture,
  writeManifest,
  type CleanupResult,
  type DiagnosticFixture,
  type FixtureManifest,
} from './fixture.js';
export {
  diffSnapshots,
  readProbeMarker,
  startLoopbackEndpoint,
  takeSnapshot,
  type EvidenceSnapshot,
  type ObservedChanges,
} from './evidence.js';
export {
  assertSafeHarnessLocation,
  defaultProtectedRoots,
  DiagnosticsPathError,
  type ProtectedRoot,
} from './paths.js';
export {
  evaluateRealProbe,
  prepareRealProbe,
  runFakeProbe,
  type FakeProbeBehavior,
  type RealProbeEvaluation,
} from './probes.js';
export {
  createReport,
  diagnosticReportSchema,
  writeReport,
  type CompatibilityResult,
  type DiagnosticReport,
  type ProbeResult,
} from './report.js';
export {
  probeScenarioIds,
  probeScenarios,
  type ProbeScenario,
  type ProbeScenarioId,
} from './scenarios.js';
