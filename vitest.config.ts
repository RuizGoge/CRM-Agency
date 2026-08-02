import { defineConfig } from 'vitest/config'

// Extensionless on purpose: tsc rejects a .ts specifier without
// allowImportingTsExtensions, and duplicating the URL derivation here so the
// two could drift is worse than Vite's forward-compatibility notice.
import { TEST_URL } from './tests/integration/setup/urls'

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
    // The suite exercises the real `withTenant`, which reads DATABASE_URL at
    // module load. Pointing it at crm_test here is what keeps the integration
    // tests off the development database.
    env: { DATABASE_URL: TEST_URL },
    // The silo suite mutates cluster-wide grants and policies through
    // harden(). Running files in parallel against one database would let them
    // observe each other's hardening runs.
    fileParallelism: false,
  },
})
