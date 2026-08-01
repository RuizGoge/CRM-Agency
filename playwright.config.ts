import { defineConfig, devices } from '@playwright/test'

/**
 * Two fixed profiles, per `04b-design-system.md` §3.2. Performance budgets are
 * measured against these and nothing else — a budget measured on an unthrottled
 * developer laptop is a budget that passes everywhere except a seller's phone.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0, // A flaky money test is a failing money test.
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    locale: 'en-US',
  },
  projects: [
    {
      name: 'desktop-ci',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile-ci', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
})
