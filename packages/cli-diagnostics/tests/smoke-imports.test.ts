import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Regression check for SEC-02e: the smoke entry point must not reach the unguarded diagnostics
// supervisor (`@ai-agent-manager/agents/diagnostics`), the Trusted Local issuer, or the harness's
// fake-CLI/probe modules through any static import path, including through workspace packages.

const packagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const smokeEntry = join(packagesRoot, 'cli-diagnostics/src/smoke/main.ts');

const staticSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  const pattern =
    /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
};

const workspaceEntry = (specifier: string): string | null => {
  const match = /^@ai-agent-manager\/([^/]+)(\/.+)?$/.exec(specifier);
  if (match?.[1] === undefined) return null;
  const packageDirectory = join(packagesRoot, match[1]);
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
    exports: Record<string, Record<string, string>>;
  };
  const entry = manifest.exports[match[2] === undefined ? '.' : `.${match[2]}`];
  const source = entry?.['@ai-agent-manager/source'];
  assert.ok(source !== undefined, `no source export for ${specifier}`);
  return join(packageDirectory, source);
};

const resolveRelative = (from: string, specifier: string): string => {
  const candidate = resolve(dirname(from), specifier).replace(/\.js$/, '.ts');
  assert.ok(existsSync(candidate), `cannot resolve ${specifier} from ${from}`);
  return candidate;
};

/** Every source file reachable from `entry`, plus every bare specifier seen. */
const walk = (entry: string) => {
  const files = new Set<string>();
  const bare = new Set<string>();
  const dynamic: string[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    if (/\bimport\s*\(|\brequire\s*\(/.test(source)) dynamic.push(file);
    for (const specifier of staticSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        pending.push(resolveRelative(file, specifier));
        continue;
      }
      bare.add(specifier);
      const workspace = workspaceEntry(specifier);
      if (workspace !== null) pending.push(workspace);
    }
  }
  return { files, bare, dynamic };
};

test('the smoke entry point cannot statically reach the unguarded supervisor or fake tooling', () => {
  const { files, bare } = walk(smokeEntry);
  const reached = [...files].map((file) => relative(packagesRoot, file));
  assert.ok(reached.includes('orchestrator/src/trusted-local-gate.ts'));
  assert.ok(reached.includes('agents/src/execution-launch.ts'));
  assert.ok(!bare.has('@ai-agent-manager/agents/diagnostics'));
  assert.ok(!reached.includes('agents/src/diagnostics.ts'));
  assert.ok(!reached.some((file) => file.startsWith('cli-diagnostics/tests/')));
  const harnessFiles = reached.filter((file) => file.startsWith('cli-diagnostics/src/'));
  const allowed = new Set([
    'cli-diagnostics/src/owned-directory.ts',
    'cli-diagnostics/src/paths.ts',
    'cli-diagnostics/src/fixture-git.ts',
  ]);
  for (const file of harnessFiles) {
    assert.ok(
      file.startsWith('cli-diagnostics/src/smoke/') || allowed.has(file),
      `smoke reaches ${file}`,
    );
  }
  // The issuer is reachable only through the orchestrator gate, never from smoke code itself.
  const smokeSources = harnessFiles.map((file) => readFileSync(join(packagesRoot, file), 'utf8'));
  assert.ok(smokeSources.every((source) => !source.includes('trusted-local-issuer')));
});

test('smoke sources use no dynamic import or require', () => {
  const { dynamic } = walk(smokeEntry);
  const smoke = dynamic.filter((file) =>
    relative(packagesRoot, file).startsWith('cli-diagnostics/'),
  );
  assert.deepEqual(smoke, []);
});
