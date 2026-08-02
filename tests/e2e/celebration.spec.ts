import { expect, test, type Page } from '@playwright/test'

import { UNDO_WINDOW_MS } from '~/styles/tokens/timing'

import { createOpenCard, removeCard, type FixtureCard } from './fixtures/board-data'
import { expectBoardSettled, expectCount, expectUrl } from './fixtures/clock'
import { signIn } from './fixtures/seller'

/**
 * The money moment, on the one timer it is allowed to have.
 *
 * Ruling P2.1: the celebration has exactly one timer and the client owns it —
 * the undo window's own. So the assertions here are all about WHEN, and the
 * fake clock is what makes "when" testable instead of a five-second sleep that
 * flakes on a loaded machine.
 *
 * These tests DO credit money: closing a deal is the thing being tested and
 * there is no version of it that does not touch the ledger. That is the reason
 * they are here and not in the shared a11y sweep — the ledger is append-only
 * with no recompute job, so every run of this file leaves a real sale in the
 * demo tenant, exactly as a demo would.
 */
test.describe('the celebration fires once, at the end of the undo window', () => {
  const desktopOnly = 'one run of this case is enough'

  // Its OWN card, created and removed per test. This spec closes deals on
  // purpose, and the earlier version closed the DEMO's — so each run left fewer
  // open cards than the last until there were none, and both this spec and the
  // drag spec failed for a reason that was three runs old.
  let card: FixtureCard

  // `test.info()` rather than the hook's testInfo parameter: Playwright
  // requires the first argument to be an object pattern and the lint rule
  // forbids an empty one, so the two rules only agree on taking neither.
  test.beforeEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    card = await createOpenCard('Celebration fixture')
  })

  test.afterEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    await removeCard(card)
  })

  async function winACard(page: Page): Promise<void> {
    // Straight to this test's own card, never "the first Move link".
    await page.goto(`/board?move=${card.opportunityId}`)
    await expectCount(page.getByRole('dialog'), 1)

    // The earning column: the only form in the sheet carrying a deal value,
    // found by the FIELD rather than by the stage's name. A gate bound to a
    // name is evaded by typing over the name.
    const earning = page
      .getByRole('dialog')
      .locator('form')
      .filter({ has: page.locator('input[name="premium"]') })
      .first()

    await earning.locator('input[name="premium"]').fill('310')
    await earning.locator('select[name="premiumMode"]').selectOption('monthly')
    await earning.getByRole('button', { name: 'Move here' }).click()
    await expectUrl(page, /[?&]moved=/)
  }

  test('shows nothing until the window closes, then the amount', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)
    await page.clock.install()
    await signIn(page)
    await winACard(page)

    const celebration = page.locator('[role="alert"]')
    await expectCount(page.locator('[role="status"]'), 1)
    await expectBoardSettled(page)

    // Nothing yet. A celebration that fires while the undo is still offered is
    // celebrating something that has not finished happening.
    await expectCount(celebration, 0)

    await page.clock.fastForward(UNDO_WINDOW_MS + 1_000)

    await expectCount(celebration, 1)
    // x12 applied server-side: $310 monthly is $3,720 a year. The number on the
    // card is the one that went to the ledger, not one the client computed.
    await expect(celebration).toContainText('$3,720')
    await expect(celebration).toContainText('Sold')

    // STILL there a real second later, and this assertion exists because of a
    // defect it would have caught: the claim POSTs through a fetcher, a fetcher
    // submission revalidates the route, and the revalidated loader no longer
    // offers a celebration for a win it has just recorded. The confetti
    // unmounted about two hundred milliseconds after appearing — a flash on
    // screen, and green in a test that only looked once.
    //
    // Real time, not the fake clock: the unmount was driven by a network round
    // trip, which a frozen clock does not hold back.
    await page.waitForTimeout(1_000)
    await expectCount(celebration, 1)

    // And the undo bar is gone: the same timer did both.
    await expectCount(page.locator('[role="status"]'), 0)
  })

  test('never fires when the seller takes the undo', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)
    await page.clock.install()
    await signIn(page)
    await winACard(page)

    await page.getByRole('button', { name: /^Undo/ }).click()
    await expectUrl(page, /\/board$/)
    await expectBoardSettled(page)

    // Well past the deadline. The bar unmounted, its cleanup cleared the
    // timeout, and "no undo was taken in this page session" is a fact about the
    // component lifecycle rather than a flag someone remembered to check.
    await page.clock.fastForward(UNDO_WINDOW_MS * 3)
    await expectCount(page.locator('[role="alert"]'), 0)
  })

  test('does not replay on a reload inside the window', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)
    await page.clock.install()
    await signIn(page)
    await winACard(page)

    // The payload survives the reload — it is loader data. The confetti does
    // not, because a fresh document is a 'POP' navigation and the token is only
    // built for a real move. US-9.8's "not replayed", obtained structurally.
    await page.reload()

    // Wait for the reloaded page to be hydrated BEFORE asserting an absence.
    // The undo bar comes back — it is driven by the URL and the loader, both of
    // which survive a reload — and its presence is the proof that the page has
    // rendered and run its effects.
    await expectBoardSettled(page)
    await expectCount(page.locator('[role="status"]'), 1)

    await page.clock.fastForward(UNDO_WINDOW_MS * 3)
    await expectCount(page.locator('[role="alert"]'), 0)
  })
})
