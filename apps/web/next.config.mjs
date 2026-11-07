import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the native SQLite addon resolved from its installed package at runtime.
  serverExternalPackages: ['better-sqlite3'],
  turbopack: {
    root: fileURLToPath(new URL('../../', import.meta.url)),
  },
};

export default nextConfig;
