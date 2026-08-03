import { expect, test } from '@playwright/test'

import { signIn } from './fixtures/seller'

/**
 * The four-item first-run checklist — US-9.14 and `FirstRunChecklist` (C-41).
 *
 * The rule worth a test is the one that removes a control: **every item checks
 * off by itself.** US-9.14 says *"without a manual 'mark done' click"* and
 * C-41 says *"there is no 'mark done' control"* — twice, because a checklist a
 * seller can tick is a checklist that reports "verified" about a calling
 * number nobody verified, on the one screen an owner reads as a setup report.
 *
 * That is not enforceable by a type. The control's absence is a fact about the
 * rendered DOM, so the DOM is where it is asserted.
 */
test.describe('the first-run checklist checks itself off', () => {
  const LABELS = [
    'Test your calling number',
    'Set up your stages',
    'Import your book',
    'Turn on desktop alerts',
  ] as const

  test('renders the four ratified items, in order', async ({ page }) => {
    await signIn(page)
    await page.goto('/my-day')

    const checklist = page.getByRole('region', { name: 'Get set up' })
    await expect(checklist).toBeVisible()

    const rows = checklist.getByRole('listitem')
    await expect(rows).toHaveCount(4)
    for (const [index, label] of LABELS.entries()) {
      await expect(rows.nth(index)).toContainText(label)
    }
  })

  test('offers no way to mark an item done by hand', async ({ page }) => {
    await signIn(page)
    await page.goto('/my-day')

    const checklist = page.getByRole('region', { name: 'Get set up' })
    await expect(checklist).toBeVisible()

    // THE ASSERTION THIS FILE EXISTS FOR. Not "the label says Done" — that a
    // screenshot could fake — but that nothing on the surface can set it.
    await expect(checklist.locator('input[type="checkbox"]')).toHaveCount(0)
    await expect(checklist.getByRole('checkbox')).toHaveCount(0)
    await expect(checklist.getByRole('button', { name: /mark|done|complete/i })).toHaveCount(0)
  })

  test('auto-checks the items whose condition the seller already meets', async ({ page }) => {
    await signIn(page)
    await page.goto('/my-day')

    const checklist = page.getByRole('region', { name: 'Get set up' })
    await expect(checklist).toBeVisible()

    // Read from the seeded tenant, not hardcoded: this seller owns stages with
    // an earning column and owns contacts, so items 2 and 3 are done and
    // nobody clicked anything to make that true.
    await expect(
      checklist.getByRole('listitem').filter({ hasText: 'Set up your stages' }),
    ).toContainText('Done')
    await expect(
      checklist.getByRole('listitem').filter({ hasText: 'Import your book' }),
    ).toContainText('Done')

    // Item 1 is NOT done, and it must not be: `aloware_number_mapping` does
    // not exist, so no seller anywhere has a verified calling number. A green
    // tick here would be the checklist telling a seller they can dial.
    const number = checklist.getByRole('listitem').filter({ hasText: 'Test your calling number' })
    await expect(number).not.toContainText('Done')
    await expect(number).toContainText(/Not verified/)
  })

  test('the count follows the conditions rather than a constant', async ({ page }) => {
    // The count is derived, so moving a condition must move it. Item 1 is the
    // one that cannot move on its own — `aloware_number_mapping` does not
    // exist — so the SETUP READ is stubbed to say it did. That is stubbing the
    // server, not the component: everything the component does with the answer
    // is the real code path.
    await signIn(page)
    await page.route('**/api/home-setup*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          isSeller: true,
          numberVerified: true,
          stagesConfigured: true,
          bookImported: true,
        }),
      }),
    )
    await page.goto('/my-day')

    const checklist = page.getByRole('region', { name: 'Get set up' })
    await expect(checklist).toBeVisible()
    await expect(checklist.getByText('3 of 4')).toBeVisible()
    await expect(
      checklist.getByRole('listitem').filter({ hasText: 'Test your calling number' }),
    ).toContainText('Done')
  })

  test('collapses when all four are done', async ({ page }) => {
    // US-9.14's last criterion, and the only way to reach it in this build.
    //
    // ⚠️ THE BROWSER IS STUBBED HERE, and the reason is measured rather than
    // assumed: headless Chromium reports `Notification.permission === 'denied'`
    // no matter what, and `context.grantPermissions(['notifications'])` does
    // not move it — probed before this spec was written. So item 4 cannot
    // reach `granted` in this environment by any legitimate route, and with it
    // stuck the collapse rule would ship asserted by nothing.
    //
    // Said plainly: what is proven here is that the component collapses when
    // it is told all four conditions hold. That a real browser reports
    // `granted` after a real grant is NOT proven by this suite.
    await signIn(page)
    await page.addInitScript(() => {
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: { permission: 'granted', requestPermission: () => Promise.resolve('granted') },
      })
    })
    await page.route('**/api/home-setup*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          isSeller: true,
          numberVerified: true,
          stagesConfigured: true,
          bookImported: true,
        }),
      }),
    )
    await page.goto('/my-day')

    // My Day is up, so this is a collapse and not a screen that failed to load.
    await expect(page.getByRole('heading', { name: 'My Day' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Get set up' })).toHaveCount(0)
  })

  test('offers the browser prompt only where the browser would still answer', async ({ page }) => {
    // `default` is the only state in which a prompt can appear. Once a seller
    // has answered, the browser will not ask again, so the honest thing left
    // is the sentence naming what they lose — flow row 8's exact words.
    await signIn(page)
    await page.addInitScript(() => {
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: { permission: 'default', requestPermission: () => Promise.resolve('default') },
      })
    })
    await page.goto('/my-day')

    const alerts = page
      .getByRole('region', { name: 'Get set up' })
      .getByRole('listitem')
      .filter({ hasText: 'Turn on desktop alerts' })

    await expect(alerts.getByRole('button', { name: 'Turn on' })).toBeVisible()
    await expect(alerts).not.toContainText('Desktop alerts are off')
  })

  test('every row is a 44px target', async ({ page }) => {
    // `04b` C-41, and CI check R2-11. Mobile is the contact surface and this
    // list is read one-handed; a 32px row here is a mis-tap on the screen a
    // seller sees once and never returns to.
    await signIn(page)
    await page.goto('/my-day')

    const rows = page.getByRole('region', { name: 'Get set up' }).getByRole('listitem')
    await expect(rows).toHaveCount(4)

    for (let i = 0; i < 4; i++) {
      const box = await rows.nth(i).boundingBox()
      expect(
        box?.height ?? 0,
        `checklist row ${i} is under the 44px minimum`,
      ).toBeGreaterThanOrEqual(44)
    }
  })

  test('a downed setup read does not take My Day down with it', async ({ page }) => {
    // Same §1.1 reason 2 as the rank block, and the same reason it fetches its
    // own data. This block is the least important thing on the page; it must
    // not be able to cost a seller their appointments.
    await signIn(page)
    await page.route('**/api/home-setup*', (route) => route.fulfill({ status: 500, body: '' }))
    await page.goto('/my-day')

    await expect(page.getByRole('heading', { name: 'My Day' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Needs outcome' })).toBeVisible()

    // And it says nothing at all, which is deliberate. A red box announcing it
    // could not find out what a seller has not set up yet is louder than the
    // thing it reports on, on the screen carrying the LCP budget.
    await expect(page.getByRole('region', { name: 'Get set up' })).toHaveCount(0)
  })
})
