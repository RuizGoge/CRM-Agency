import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // E2E belongs to Playwright; it must never run under Vitest.
    exclude: ['node_modules/**', 'build/**', 'tests/e2e/**'],
    // Drops and rebuilds `crm_test`, then applies the real migration files.
    // It throws rather than skipping when no database is reachable: a suite
    // that skips itself is how a gate quietly becomes a comment.
    globalSetup: ['tests/integration/setup/global-setup.ts'],
    // The silo suite mutates cluster-wide grants and policies through
    // harden(). Running files in parallel against one database would let them
    // observe each other's hardening runs.
    fileParallelism: false,
  },
})
