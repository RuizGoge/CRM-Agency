import { expect, test } from '@playwright/test'

import { createOpenCard, removeCard, type FixtureCard } from './fixtures/board-data'
import { expectCount } from './fixtures/clock'
import { signIn } from './fixtures/seller'

/**
 * Can a keyboard reach the undo before the undo is gone?
 *
 * The undo bar lives for exactly five seconds. `axe-core` passes it — it is
 * focusable, labelled and contrast-checked — because axe measures a snapshot and
 * has no concept of a DEADLINE. "Keyboard reachable" and "keyboard reachable
 * within the window it exists" are different properties, and only the second one
 * is the promise.
 *
 * So this counts Tab presses. The number is the whole test: an affordance five
 * seconds long that sits behind every card on the board is not reachable, it is
 * merely present.
 */

/** Enough that a seller finds it without hunting; small enough to be a real gate. */
const MAX_TABS_TO_UNDO = 6

test.describe('the undo is reachable by keyboard inside its own window', () => {
  const desktopOnly = 'tab order is one property, and one profile proves it'
  let card: FixtureCard

  test.beforeEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    card = await createOpenCard('Undo keyboard fixture')
  })

  test.afterEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    await removeCard(card)
  })

  test('sits within a few tabs of the document, not behind every card', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await signIn(page)

    // Move the card through the universal path, which is what a keyboard user
    // would have used to get here in the first place.
    await page.goto(`/board?move=${card.opportunityId}`)
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()

    const openTarget = sheet
      .locator('form')
      .filter({ hasNot: page.locator('input[name="premium"]') })
      .filter({ hasNot: page.locator('select[name="lostReasonId"]') })
      .first()
    await openTarget.getByRole('button', { name: 'Move here' }).click()

    const undo = page.getByRole('button', { name: /^Undo — back to/ })
    await expect(undo).toBeVisible()

    // COUNTED IN DOM ORDER, not by pressing Tab, and that is the second attempt.
    //
    // Driving the keyboard looked obvious and reported ONE tab — flatteringly
    // wrong twice over. `document.body.focus()` is a no-op because body carries
    // no tabindex, and even after `blur()` leaves `activeElement` as BODY,
    // Chromium keeps its SEQUENTIAL FOCUS NAVIGATION STARTING POINT where the
    // last click was. So the walk began next to the button it was looking for.
    //
    // The index of the button among the document's focusable elements is the
    // same number a seller experiences and depends on none of that.
    const measured = await page.evaluate(() => {
      const selector =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      const all = [...document.querySelectorAll(selector)].filter((el) => {
        if (!(el instanceof HTMLElement)) return false
        if (el.hasAttribute('hidden')) return false
        const style = getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') return false
        return el.offsetParent !== null || style.position === 'fixed'
      })
      const index = all.findIndex(
        (el) => el instanceof HTMLElement && /^Undo — back to/.test(el.textContent ?? ''),
      )
      return { index, total: all.length }
    })

    const tabs = measured.index + 1
    console.log(`[undo-keyboard] undo is focusable #${tabs} of ${measured.total} in DOM order`)

    expect(measured.index, 'the undo button is not focusable at all').toBeGreaterThanOrEqual(0)

    // THE ASSERTION THAT MATTERS. The bar is rendered after the whole board, so
    // forward tab order puts every card's "Move" link in front of it. On the
    // demo tenant that is a dozen presses; on the 500-card board a real seller
    // has, it is five hundred, inside a five-second window. The count is the
    // defect, and a cap is the only thing that keeps it from coming back.
    expect(
      tabs,
      `the undo is ${tabs} tabs away — it lives 5s, so anything past a handful is unreachable`,
    ).toBeLessThanOrEqual(MAX_TABS_TO_UNDO)

    // And it still works from the keyboard once reached.
    await undo.focus()
    await page.keyboard.press('Enter')
    await expectCount(page.getByRole('button', { name: /^Undo — back to/ }), 0)
  })
})
