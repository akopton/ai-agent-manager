import js from '@eslint/js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const diagnosticsImports = [
  {
    name: '@ai-agent-manager/agents/diagnostics',
    message:
      'Diagnostics-only entry point: it starts processes without any authorization. Launch agents through startAgentExecution.',
  },
  {
    name: '@ai-agent-manager/cli-diagnostics',
    message: 'The CLI diagnostics harness is development tooling, not production code.',
  },
];
const trustedLocalIssuerImport = {
  name: '@ai-agent-manager/agents/trusted-local-issuer',
  message: 'Only the orchestrator Trusted Local gate may register Trusted Local authorizations.',
};
// Reaching into another package's sources bypasses its entry points (and the restrictions above).
const agentsInternals = {
  group: ['**/agents/src/**', '**/agents/dist/**'],
  message: 'Import @ai-agent-manager/agents through its package entry points.',
};
const trustedLocalGateFile = 'packages/orchestrator/src/trusted-local-gate.ts';

const webRequire = createRequire(new URL('./apps/web/package.json', import.meta.url));

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/.git/**',
    '**/.next/**',
    '**/next-env.d.ts',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/coverage/**',
    '**/.nyc_output/**',
    '**/.pnpm-store/**',
    '**/data/**',
    '**/logs/**',
    '**/tmp/**',
    '**/temp/**',
    '**/.agent-sessions/**',
    '**/.agent-worktrees/**',
    '**/.agent-logs/**',
    '**/.env*',
    '**/*.local',
    '**/*.log',
    '**/*.tsbuildinfo',
    '**/*.sqlite*',
    '**/*.db*',
    // Preserve experimental scripts rather than migrating them to production conventions.
    'poc/**',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      'prefer-const': 'error',
      'prefer-arrow-callback': ['error', { allowNamedFunctions: true, allowUnboundThis: true }],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'FunctionDeclaration[declare!=true]:not(ExportDefaultDeclaration > FunctionDeclaration)',
          message:
            'Prefer an arrow function assigned to const. Default-exported framework functions and TypeScript declarations are allowed.',
        },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.recommended],
    rules: { '@typescript-eslint/consistent-type-definitions': ['error', 'type'] },
  },
  // Restricted entry points. A later block replaces `no-restricted-imports` for its files, so each
  // block lists everything that stays forbidden there.
  {
    // The diagnostics harness and the supervisor entry point it uses are development tooling.
    // Production code launches agents only through `startAgentExecution`. The Trusted Local issuer
    // belongs to the orchestrator's Trusted Local gate alone.
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    ignores: ['packages/cli-diagnostics/**', trustedLocalGateFile],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...diagnosticsImports, trustedLocalIssuerImport], patterns: [agentsInternals] },
      ],
    },
  },
  {
    files: ['packages/cli-diagnostics/**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [trustedLocalIssuerImport], patterns: [agentsInternals] },
      ],
    },
  },
  {
    // SEC-02e smoke runner: launches real CLIs only through the Trusted Local gate and launch
    // boundary, so it must never load the unguarded supervisor or the fake-CLI/probe tooling.
    files: ['packages/cli-diagnostics/src/smoke/**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...diagnosticsImports, trustedLocalIssuerImport],
          patterns: [
            agentsInternals,
            {
              group: [
                '../fake-*',
                '../replay*',
                '../compatibility*',
                '../probes*',
                '../probe-helper*',
                '../processes*',
                '../evidence*',
                '../fixture.js',
                '../cli.js',
                '../index.js',
              ],
              message:
                'The smoke runner must not load the diagnostics fake-CLI, probe or supervisor modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [trustedLocalGateFile],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: diagnosticsImports, patterns: [agentsInternals] },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [nextVitals],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: {
      next: { rootDir: fileURLToPath(new URL('./apps/web/', import.meta.url)) },
      react: { version: webRequire('react/package.json').version },
    },
  },
  {
    files: ['**/*.d.{ts,mts,cts}'],
    rules: {
      // Ambient declarations and interface merging describe contracts, not implementations.
      'no-restricted-syntax': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
  prettier,
]);
