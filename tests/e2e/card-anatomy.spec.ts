import { expect, test } from '@playwright/test'

import { signIn } from './fixtures/seller'

/**
 * The kanban card's geometry and two of its facts — `DEMO-07`.
 *
 * `04b` R2-1 asks for a card box test: *"any KanbanCard variant computes to a
 * height ≠ --card-h, or any column renders a non-uniform pitch"*. That number
 * is not cosmetic. A uniform row pitch is what makes a 500-card column
 * virtualisable, and virtualisation is what makes P6's 60 fps and the LCP
 * budget reachable — so a card that grows by one row because somebody added a
 * chip costs the drag gate its headroom without ever looking broken.
 *
 * The chain is closed in two halves. `tests/integration/card-height.test.ts`
 * ties the CSS token to the number pinned in `ref.ci_ratchet`; this ties the
 * token to what a browser actually renders. Neither half alone is the gate.
 */
test.describe('every card is exactly one height', () => {
  test('renders every card at --card-h, with a uniform column pitch', async ({ page }) => {
    await signIn(page)
    await page.goto('/board')
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()

    // Read the token from the running page rather than pinning 120 or 156
    // here: the two profiles resolve `--card-h` differently, and a spec that
    // hardcoded either would assert the breakpoint instead of the card.
    const expected = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-h')),
    )
    expect(expected, '--card-h does not resolve to a number').toBeGreaterThan(0)

    const cards = page.locator('main article')
    const count = await cards.count()
    expect(count, 'no cards on the board to measure').toBeGreaterThan(1)

    const heights: number[] = []
    for (let i = 0; i < count; i++) {
      const box = await cards.nth(i).boundingBox()
      heights.push(box?.height ?? 0)
    }

    // Border-box, so the 1px border on each edge is part of the measured box
    // while `height` sets the content box. Two pixels of slack, and no more:
    // this assertion exists to catch a card that grew a ROW, which is 20px.
    for (const [i, height] of heights.entries()) {
      expect(
        Math.abs(height - expected),
        `card ${i} is ${height}px, not ${expected}px`,
      ).toBeLessThan(3)
    }

    // Uniform pitch, stated separately. Every card matching the token already
    // implies it today, but the ruling asks for both and they fail differently:
    // one wrong card is a variant, and a whole column off by the same amount is
    // a token.
    expect(new Set(heights.map((h) => Math.round(h))).size, 'the column pitch is not uniform').toBe(
      1,
    )
  })

  test('says Not called yet rather than 0 attempts', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'this is copy, and copy renders once')

    // Element ⑤ of the anatomy, and §2.4 gives zero its own sentence on
    // purpose: `Not called yet` is a state a seller acts on this morning, and
    // `0 attempts` is a field they read past. The seeded board has never been
    // dialled, so this is the branch it renders.
    await signIn(page)
    await page.goto('/board')

    await expect(page.locator('main article').first()).toContainText('Not called yet')
    await expect(page.locator('main').getByText('0 attempts')).toHaveCount(0)
  })
})
