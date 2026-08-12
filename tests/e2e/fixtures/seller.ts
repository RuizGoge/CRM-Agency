import { type Page } from '@playwright/test'

import { expectCount } from './clock'

/**
 * The demo tenant, signed into through the real form.
 *
 * Not a seeded cookie and not a direct call to better-auth: the sign-in screen
 * is one of the four surfaces under test, and a helper that bypasses it would
 * leave the only unauthenticated screen in the product exercised by nothing.
 * It also keeps the fixture honest about the defect that produced the seed's
 * accent folding — `<input type="email">` refuses to POST an address it
 * considers malformed, with no error the page can show.
 */
export const DEMO_SELLER = {
  email: 'renata@demo.test',
  password: 'demo-password-1234',
  displayName: 'Renata',
} as const

/**
 * The demo tenant's admin. Seeded on 2026-08-12, because until then every
 * seeded user was a `seller` and `/admin/integration-health` had no possible
 * viewer — the surface existed, was tested, and nobody could open it.
 */
export const DEMO_ADMIN = {
  email: 'valeria@demo.test',
  password: 'demo-password-1234',
  displayName: 'Valeria',
} as const

export async function signIn(page: Page): Promise<void> {
  await signInAs(page, DEMO_SELLER)
}

export async function signInAsAdmin(page: Page): Promise<void> {
  await signInAs(page, DEMO_ADMIN)
}

async function signInAs(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // The shell only exists once a session does, so this doubles as the
  // assertion that the sign-in actually took.
  //
  // Driver-side, because several callers fake the page clock before signing in
  // and Playwright's own auto-waiting polls from inside the page. It happens to
  // work today — the sign-in POST is a full navigation, which `click()` waits
  // out — but "happens to work because of how the submit was dispatched" is
  // exactly the accident that made the undo spec fail somewhere else.
  await expectCount(page.getByRole('navigation', { name: 'Main' }), 1)
}
