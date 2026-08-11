import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { signIn } from './fixtures/seller'

/**
 * The Activity stream on the contact record. C-20, MVP item 20's screen.
 *
 * The projection, the silo and the keyset are asserted against the database in
 * `tests/integration/timeline.test.ts`, where they can be asserted rather than
 * inferred from pixels. What only a browser can say is here: that the region
 * mounts on a REAL contact, that it resolves to one of its two ready states
 * instead of its error state, that a failing history does not take the rest of
 * the record with it, and that a foreign id grows no history region at all.
 *
 * NO ASSERTION ON WHICH ROWS APPEAR, deliberately. The demo seed writes no
 * timeline entries and the projector only runs when the relay has something to
 * carry, so a spec that expected a call or a stage move would be asserting the
 * order other specs happened to run in. Both ready states are legitimate here,
 * and saying so is more honest than a fixture that makes one of them appear.
 */

/** The seller's first contact, reached the way a seller reaches it. */
async function openFirstContact(page: Page): Promise<void> {
  await page.goto('/my-book')

  const first = page.locator('a[href^="/contacts/"]').first()
  await expect(first).toBeVisible()
  await first.click()

  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
}

test.describe('the contact record carries its history', () => {
  test('the Activity region resolves to a ready state, never to its error', async ({ page }) => {
    await signIn(page)
    await openFirstContact(page)

    // Skeletons, not spinners — and then gone. `expect.poll` rather than a wait
    // for a specific row, because which ready state is correct depends on what
    // the tenant's history actually holds.
    const activity = page.locator('section', {
      has: page.getByRole('heading', { name: 'Activity' }),
    })

    await expect
      .poll(async () => {
        const empty = await activity.getByText('Nothing has happened yet').count()
        const rows = await activity.getByRole('listitem').count()
        return empty + rows
      })
      .toBeGreaterThan(0)

    // 🔴 THE ERROR STATE IS THE ONE OUTCOME THAT IS NEVER CORRECT HERE. A
    // seller reading "we couldn't load this history" on a healthy tenant learns
    // to distrust the board, which is the failure this whole surface exists to
    // avoid.
    await expect(activity.getByText('We couldn’t load this history.')).toHaveCount(0)
  })

  test('a failing history leaves the rest of the record usable', async ({ page }) => {
    await signIn(page)

    // The endpoint refuses BEFORE the screen asks, so this is the region's own
    // error path rather than a slow network being called an error. Only the
    // timeline route is intercepted: everything else on the record is untouched,
    // which is exactly the property under test.
    await page.route('**/api/contacts/*/timeline*', (route) =>
      route.fulfill({ status: 500, body: 'nope' }),
    )

    await page.goto('/my-book')
    const first = page.locator('a[href^="/contacts/"]').first()
    await expect(first).toBeVisible()
    const name = (await first.textContent())?.trim() ?? ''
    await first.click()

    await expect(page.getByText('We couldn’t load this history.')).toBeVisible()

    // 🎯 THE POINT OF AN INLINE ERROR. The header is still there, so the seller
    // can still read the number and dial — a full-screen error would take the
    // call away for a reason that has nothing to do with the call.
    if (name !== '') await expect(page.getByRole('heading', { level: 1 })).toContainText(name)
    await expect(page.getByRole('heading', { name: 'Deals' })).toBeVisible()

    // And it offers the way back, rather than only reporting.
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  test('a foreign contact grows no history region at all', async ({ page }) => {
    // `DEMO-04` from the other side. The record resolves to not-found, so the
    // timeline never mounts — there is no second surface here that could answer
    // differently for "not yours" than for "never existed".
    await signIn(page)
    await page.goto('/contacts/00000000-0000-7000-8000-0000000000ff')

    await expect(page.getByRole('heading', { name: /isn.t in your book/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Activity' })).toHaveCount(0)
    await expect(page.locator('main')).not.toContainText('403')
  })

  test('passes axe on the record itself, not only on its not-found', async ({ page }) => {
    // The a11y suite has only ever scanned the not-found shape of this URL, so
    // the record — the heading, the definition list, the ordered history and now
    // its <time> elements — has never been assessed. Both profiles.
    await signIn(page)
    await openFirstContact(page)

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    expect(
      results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) })),
    ).toEqual([])
  })
})
