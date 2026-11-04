import { defineConfig } from 'drizzle-kit';
import { resolveDatabasePath } from './src/config.js';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url: resolveDatabasePath() },
});
