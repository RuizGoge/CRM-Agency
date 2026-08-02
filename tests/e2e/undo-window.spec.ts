import { expect, test } from '@playwright/test'

import { UNDO_WINDOW_MS } from '~/styles/tokens/timing'

import { expectCount, expectText, expectUrl } from './fixtures/clock'
import { signIn } from './fixtures/seller'

/**
 * The undo window, asserted at the boundary instead of waited out.
 *
 * A fake clock is what makes this a test rather than a five-second sleep that
 * passes on a fast machine and flakes on a loaded one. It also lets the
 * assertion sit ON the deadline: still there at 4,999ms, gone at 5,000ms. A
 * test that only checks "it disappears eventually" stays green if someone
 * changes the number to thirty seconds — and the toast's lifetime is one of
 * the four representations of the undo window this project promises to keep in
 * agreement.
 *
 * Every wait here comes from `./fixtures/clock` rather than from Playwright's
 * auto-waiting, because a faked page clock disables the latter. See the note
 * in that file — it is the trap this spec walked into first.
 *
 * The move used is between two OPEN stages, never into an earning one, so a
 * suite that runs on every push cannot append to the ledger. `earnings_ledger`
 * is append-only with no recompute job: a test that credits money leaves it
 * credited.
 */
test.describe('the undo window is exactly UNDO_WINDOW_MS on screen', () => {
  test('offers the undo, then withdraws it on the deadline', async ({ page }) => {
    await page.clock.install()
    await signIn(page)

    await page.goto('/board')
    await page.getByRole('link', { name: 'Move' }).first().click()

    const sheet = page.getByRole('dialog')
    await expectCount(sheet, 1)

    // No deal-value field means no earning stage, so no ledger row. Asserted
    // rather than assumed: the seed's column order is not a contract.
    const target = sheet.locator('form').first()
    await expectCount(target.locator('input[name="premium"]'), 0)
    await target.getByRole('button', { name: 'Move here' }).click()

    await expectUrl(page, /[?&]moved=/)

    const bar = page.locator('[role="status"]')
    await expectCount(bar, 1)
    await expectCount(bar.getByRole('button', { name: /^Undo/ }), 1)

    // A bracket around the deadline, not a one-millisecond boundary.
    //
    // The faked clock is not perfectly frozen: measured, it leaks roughly five
    // milliseconds of real time per protocol round trip, so `fastForward(4999)`
    // lands PAST 5,000ms and the bar is already gone. Asserting to the
    // millisecond would be claiming a precision the tool does not have — the
    // first version of this test did, and failed for that reason rather than a
    // product one.
    //
    // The bracket still does the job it exists for. `UNDO_WINDOW_MS` is pinned
    // to one number across TypeScript, CSS and SQL by the drift test in the
    // integration tier; this proves the toast on screen actually spends that
    // number, and nothing near 1s or 30s survives it.
    const before = await page.evaluate(() => Date.now())
    await page.clock.fastForward(UNDO_WINDOW_MS - 500)

    // Verified, not assumed: we really are still short of the deadline.
    const elapsed = (await page.evaluate(() => Date.now())) - before
    expect(elapsed).toBeLessThan(UNDO_WINDOW_MS)
    await expectCount(bar, 1)

    await page.clock.fastForward(1_000)
    await expectCount(bar, 0)
  })

  test('walks the card back to the column it came from', async ({ page }) => {
    await page.clock.install()
    await signIn(page)

    await page.goto('/board')
    await page.getByRole('link', { name: 'Move' }).first().click()

    const sheet = page.getByRole('dialog')
    await expectCount(sheet, 1)

    const contact = ((await sheet.getByRole('heading').first().textContent()) ?? '').replace(
      /^Move /,
      '',
    )
    const origin = ((await sheet.locator('p').first().textContent()) ?? '').replace(
      /^Currently in /,
      '',
    )

    const target = sheet.locator('form').first()
    await expectCount(target.locator('input[name="premium"]'), 0)
    const destination = (await target.locator('strong').textContent()) ?? ''
    await target.getByRole('button', { name: 'Move here' }).click()

    await expectUrl(page, /[?&]moved=/)
    await expectText(page.locator('[role="status"]'), `Moved ${contact} to ${destination}.`)

    // The affordance names where the card goes back to. `Undo` alone asks a
    // seller to remember which column it came from, five seconds after a drag.
    const undo = page.getByRole('button', { name: `Undo — back to ${origin}` })
    await expectCount(undo, 1)
    await undo.click()

    // Back where it started, and the bar does not return: undoing an undo is a
    // loop.
    await expectText(page.getByRole('region', { name: origin }), contact)
    await expectCount(page.locator('[role="status"]'), 0)

    // And the card is in ONE place, not rendered in both.
    expect(await page.getByRole('region', { name: destination }).textContent()).not.toContain(
      contact,
    )
  })
})
