import { expect, test, type Page } from '@playwright/test'

import { createOpenCard, removeCard, type FixtureCard } from './fixtures/board-data'
import { expectBoardSettled, expectCount, expectText, expectUrl } from './fixtures/clock'
import { signIn } from './fixtures/seller'

/**
 * Drag, and the two conditions that arm it.
 *
 * `>=1024px` AND `pointer: fine`, together. Width alone would arm it on a large
 * tablet, where a drag competes with the scroll gesture and a seller loses a
 * card trying to scroll the board. The `mobile-ci` profile is a Pixel 7 — a
 * coarse pointer — so the negative case here is a real device emulation rather
 * than a narrowed desktop window, which is the only way that half of the
 * condition gets tested at all.
 *
 * Drag is additive. Every assertion below also checks that the move sheet is
 * still there, because the day drag breaks it is the thing that has to keep
 * the product working.
 */
/**
 * Drag is armed by an effect, so the first render has no draggable card at all
 * and `dragTo` on one is a no-op that fails much later and somewhere else.
 * Every test that drags waits for this first — it is not a convenience.
 */
async function dragArmed(page: Page): Promise<void> {
  await expectBoardSettled(page)
  await expect(page.locator('main [data-drag]')).toHaveAttribute('data-drag', 'on')
}

test.describe('drag is bound only on a wide screen with a fine pointer', () => {
  test('desktop arms it; mobile does not, and keeps the sheet', async ({ page }, testInfo) => {
    await signIn(page)
    await page.goto('/board')
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()

    const cards = page.locator('main article')
    const draggable = page.locator('main article[draggable="true"]')
    const total = await cards.count()
    expect(total).toBeGreaterThan(0)

    // A POSITIVE assertion in both directions. `expectCount(draggable, 0)` was
    // the earlier form and it passed the instant it saw zero — which a page that
    // has not hydrated also satisfies, so the mobile case would have gone on
    // passing if drag started appearing on phones. `data-drag` is absent until
    // the effect decides, so waiting for it and then reading it cannot pass
    // early.
    await expectBoardSettled(page)
    const armed = page.locator('main [data-drag]')

    if (testInfo.project.name === 'desktop-ci') {
      await expect(armed).toHaveAttribute('data-drag', 'on')
      await expectCount(draggable, total)
    } else {
      await expect(armed).toHaveAttribute('data-drag', 'off')
      await expectCount(draggable, 0)
    }

    // The universal path does not go away when drag is available, and it is
    // the only path when drag is not.
    await expectCount(page.getByRole('link', { name: 'Move' }), total)
  })
})

/**
 * The half of the condition the two profiles cannot reach.
 *
 * `mobile-ci` is a Pixel 7 at 412px, so it is excluded by WIDTH before the
 * pointer is ever consulted — which means the `pointer: fine` clause could be
 * deleted and both profiles would stay green. This is the case the clause was
 * written for: a large tablet, wide enough to qualify, where a drag competes
 * with the scroll gesture and a seller loses a card trying to scroll the board.
 */
test.describe('a wide screen with a COARSE pointer is not a desktop', () => {
  test.use({ viewport: { width: 1366, height: 1024 }, hasTouch: true, isMobile: true })

  test('leaves drag off, and the move sheet is the whole path', async ({ page }, testInfo) => {
    // isMobile is Chromium-only. Both profiles are Chromium, so this is a
    // statement about the runner rather than a limitation being worked around.
    test.skip(testInfo.project.name !== 'desktop-ci', 'one run of this case is enough')

    await signIn(page)
    await page.goto('/board')
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()

    const total = await page.locator('main article').count()
    expect(total).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.matchMedia('(pointer: fine)').matches)).toBe(false)

    await expectBoardSettled(page)
    await expect(page.locator('main [data-drag]')).toHaveAttribute('data-drag', 'off')
    await expectCount(page.locator('main article[draggable="true"]'), 0)
    await expectCount(page.getByRole('link', { name: 'Move' }), total)
  })
})

