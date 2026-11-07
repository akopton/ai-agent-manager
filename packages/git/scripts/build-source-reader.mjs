import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Build only application-owned C source. Never compile or execute repository-provided content.
const output = new URL('../native-dist/', import.meta.url);
mkdirSync(output, { recursive: true });
const result = spawnSync(
  '/usr/bin/cc',
  [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    fileURLToPath(new URL('../native/source-reader.c', import.meta.url)),
    '-o',
    fileURLToPath(new URL('source-reader', output)),
  ],
  { shell: false, stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
