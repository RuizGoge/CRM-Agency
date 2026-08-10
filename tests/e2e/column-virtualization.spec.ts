import { expect, test, type Page } from '@playwright/test'

import { VIRTUALIZE_ABOVE } from '~/components/board/column-window'
import { CARD_H_DESKTOP_PX, cardPitchPx } from '~/styles/tokens/geometry'

import { expectBoardSettled } from './fixtures/clock'
import { PERF_CARD_COUNT, PERF_SELLER_LOGIN, seedPerf500 } from './fixtures/perf-500'

/**
 * The column virtualizer — `04b` §2.1's rendering contract, on a real board.
 *
 * P6 measures what the window BUYS. This measures that it is honest, which is a
 * different question and the one a seller meets: a virtualizer that renders
 * fewer nodes is trivial to write and trivial to get wrong, and every way of
 * getting it wrong looks like the product losing leads.
 *
 *   * spacers short by a few pixels → the scrollbar lies, and the bottom of the
 *     column is unreachable;
 *   * the window not covering the viewport → a band of blank column between two
 *     cards, which reads as missing leads and not as a bug;
 *   * offscreen cards leaving tab order for good → the board becomes
 *     mouse-only past the fold, and the move sheet is supposed to be the
 *     universal path.
 *
 * Run on both profiles on purpose. The pitch is a different number below the
 * density breakpoint (156 + 8 rather than 120 + 8), so a virtualizer that
 * multiplied by the desktop height everywhere would pass every desktop
 * assertion and open a 36px gap per card on a phone.
 */

const CARD = 'main article'