test.describe('a drop is the same gated move as any other', () => {
  // Skipped rather than deleted on mobile: the profile still RUNS these names,
  // so a `mobile-ci` line that says "skipped" is the report saying drag is
  // absent there on purpose. A spec file that simply did not exist for that
  // profile would look the same as one nobody wrote.
  const desktopOnly = 'drag exists only on the desktop profile'

  // A card of its own, so this spec never depends on how many the demo has
  // left. Removed afterwards, so it never becomes one of them.
  let card: FixtureCard

  // `test.info()` rather than the hook's testInfo parameter: Playwright
  // requires the first argument to be an object pattern and the lint rule
  // forbids an empty one, so the two rules only agree on taking neither.
  test.beforeEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    card = await createOpenCard('Drag fixture')
  })

  test.afterEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    await removeCard(card)
  })

  test('drops onto an open stage, and offers the undo', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)
    await signIn(page)
    await page.goto('/board')
    await dragArmed(page)

    // The spec's OWN card, located by its name. Discovering "whichever open
    // column has cards" was the previous form and it was still a bet on shared
    // state — the fixture removes the bet entirely.
    //
    // Both columns are open stages, which is what keeps this drop off the
    // append-only ledger: a suite that runs on every push must not credit money
    // it cannot take back.
    const contact = card.contactName
    const source = page.locator('main article').filter({ hasText: contact }).first()
    await expect(source).toBeVisible()

    const sourceName = 'New Lead'
    const targetName = 'Quoted'
    const origin = page.getByRole('region', { name: sourceName })
    const target = page.getByRole('region', { name: targetName })
    await expect(origin).toContainText(contact)

    // Dropped on the ZONE at a FIXED POINT, not on the section at its centre.
    // `dragTo` aims at the centre of whatever it is given, and a column's
    // centre moves with how many cards it holds: too few and it drifts into the
    // header, too many and it drifts past the fold, where the scroll needed to
    // reach it breaks the drag. Both failures looked like "the drop handler
    // does not work". The zone is also the element that actually carries the
    // handler.
    await source.dragTo(target.locator('> div'), { targetPosition: { x: 24, y: 24 } })

    await expectUrl(page, /[?&]moved=/)
    await expectText(page.locator('[role="status"]'), `Moved ${contact} to ${targetName}.`)
    await expect(target).toContainText(contact)
    await expect(origin).not.toContainText(contact)

    // A drop earns the same undo as the sheet does. It is the same POST to the
    // same gated function, so this is the assertion that they did not quietly
    // become two paths.
    await expectCount(page.getByRole('button', { name: `Undo — back to ${sourceName}` }), 1)
  })

  test('lights the column the card would land in', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)
    await signIn(page)
    await page.goto('/board')

    await dragArmed(page)

    // Asserts COMPUTED STYLE, because this is where a real defect hid: with a
    // `transition` on the shorthand, the inline style read
    // `var(--color-selected-bg)` while the computed background never left the
    // old value — Chromium would not interpolate between two custom properties
    // and the new colour simply never applied. The ring rendered correctly
    // either way, so the missing tint was invisible beside it and no
    // screenshot would have told the difference.
    //
    // Events are dispatched rather than driven by the mouse on purpose: the
    // layer under test is the React handlers, and `dragTo` cannot pause with
    // the pointer held over a column.
    const painted = await page.evaluate(() => {
      const card = document.querySelector('main article[draggable="true"]')
      const section = document.querySelector('section[aria-label="Closed Won"]')
      const zone = section?.lastElementChild
      if (!card || !zone) return null

      const dataTransfer = new DataTransfer()
      const idle = getComputedStyle(zone).backgroundColor
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
      zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }))

      return new Promise<{ idle: string; over: string; ring: string; after: string }>((resolve) => {
        setTimeout(() => {
          const style = getComputedStyle(zone)
          const over = style.backgroundColor
          const ring = style.boxShadow
          card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
          setTimeout(
            () => resolve({ idle, over, ring, after: getComputedStyle(zone).backgroundColor }),
            150,
          )
        }, 200)
      })
    })

    expect(painted).not.toBeNull()
    expect(painted?.over).not.toBe(painted?.idle)
    expect(painted?.ring).toContain('inset')
    // And it clears. A drop target still lit after the drag ended points at a
    // column the card is not going to.
    expect(painted?.after).toBe(painted?.idle)
  })

  test('opens the sheet instead of failing when the stage has a gate', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)
    await signIn(page)
    await page.goto('/board')
    await dragArmed(page)

    // A drop carries no deal value, and the database refuses an earning move
    // without one. The sheet appearing is the gate showing up where it applies
    // — not a fallback after a refusal the seller had to read first.
    const source = page.locator('main article').filter({ hasText: card.contactName }).first()
    await expect(source).toBeVisible()
    await source.dragTo(page.getByRole('region', { name: 'Closed Won' }).locator('> div'), {
      targetPosition: { x: 24, y: 24 },
    })

    await expectCount(page.getByRole('dialog'), 1)
    await expectCount(page.getByRole('dialog').locator('input[name="premium"]'), 1)

    // Nothing moved, and nothing was refused: no error, no undo offered.
    await expectCount(page.locator('[role="alert"]'), 0)
    await expectCount(page.locator('[role="status"]'), 0)
  })
})
