import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // E2E belongs to Playwright; it must never run under Vitest.
    exclude: ['node_modules/**', 'build/**', 'tests/e2e/**'],
  },
})
