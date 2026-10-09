import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Load DATABASE_URL from .env when present; an explicitly exported variable wins.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one real database, so test files must not run in parallel.
    // Concurrency *within* a test (e.g. simultaneous requests) is still fully possible.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
