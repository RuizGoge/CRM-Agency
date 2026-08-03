import { expect, test } from '@playwright/test'

import { signIn } from './fixtures/seller'

/**
 * The counterweight to the confetti — protected items 9 and 10, the parts that
 * are about telling the truth rather than about celebrating.
 *
 * Both items name the shortcut that kills them, and both shortcuts are the kind
 * nobody argues for out loud. Item 9's is dropping the go-live footnote "as
 * clutter", which leaves an owner to ask after the meeting whether his imported
 * history is on the board — a question whose honest answer is no and whose
 * dishonest answer is a dispute on day one. Item 10's is omitting the Demo chip,
 * which makes any screenshot of the demo indistinguishable from a real
 * customer's standings.
 *
 * Neither is enforceable by a type or a constraint. They are copy on a screen,
 * so a test that reads the screen is the only mechanism available.
 */
test.describe('the board says what it is and what it counts', () => {
  const desktopOnly = 'this is copy, and copy renders once'

  test('carries the permanent go-live footnote and the tracked-since date', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await signIn(page)
    await page.goto('/earnings')

    // Ruling D8 in one sentence, on the screen, permanently. Not a tooltip and
    // not an onboarding step: an owner reads this the first time and every time.
    await expect(
      // Matched loosely on the apostrophe: the JSX writes a typographic
      // right-quote (&rsquo;) and a test hunting a straight one finds nothing.
      page.getByText(/The board starts at go-live — imported history isn.t counted\./),
    ).toBeVisible()

    // And the window it describes. A total with no start date invites the
    // reader to supply their own, which is exactly the misunderstanding the
    // footnote above exists to prevent.
    await expect(page.getByText(/^Earnings tracked since \w{3} \d{2}, \d{4}$/)).toBeVisible()
  })

  test('marks the seeded tenant on the board and in the shell', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await signIn(page)
    await page.goto('/earnings')

    await expect(page.getByText('Demo tenant — these numbers are seeded.')).toBeVisible()

    // The chip lives in the SHELL, so it survives navigation. A marker that
    // only exists on the board is missing from the screenshot somebody takes of
    // My Day, which is the failure item 10 describes.
    const chip = page.getByRole('banner').getByText('Demo', { exact: true })
    await expect(chip).toBeVisible()

    await page.goto('/my-day')
    await expect(chip).toBeVisible()

    await page.goto('/board')
    await expect(chip).toBeVisible()
  })
})
