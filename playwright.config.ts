import { defineConfig, devices } from '@playwright/test'

/**
 * Two fixed profiles, per `04b-design-system.md` §3.2. Performance budgets are
 * measured against these and nothing else — a budget measured on an unthrottled
 * developer laptop is a budget that passes everywhere except a seller's phone.
 */
export default defineConfig({
  testDir: './tests/e2e',

  // ONE worker, and this is not a performance compromise being apologised for.
  //
  // Every test signs into the SAME demo tenant and several of them move a card,
  // so parallel workers — and the two profiles, which also run concurrently —
  // fight over the same board. The first run of this suite proved it: one test
  // moved the card another had just opened a move sheet for, and the second got
  // the refusal instead of the undo bar. Red, for a reason that had nothing to
  // do with the product.
  //
  // A per-test tenant would buy the parallelism back. It is not worth it yet:
  // the suite is deliberately small because CI cost control here is the absence
  // of a payment method (§9.4.1), and a flaky accessibility gate is a gate that
  // gets deleted rather than fixed.
  fullyParallel: false,
  workers: 1,

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
