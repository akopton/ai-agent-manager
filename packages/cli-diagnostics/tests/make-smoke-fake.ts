import { createSmokeFake, type FakeBehavior } from './smoke-fakes.js';

// Operator preflight helper (docs/trusted-local-smoke-runs.md §6.1): writes a fake `codex` into an
// empty directory so the real smoke command can be exercised in a real terminal without any
// provider. Usage: tsx --conditions=@ai-agent-manager/source tests/make-smoke-fake.ts DIR BEHAVIOR

const behaviors: readonly FakeBehavior[] = ['token', 'hang', 'hang-children'];
const [directory, behavior] = process.argv.slice(2);
if (directory === undefined || !behaviors.some((entry) => entry === behavior)) {
  process.stderr.write(`Usage: make-smoke-fake.ts DIR ${behaviors.join('|')}\n`);
  process.exit(2);
}
const fake = createSmokeFake(directory, 'codex');
fake.setBehavior(behavior as FakeBehavior);
process.stdout.write(`${fake.executablePath}\n`);
