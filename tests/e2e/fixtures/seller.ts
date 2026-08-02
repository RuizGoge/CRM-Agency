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

export async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(DEMO_SELLER.email)
  await page.getByLabel('Password').fill(DEMO_SELLER.password)
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
