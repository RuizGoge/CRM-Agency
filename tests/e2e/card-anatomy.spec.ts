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
    // `0 attempts` is a field they read past.
    //
    // 🔴 ANCHORED TO RUTH, not to `.first()`. The board sorts by
    // `stage_entered_at DESC`, so the first card is whichever one was moved
    // most recently — and moving a card is what half the other specs do. The
    // original passed only while nothing in the suite had ever dragged
    // anything, which made it a test whose result depended on the history of
    // the database rather than on the copy it was written to protect. Ruth is
    // the one seeded lead with zero attempts, by name.
    await signIn(page)
    await page.goto('/board')

    const ruth = page.locator('main article').filter({ hasText: 'Ruth Alvarez' })
    await expect(ruth).toContainText('Not called yet')
    await expect(page.locator('main').getByText('0 attempts')).toHaveCount(0)
  })

  test('draws the health rail, and draws it partially before the threshold', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'the rail is one computed style')

    // `04b` §2.8: *"the rail is a two-signal gradient, not a colour"*. Both
    // halves are WCAG 1.4.1 — the hue says WHICH state and the fill height says
    // HOW FAR — so a seller who cannot separate amber from grey still reads the
    // card. A solid border could carry the first signal and never the second.
    //
    // The seeded board holds one card per state on purpose; the ages are fixed
    // rather than random precisely so this can be asserted at all.
    await signIn(page)
    await page.goto('/board')
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()

    const railOf = (name: string): Promise<string> =>
      page
        .locator('main article')
        .filter({ hasText: name })
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundImage)

    // Full fills: a named state is a verdict, not a slope.
    expect(await railOf('Curtis Vance'), 'going cold is not a full amber rail').toMatch(
      /rgb\(169, 110, 0\).*100%/,
    )
    expect(await railOf('Wendell Pike'), 'overdue is not a full red rail').toMatch(
      /rgb\(225, 85, 85\).*100%/,
    )
    expect(await railOf('Ruth Alvarez'), 'a fresh lead is not a blue rail').toMatch(
      /rgb\(27, 84, 191\)/,
    )

    // THE GRADIENT. Four days against a seven-day threshold, so the amber stops
    // partway and the rest is the healthy hairline. A threshold-only design
    // renders this card identically to an untouched one.
    const decaying = await railOf('Alma Betancourt')
    expect(decaying, 'a decaying card shows no partial fill').toMatch(/rgb\(169, 110, 0\)/)
    const stop = /rgb\(169, 110, 0\)[^,]*?(\d+)%/.exec(decaying)?.[1]
    expect(Number(stop), `the fill stops at ${stop}%, not partway`).toBeGreaterThan(0)
    expect(Number(stop), `the fill stops at ${stop}%, which is the full rail`).toBeLessThan(100)
  })

  test('renders exactly one signal chip per card, and never on a closed deal', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'this is a DOM count')

    await signIn(page)
    await page.goto('/board')
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()

    // The slot is ONE fixed-width box on a 264px card. Two chips means both
    // truncate, which §2.5 records as the reason the second attention pill was
    // deleted rather than shrunk.
    const cards = page.locator('main article')
    const count = await cards.count()
    for (let i = 0; i < count; i++) {
      const chips = cards.nth(i).locator('span[title]')
      expect(await chips.count(), `card ${i} renders more than one signal`).toBeLessThanOrEqual(1)
    }

    // MVP item 32. The seeded won card is twenty days untouched with six
    // attempts — the loudest going-cold chip the board could produce, on the
    // one card nobody is working.
    const won = page.locator('main article').filter({ hasText: 'Lead 1 of Renata Ochoa' }).first()
    await expect(won).toBeVisible()
    await expect(won.locator('span[title]')).toHaveCount(0)
  })

  test('gives a screen reader the sentence, not the abbreviation', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'this is copy, and copy renders once')

    // §2.7 resolves R7 against R11 by keeping BOTH renderings: the face carries
    // `Going cold · 9d` because the card is 264px wide, and the accessible name
    // carries the full sentence. An abbreviation is not an accessible name —
    // and the banned word appears in neither.
    await signIn(page)
    await page.goto('/board')

    const chip = page
      .locator('main article')
      .filter({ hasText: 'Curtis Vance' })
      .first()
      .locator('span[title]')

    await expect(chip).toHaveText('Going cold · 9d')
    await expect(chip).toHaveAttribute('aria-label', 'Going cold — 9 days since last touch')
    await expect(page.locator('main')).not.toContainText('Rotting')
  })
})
