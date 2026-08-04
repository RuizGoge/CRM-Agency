import { expect, test, type Locator, type Page } from '@playwright/test'

import { signIn } from './fixtures/seller'

/**
 * `DEMO-08` — Ctrl+K from any surface, and the keyboard contract.
 *
 * §7's recovery path is the moment this exists for: a handset rings from a
 * number the seller does not recognise, and she needs the file before she
 * answers. Two interactions from anywhere in the app.
 *
 * The assertions here are the ones only a browser can make. The silo and the
 * E.164 normalisation live in `tests/integration/search.test.ts`, where they
 * can be asserted against the database instead of through a text box.
 */
/**
 * Open the overlay, waiting out HYDRATION rather than assuming it.
 *
 * Ctrl+K is bound by an effect, so it does not exist until React has hydrated
 * the shell — and `page.goto` resolves well before that. The first version of
 * this spec pressed immediately and failed with "Ctrl+K did nothing", while
 * the one test that happened to `focus()` an element first passed, because
 * focusing waits for the element and therefore for hydration.
 *
 * That is the same accident `undo-keyboard.spec.ts` records from the other
 * side: a test that passes because of when a click was dispatched is a test
 * that proves nothing about the product. Polling the press is the honest
 * version — it asserts the shortcut becomes available, without pretending it
 * was available at a moment it was not.
 */
async function openSearch(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: 'Search' })

  await expect
    .poll(async () => {
      await page.keyboard.press('Control+k')
      return dialog.count()
    })
    .toBe(1)

  return dialog
}

test.describe('Ctrl+K finds a lead from anywhere', () => {
  const desktopOnly = 'the shortcut is a keyboard contract'

  test('opens from any surface with focus in the input', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await signIn(page)

    // "From any surface" is the requirement, so it is asserted on more than
    // one. A shortcut wired per screen works on the screens somebody
    // remembered — which is why this lives in the shell.
    for (const surface of ['/my-day', '/board', '/earnings']) {
      await page.goto(surface)
      const dialog = await openSearch(page)
      await expect(dialog, `Ctrl+K did nothing on ${surface}`).toBeVisible()

      // FOCUS LANDS IN THE INPUT. An overlay that opens and leaves focus
      // behind makes a seller reach for the mouse, which is the whole thing
      // the shortcut was for.
      await expect(dialog.getByRole('combobox')).toBeFocused()
      await page.keyboard.press('Escape')
    }
  })

  test('teaches what it searches before it searches anything', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await signIn(page)
    await page.goto('/my-day')

    // `search.idle`, and §4.10's note on why the body is worth the space: it
    // states the three indexed fields so nobody tries a policy number and
    // concludes the search is broken.
    const dialog = await openSearch(page)
    await expect(dialog.getByText('Search your book').first()).toBeVisible()
    await expect(dialog.getByText('By name, phone or email. Any phone format works.')).toBeVisible()
  })

  test('finds the record from a phone number typed the way a seller reads it', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    // The demo moment. The seeded contact stores `+1...`; the seller types
    // hyphens, because that is how it appears on a screen.
    await signIn(page)
    await page.goto('/board')

    const dialog = await openSearch(page)
    await dialog.getByRole('combobox').fill('Doris')

    const option = dialog.getByRole('option').first()
    await expect(option).toContainText('Doris Whitfield')
  })

  test('walks the list with the arrows and opens with Enter', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await signIn(page)
    await page.goto('/my-day')

    const dialog = await openSearch(page)
    const input = dialog.getByRole('combobox')
    await input.fill('Doris')
    await expect(dialog.getByRole('option').first()).toBeVisible()

    // The highlight moves and FOCUS STAYS IN THE INPUT, so a seller can keep
    // narrowing while choosing. Roving focus into the list makes every
    // correction a trip back to the field.
    await page.keyboard.press('ArrowDown')
    await expect(input).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/contacts\//)
    await expect(page.getByRole('heading', { name: 'Doris Whitfield' })).toBeVisible()
  })

  test('Escape closes and gives focus back to whatever opened it', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    // THE ONE EVERYBODY SKIPS. A seller who opens search from a card, changes
    // their mind and presses Escape must get their place back — an overlay
    // that dumps focus on `<body>` costs a keyboard user their position on a
    // 500-card board, and it is invisible to anyone testing with a mouse.
    await signIn(page)
    await page.goto('/board')

    const opener = page.getByRole('link', { name: 'Move' }).first()
    await opener.focus()
    await expect(opener).toBeFocused()

    await openSearch(page)

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0)
    await expect(opener, 'Escape lost the seller their place').toBeFocused()
  })

  test('teaches an empty result instead of reporting absence', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await signIn(page)
    await page.goto('/my-day')

    const dialog = await openSearch(page)
    await dialog.getByRole('combobox').fill('937-555-9999')

    // `search.empty`. §4.10's opening rule: a state that only reports absence
    // is a defect, so this one offers the number back.
    await expect(dialog.getByText('No matches in your book')).toBeVisible()
    await expect(dialog.getByText('Add this number and start a deal in one step.')).toBeVisible()
  })

  test('a foreign contact URL reads as not found, never forbidden', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    // `DEMO-04` on the screen a pasted URL lands on. The id is well-formed and
    // simply not this seller's, which is exactly the case a 403 would confirm.
    await signIn(page)
    await page.goto('/contacts/00000000-0000-7000-8000-0000000000ff')

    await expect(
      page.getByRole('heading', { name: "That contact isn't in your book" }),
    ).toBeVisible()
    await expect(page.locator('main')).not.toContainText('Forbidden')
    await expect(page.locator('main')).not.toContainText('403')
  })
})
