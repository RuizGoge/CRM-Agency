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
    // Both functional profiles ignore the perf spec: it owns its own profile
    // because its number is only meaningful under the 2x throttle, and running
    // it unthrottled here would produce a second, easier P6 that passes.
    {
      name: 'desktop-ci',
      testIgnore: /drag-perf\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile-ci', testIgnore: /drag-perf\.spec\.ts/, use: { ...devices['Pixel 7'] } },
    // `dnd-ci` is desktop-ci with a 2x CPU slowdown (04b §3.1), and the slowdown
    // is the point: it buys headroom so a green build means a comfortable 60 fps
    // on a seller's five-year-old laptop rather than on an idle CI runner.
    //
    // The throttle itself is applied per-test over CDP — Playwright has no
    // declarative CPU option — so the project exists to SELECT the specs and to
    // give the profile a name that matches the budget table.
    {
      name: 'dnd-ci',
      testMatch: /drag-perf\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        // The PRODUCTION build, on its own port. See the webServer note below.
        baseURL: 'http://localhost:3001',
      },
    },
  ],
  // TWO servers, and the second one is not a convenience.
  //
  // The functional specs run against `npm run dev`, which is what CI does and
  // what gives readable failures. THE PERFORMANCE SPEC MUST NOT. A Vite dev
  // server ships unminified modules, the HMR client, source maps and on-demand
  // transforms — measuring a drag against it measures the dev server, not the
  // product, and no seller ever loads any of it.
  //
  // This was found the hard way. P6 sat at a 33.3 ms baseline against a 34 ms
  // budget and passed 6 runs in 6 while a warm dev server happened to be reused.
  // Turning reuse off — for an unrelated and correct reason — made every run pay
  // a cold server's transforms and the gate fell to 1 pass in 4, with long tasks
  // of 54 to 89 ms that were Vite compiling, not the board dragging.
  //
  // P12 already measures the production bundle. P6 measuring `npm run dev` was
  // the inconsistency; this removes it.
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://localhost:3000',
      // NEVER reuse, and this cost four seconds a run to buy back a false green
      // that had already fooled a mutation test twice.
      //
      // With `!process.env.CI` this reused whatever was listening on :3000. An
      // orphaned dev server — and they survive on this machine, which is how one
      // was found still running a folded job dispatcher — serves the code it was
      // started with. Two mutations that should have turned the drag gate red
      // passed against it, and the conclusion very nearly drawn was "the gate
      // has no teeth" rather than "the mutation never reached the browser".
      //
      // A suite that sometimes tests the working tree and sometimes tests
      // whatever was open is not a suite.
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The production build, on its own port, for the performance profile.
      command: 'npm run build && npm start',
      url: 'http://localhost:3001',
      env: {
        PORT: '3001',
        // `npm start` is react-router-serve, which does NOT read `.env` — only
        // `npm run dev` does, through Vite. The G4(a) and JOBS002 refusals both
        // caught that immediately, which is them working.
        DATABASE_URL:
          process.env['DATABASE_URL'] ??
          'postgresql://crm_app:crm_app_dev_only@localhost:5432/crm_dev',
        SESSION_SECRET: process.env['SESSION_SECRET'] ?? 'e2e-only-not-a-production-secret',
        // NO WORKER ROLE, deliberately. This process exists to be measured, and
        // a dispatcher tick landing mid-drag is noise in the one number the
        // profile is here to produce. The folded topology is exercised by the
        // dev server and by its own tests.
        PROCESS_ROLES: 'web',
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
