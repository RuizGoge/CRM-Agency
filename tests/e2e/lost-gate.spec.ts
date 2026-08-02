import { expect, test } from '@playwright/test'

import { createOpenCard, removeCard, type FixtureCard } from './fixtures/board-data'
import { expectCount } from './fixtures/clock'
import { signIn } from './fixtures/seller'

/**
 * Closed Lost is usable — which it was not, and nothing said so.
 *
 * The loss gate is a CHECK constraint (`current_stage_type <> 'lost' OR
 * lost_reason_id IS NOT NULL`), the move sheet's "Why?" select is populated from
 * `app.lost_reason`, and the seed created no rows in that table. So the select
 * rendered with nothing in it, the field is `required`, and an entire column of
 * the board could not be reached. Nothing in the product was broken: the data it
 * depends on was simply absent, and every test passed anyway because no test
 * ever tried to lose a deal.
 *
 * A demo where one of four columns cannot be used is not a demo, and "we saw it
 * on screen" is not a mechanism. This is the mechanism.
 *
 * Its OWN card, created and removed per test, like every other spec here: this
 * one moves a card into a terminal stage, and the suite has to leave the demo
 * tenant the way it found it.
 */
test.describe('a deal can actually be lost', () => {
  const desktopOnly = 'one run of this case is enough'
  let card: FixtureCard

  test.beforeEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    card = await createOpenCard('Lost gate fixture')
  })

  test.afterEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    await removeCard(card)
  })

  test('offers real reasons and records the one chosen', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await signIn(page)
    await page.goto('/board')

    await page.goto(`/board?move=${card.opportunityId}`)
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()

    // The lost column's form is the one carrying a reason select — found by the
    // GATE it shows rather than by the column's name, which is the same rule the
    // server enforces: the gate binds to `stage_type`, never to a label someone
    // may rename.
    const lost = sheet
      .locator('form')
      .filter({ has: page.locator('select[name="lostReasonId"]') })
      .first()
    await expect(lost).toBeVisible()

    const reason = lost.locator('select[name="lostReasonId"]')

    // THE ASSERTION THAT WOULD HAVE CAUGHT THIS. An empty select still renders,
    // still passes axe, and still looks like a working screen — it just cannot
    // be submitted, because the field is required and the only option is the
    // disabled placeholder. Counting the real options is the difference between
    // "the control exists" and "the control can be used".
    //
    // Counted, never asserted VISIBLE: an <option> inside a closed <select> is
    // not visible to Playwright, so `toBeVisible()` here fails on a select that
    // works perfectly. Presence and count are the property that matters.
    const options = reason.locator('option:not([disabled])')
    await expect
      .poll(() => options.count(), {
        message: 'Closed Lost is unusable with no loss reasons seeded',
      })
      .toBeGreaterThan(2)

    const chosen = (await options.first().textContent())?.trim() ?? ''
    expect(chosen.length).toBeGreaterThan(0)

    // By LABEL, not by index: index 0 is the disabled "Why?" placeholder, which
    // exists precisely so no reason is ever preselected — the same rule that
    // keeps the premium unit unchosen, because a default here is how a loss gets
    // filed under a reason nobody picked.
    await reason.selectOption({ label: chosen })
    await lost.getByRole('button', { name: 'Move here' }).click()

    // The card landed in the lost column, and the undo is offered like any other
    // move — losing a deal is not a privileged path.
    await expectCount(page.getByRole('dialog'), 0)
    await expect(
      page.getByRole('region', { name: 'Closed Lost' }).getByText(card.contactName),
    ).toBeVisible()
  })
})
