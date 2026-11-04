import js from '@eslint/js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
  {
    // The diagnostics harness and the supervisor entry point it uses are development tooling.
    // Production code launches agents only through `startAgentExecution`.
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    ignores: ['packages/cli-diagnostics/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@ai-agent-manager/agents/diagnostics',
              message: 'Diagnostics-only entry point; launch agents through startAgentExecution.',
            },
            {
              name: '@ai-agent-manager/cli-diagnostics',
              message: 'The CLI diagnostics harness is development tooling, not production code.',
            },
          ],
        },
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
