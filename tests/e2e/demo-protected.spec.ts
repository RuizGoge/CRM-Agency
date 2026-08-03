import { expect, test } from '@playwright/test'

import { createOpenCard, removeCard, type FixtureCard } from './fixtures/board-data'
import { expectCount } from './fixtures/clock'
import { signIn } from './fixtures/seller'

/**
 * The Protected List, executable — the three of ten that can be asserted today.
 *
 * `04-ux-flows.md` §8: "The Protected List is executable, or it is not
 * protected." `contracts/protected-list.json` maps all ten and its own suite
 * refuses a claim of coverage that resolves to no test, so the seven that are
 * blocked or partial are visible rather than assumed.
 *
 * These assertions test DEMO-VISIBLE BEHAVIOUR, not the feature underneath. The
 * distinction matters: a test that passed by mocking a service layer would go on
 * passing through the exact regression the list exists to prevent.
 *
 * They credit money to the demo tenant, and there is no version that does not —
 * a board that re-ranks needs a sale to re-rank on. Each makes its own card and
 * removes it; the ledger rows stay, append-only, exactly as a real sale would.
 */

const PREMIUM_MONTHLY = '410'

test.describe('the Protected List, the part that exists', () => {
  const desktopOnly = 'these are demo-script assertions, and the script is one screen'
  let card: FixtureCard

  test.beforeEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    card = await createOpenCard('Protected list fixture')
  })

  test.afterEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    await removeCard(card)
  })

  test('DEMO-03: an earning column refuses the drop and opens the win gate instead', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await signIn(page)
    await page.goto(`/board?move=${card.opportunityId}`)

    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()

    // The earning target is found by the GATE it renders, never by a column
    // name. The whole ruling is that the gate binds to `stage_type`, so a test
    // keyed on "Closed Won" would keep passing through a rename that broke it.
    const earning = sheet
      .locator('form')
      .filter({ has: page.locator('input[name="premium"]') })
      .first()
    await expect(earning).toBeVisible()

    // The unit has NO preselected default. A monthly premium silently read as
    // annual is the demo's worst possible failure: the public board is then
    // wrong by a factor of twelve.
    const mode = earning.locator('select[name="premiumMode"]')
    await expect(mode).toHaveValue('')

    // And the value is required — this is the refusal, on the surface a seller
    // uses. The database CHECK is what actually enforces it; this asserts the
    // gate appears BEFORE the seller is told no.
    await expect(earning.locator('input[name="premium"]')).toHaveAttribute('required', '')

    // AND IT STOPS HERE, deliberately. The item is "the board REFUSES the drop
    // and the win gate opens" — the gate appearing, with no preselected unit and
    // a required value, IS the assertion. Completing the sale belongs to DEMO-01.
    //
    // The first version did submit, and it cost an hour: the credited sale
    // surfaced on the public board 5.5s later, landing inside DEMO-01's polling
    // window, and DEMO-01 reported the board publishing a win 2.5s after it
    // happened. That reads as a money defect — a sale made public while it could
    // still be undone — and it was test contamination. Same lesson as the suite
    // that ate its own cards, one level up: a test that credits money leaks into
    // every test that watches money.
    await page.goto('/board')
    await expectCount(page.getByRole('dialog'), 0)
  })

  test('DEMO-04: a foreign record id is not found, never forbidden', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await signIn(page)

    // A real uuid that belongs to nobody in this seller's book — the shape of a
    // pasted URL from another seller's screen.
    const foreign = '00000000-0000-7000-8000-0000000000aa'
    const response = await page.goto(`/board?move=${foreign}`)

    // NOT 403. A 403 confirms the record exists, which is the leak: it turns a
    // guessed id into a yes/no oracle about another seller's book.
    expect(response?.status(), 'a foreign id must not be answered with 403').not.toBe(403)

    // The move sheet simply does not open. Nothing on screen acknowledges the id.
    await expectCount(page.getByRole('dialog'), 0)

    const body = (await page.locator('main').textContent()) ?? ''
    expect(body).not.toContain(foreign)
    expect(body.toLowerCase()).not.toContain('forbidden')
    expect(body.toLowerCase()).not.toContain('permission')
  })

  test('DEMO-01: a second screen re-ranks after the win, inside the published window', async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    // The second screen: its own context, so it carries its own session and its
    // own poll. The demo moment is two laptops on a table.
    //
    // Signed in as a DIFFERENT seller, and that is not incidental. The list
    // calls this "the public Earnings board", but `/earnings` sits inside the
    // shell layout and the shell redirects when there is no session — so an
    // anonymous second screen watches the sign-in page re-render forever, which
    // is exactly how the first version of this test failed. Whether that board
    // should be reachable without a session is a product question; a rival
    // seller watching it is the demo as written either way.
    const second = await browser.newContext()
    const board = await second.newPage()

    try {
      await board.goto('/sign-in')
      await board.getByLabel('Email').fill('priya@demo.test')
      await board.getByLabel('Password').fill('demo-password-1234')
      await board.getByRole('button', { name: 'Sign in' }).click()
      await expectCount(board.getByRole('navigation', { name: 'Main' }), 1)

      await board.goto('/earnings')

      // THE SELLER'S NUMBER, not the whole page. Comparing all of `main` counts
      // any change at all as a re-rank — a relative timestamp, a highlight, a
      // re-order — and the first version of this test did exactly that and
      // reported the board publishing a sale 2.7s after the win, which would
      // have been a money defect if it had been true. It was a loose assertion.
      const renataTotal = async (): Promise<string> => {
        const text = (await board.locator('main').textContent()) ?? ''
        const row = /Renata[^$]*(\$[\d,]+\.?\d*)/.exec(text)
        return row?.[1] ?? 'ABSENT'
      }

      // WAIT FOR THE BOARD TO SETTLE BEFORE STARTING THE CLOCK.
      //
      // Other specs in this suite credit money — celebration.spec.ts exists to —
      // and every one of those sales surfaces on the public board 5.5s later.
      // Landing inside this test's window, one of them moves Renata's total for
      // a reason that has nothing to do with the win measured here, and the
      // result reads as the board publishing a sale 2.5s after it happened: a
      // money defect that is not real. Run alone it passed; run in the suite it
      // did not, which is the signature of shared state rather than a bug.
      //
      // So: poll until the number holds still for longer than the reveal delay.
      // Then anything that moves it afterwards is this test's own doing.
      let before = await renataTotal()
      expect(before, 'the second screen is not showing the board').not.toBe('ABSENT')

      for (let settled = 0; settled < 3;) {
        await board.waitForTimeout(2200)
        await board.reload()
        const now = await renataTotal()
        if (now === before) settled += 1
        else {
          before = now
          settled = 0
        }
      }

      await signIn(page)
      await page.goto(`/board?move=${card.opportunityId}`)
      const sheet = page.getByRole('dialog')
      await expect(sheet).toBeVisible()

      const earning = sheet
        .locator('form')
        .filter({ has: page.locator('input[name="premium"]') })
        .first()
      await earning.locator('input[name="premium"]').fill(PREMIUM_MONTHLY)
      await earning.locator('select[name="premiumMode"]').selectOption('monthly')
      const wonAt = Date.now()
      await earning.getByRole('button', { name: 'Move here' }).click()
      await expect(page.getByRole('button', { name: /^Undo — back to/ })).toBeVisible()

      // PRECEDENCE, and this is the trap in DEMO-01. §7 says the second screen
      // re-ranks "within 5s". That number is STRUCK: the public projection
      // withholds every entry younger than undo_window (5000) + guard (500), so
      // a 5s re-rank is arithmetically impossible on a CORRECT product — the
      // board is deliberately refusing to publish a sale that can still be
      // undone. 05-architecture.md §8.3 retires it and P21 replaces it with
      // 6.5s push / 10.5s poll-fallback. Asserting the old number would fail
      // forever and the fix would be to break the undo.
      const P21_POLL_FALLBACK_MS = 10_500

      await expect
        .poll(
          async () => {
            await board.reload()
            return renataTotal()
          },
          {
            message: 'the second screen never re-ranked',
            timeout: P21_POLL_FALLBACK_MS,
            intervals: [400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400],
          },
        )
        .not.toBe(before)

      const elapsed = Date.now() - wonAt
      console.log(`[DEMO-01] second screen re-ranked ${elapsed}ms after the win`)

      // The other half, and it is the one a naive test would miss: it must NOT
      // have appeared early. A board that published inside the undo window would
      // be showing a sale the seller can still cancel.
      expect(elapsed, 'the win became public before the undo window closed').toBeGreaterThanOrEqual(
        5000,
      )
      expect(elapsed).toBeLessThanOrEqual(P21_POLL_FALLBACK_MS)
    } finally {
      await second.close()
    }
  })
})