async function signInAsPerfSeller(page: Page): Promise<void> {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(PERF_SELLER_LOGIN.email)
  await page.getByLabel('Password').fill(PERF_SELLER_LOGIN.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await page.goto('/board')
  await expectBoardSettled(page)
}

/** The pitch the running profile actually renders at, read from the token. */
async function pitchOf(page: Page): Promise<number> {
  const mobile = await page.evaluate(
    (desktop) =>
      getComputedStyle(document.documentElement).getPropertyValue('--card-h').trim() !== desktop,
    `${CARD_H_DESKTOP_PX}px`,
  )
  return cardPitchPx(mobile)
}

test.describe('a 125-card column renders a window and pads for the rest', () => {
  test.beforeAll(async () => {
    await seedPerf500()
  })

  test('mounts a bounded window while declaring every card', async ({ page }) => {
    await signInAsPerfSeller(page)

    const columns = await page.locator('main [data-cards]').evaluateAll((els) =>
      els.map((el) => ({
        cards: Number(el.getAttribute('data-cards') ?? '0'),
        window: el.getAttribute('data-window') ?? '',
        mounted: el.querySelectorAll('article').length,
      })),
    )

    // The fixture reaching the SCREEN, not just the database. Without this the
    // bound below would be satisfied by a board that lost 400 cards.
    const declared = columns.reduce((n, c) => n + c.cards, 0)
    expect(declared, 'the board is not showing the 500-card book').toBe(PERF_CARD_COUNT)

    const mounted = columns.reduce((n, c) => n + c.mounted, 0)
    expect(mounted, 'nothing is on screen').toBeGreaterThan(0)
    expect(mounted, 'no window — every card is in the DOM').toBeLessThan(PERF_CARD_COUNT)

    // And per column, against the contract's own rule rather than a round
    // number: a column at or below the threshold renders plainly and reports
    // `all`, and only a column above it is allowed to be short.
    for (const column of columns) {
      if (column.cards <= VIRTUALIZE_ABOVE) {
        expect(column.window, `${column.cards} cards is below the threshold`).toBe('all')
        expect(column.mounted).toBe(column.cards)
      } else {
        expect(column.window, `${column.cards} cards should be windowed`).not.toBe('all')
        expect(column.mounted).toBeLessThan(column.cards)
      }
    }
  })

  test('scrolls to the end and arrives at the last card, not at blank column', async ({ page }) => {
    await signInAsPerfSeller(page)
    const pitch = await pitchOf(page)

    // THE SCROLLBAR EITHER TELLS THE TRUTH OR IT DOES NOT, and this is the
    // assertion that decides. The page is only as tall as the spacers claim, so
    // a spacer computed from the WRONG pitch — the exact drift
    // `card-height.test.ts` guards from the other side — makes the document
    // shorter than its own cards. The window then runs out before the end and a
    // seller simply cannot reach the bottom of their book: no error, no gap, the
    // last twenty leads are unreachable and nothing says so.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))

    await expect
      .poll(async () =>
        page
          .locator('main [data-cards]')
          .evaluateAll((els) =>
            els
              .filter((el) => (el.getAttribute('data-window') ?? 'all') !== 'all')
              .every(
                (el) =>
                  (el.getAttribute('data-window') ?? '').split('-')[1] ===
                  el.getAttribute('data-cards'),
              ),
          ),
      )
      .toBe(true)

    // And the last card is where the bottom of the column is, rather than a
    // pitch or twenty above it. `data-window` reaching the end proves the INDEX
    // arrived; this proves the PIXELS did.
    const tails = await page.locator('main [data-cards]').evaluateAll((els) =>
      els
        .filter((el) => (el.getAttribute('data-window') ?? 'all') !== 'all')
        .map((el) => {
          const cards = el.querySelectorAll('article')
          const last = cards[cards.length - 1]
          return last === undefined
            ? Number.NaN
            : el.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom
        }),
    )

    expect(tails.length, 'no column was windowed at all').toBeGreaterThan(0)
    for (const tail of tails) {
      // The list's own bottom padding, and nothing else, is allowed to sit under
      // the last card. Half a pitch is the loosest that can still catch an
      // off-by-one-card spacer.
      expect(tail, 'blank column below the last card').toBeLessThan(pitch / 2)
      expect(tail, 'the last card overhangs its own column').toBeGreaterThanOrEqual(0)
    }
  })

  test('keeps the window over the viewport as the page scrolls', async ({ page }) => {
    await signInAsPerfSeller(page)
    const pitch = await pitchOf(page)

    const before = await page.locator(CARD).evaluateAll((els) => els.map((el) => el.textContent))
    expect(before.length).toBeGreaterThan(0)

    // Forty pitches down — deep enough that no card from the first window can
    // still be mounted, so "the window moved" is not satisfied by it merely
    // growing.
    await page.evaluate((y) => window.scrollTo(0, y), pitch * 40)
    await expect.poll(() => page.locator(CARD).evaluateAll((els) => els.length)).toBeGreaterThan(0)

    const after = await page.locator(CARD).evaluateAll((els) => els.map((el) => el.textContent))
    const shared = after.filter((name) => before.includes(name))
    expect(shared, 'the window did not move with the scroll').toHaveLength(0)

    // THE GAP TEST. For every windowed column the mounted run must start above
    // the viewport and end below it — that is what the overscan is for, and a
    // window that merely renders *some* cards would satisfy every count
    // assertion above while showing a seller a band of empty column.
    const coverage = await page.locator('main [data-cards]').evaluateAll((els) =>
      els
        .filter((el) => (el.getAttribute('data-window') ?? 'all') !== 'all')
        .map((el) => {
          const cards = [...el.querySelectorAll('article')].map((c) => c.getBoundingClientRect())
          const first = cards[0]
          const last = cards[cards.length - 1]
          return {
            top: first ? first.top : Number.NaN,
            bottom: last ? last.bottom : Number.NaN,
            viewport: window.innerHeight,
          }
        }),
    )

    expect(coverage.length, 'no column was windowed at all').toBeGreaterThan(0)
    for (const column of coverage) {
      expect(column.top, 'a gap above the first mounted card').toBeLessThanOrEqual(0)
      expect(column.bottom, 'a gap below the last mounted card').toBeGreaterThanOrEqual(
        column.viewport,
      )
    }
  })

  test('lets a keyboard past the fold, one Tab at a time', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'one run of the tab chain is enough')

    await signInAsPerfSeller(page)
    const pitch = await pitchOf(page)

    // THE CHAIN THIS ASSERTS, because it is a chain and not a property: Tab moves
    // focus to the last mounted card, the browser scrolls it into view, the
    // scroll moves the window, the next card mounts, and the Tab after that has
    // somewhere to go. Break any link — drop the overscan to zero, make the
    // scroll handler async, throttle it behind a timer — and a keyboard user is
    // fenced at the first window with no way to reach card thirty.
    await page.locator(CARD).first().getByRole('link', { name: 'Move' }).focus()

    const window0 = await page.locator(CARD).count()
    const steps = window0 + 12
    for (let i = 0; i < steps; i += 1) {
      await page.keyboard.press('Tab')
      // ⚠️ A DELAY WITH A REASON, not a workaround, and it was earned: without it
      // this test passed alone and failed inside the full suite. Playwright taps
      // Tab about seventy times a second; the fastest sustained keyboard
      // navigation a person produces is nearer eight. Between the two sits one
      // React render — the scroll that focus caused has to land before the next
      // press needs the card it mounts — and driving the chain faster than any
      // human can measures React's scheduler, not the chain. Twice as fast as a
      // person is the pace being asserted.
      await page.waitForTimeout(60)
    }

    const landed = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? '',
      text: document.activeElement?.textContent ?? '',
      scrollY: window.scrollY,
    }))

    expect(landed.tag, 'focus left the board entirely').toBe('A')
    expect(landed.text, 'focus is not on a card').toBe('Move')
    // If the window had stayed put, focus would have run out of cards after
    // `window0` presses and jumped to the next column — which is at the top of
    // the page, so the page would never have scrolled.
    expect(
      landed.scrollY,
      'tabbing never scrolled, so it never left the first window',
    ).toBeGreaterThan(pitch * 5)
  })
})
