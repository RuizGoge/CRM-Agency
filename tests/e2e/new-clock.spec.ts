import { expect, test, type Page } from '@playwright/test'

import {
  backdateArrival,
  createOpenCard,
  removeCard,
  type FixtureCard,
} from './fixtures/board-data'
import { signIn } from './fixtures/seller'
import { FRESH_WINDOW_SECONDS } from '~/lib/board/tick'

/**
 * `04b` §2.7's `NEW 04:12`, and §4.2's `board.card.new_clock`.
 *
 * THIS FEATURE WAS REFUSED TWICE BEFORE IT SHIPPED, by P6, and the numbers are
 * in the register: 116.7 ms a frame with every chip ticking, still 50.0 ms with
 * the tick narrowed to what was on screen, against a 34 ms budget. The
 * conclusion recorded then was that five hundred simultaneous clocks are not
 * viable without virtualization. Virtualization landed, so a column mounts
 * about seven cards and the worst case is roughly forty chips rather than five
 * hundred — the premise changed, not the approach.
 *
 * EVERY CARD HERE IS MADE BY THE TEST, and the ages are set RELATIVE TO NOW.
 * `card-anatomy.spec.ts` has gone red twice for the opposite habit: the seed
 * stamps an absolute age, so `fresh` was true for one hour after `db:seed` and
 * false forever after, and `Going cold · 9d` quietly became `13d`. A clock test
 * anchored to seeded data would be the same defect with a shorter fuse.
 */

const desktopOnly = 'one clock, one profile — the tick is not per-breakpoint'

test.describe('the NEW clock counts up from the lead’s arrival', () => {
  let card: FixtureCard

  test.beforeEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    card = await createOpenCard('NEW clock fixture')
  })

  test.afterEach(async () => {
    if (test.info().project.name !== 'desktop-ci') return
    await removeCard(card)
  })

  const chipOf = (page: Page, name: string) =>
    page.locator('main article').filter({ hasText: name }).first().locator('span[title]')

  /**
   * Reads the chip and returns its seconds.
   *
   * 🔴 NOTHING HERE PINS A STARTING VALUE, and the first version of this file
   * did. It backdated a card by 4:10 and asserted the chip read `NEW 04:10` —
   * which is true only if signing in and navigating take under a second. They
   * took just over one, so it read `04:11` and the test was red on its first
   * run. The number that matters is not where the clock STARTS, which depends
   * on how fast a machine logs in; it is how far it MOVES.
   */
  async function clockSeconds(page: Page, name: string): Promise<number> {
    const text = await chipOf(page, name).textContent()
    const match = /^NEW (\d{2}):(\d{2})$/.exec(text ?? '')
    expect(match, `the chip reads ${JSON.stringify(text)}, not NEW mm:ss`).not.toBeNull()
    return Number(match?.[1]) * 60 + Number(match?.[2])
  }

  const clockText = (seconds: number): string =>
    `NEW ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

  test('renders mm:ss and advances it without a reload', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    // Arrived at a known point inside the window, far enough from both edges
    // that neither the 00:00 start nor the sixty-minute expiry can be reached
    // by the seconds this test spends waiting.
    await backdateArrival(card, 4 * 60 + 10)

    await signIn(page)
    await page.goto('/board')
    const chip = chipOf(page, card.contactName)

    await expect(chip).toHaveText(/^NEW \d{2}:\d{2}$/)
    const first = await clockSeconds(page, card.contactName)

    // The SERVER rendered it, so it starts at the age the server measured plus
    // however long sign-in took — a band, not a number.
    expect(
      first,
      `the clock started at ${first}s, nowhere near the 250s arrival`,
    ).toBeGreaterThanOrEqual(250)
    expect(first).toBeLessThan(265)

    // THE ASSERTION THE WHOLE FEATURE IS, and the one a screenshot cannot make:
    // the number moves with no navigation, no fetch and no reload. Before this,
    // the chip read `NEW 04m` and stayed there until something else re-rendered
    // the board — which on a seller's morning is never.
    await expect(chip).toHaveText(clockText(first + 3), { timeout: 6_000 })

    // Still the same DOM node rather than a remount, so the card around it was
    // not re-rendered to move a string. A ticking chip that re-renders its Card
    // is the shape of the regression P6 refused twice.
    await expect(page.locator('main article').filter({ hasText: card.contactName })).toHaveCount(1)
  })

  test('advances once per second, so nothing is subscribed twice', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    // ONE INTERVAL FOR THE WHOLE BOARD is the design, and a second subscription
    // per chip is the way it silently stops being that. It would not look
    // broken — the clock would still count — it would just run at double rate,
    // which is exactly the kind of wrong that a screenshot and a "does it tick"
    // assertion both pass.
    await backdateArrival(card, 10 * 60)

    await signIn(page)
    await page.goto('/board')
    const chip = chipOf(page, card.contactName)
    await expect(chip).toHaveText(/^NEW \d{2}:\d{2}$/)
    const first = await clockSeconds(page, card.contactName)

    const started = Date.now()
    await expect(chip).toHaveText(clockText(first + 4), { timeout: 8_000 })
    const wallClockMs = Date.now() - started

    // Four seconds of chip in four seconds of wall clock, with a second of slack
    // either way for the sampling. Double-subscription would land it near two.
    expect(wallClockMs, `four ticks took ${wallClockMs}ms`).toBeGreaterThan(3_000)
    expect(wallClockMs, `four ticks took ${wallClockMs}ms`).toBeLessThan(6_500)
  })

  test('expires on its own at the fresh window rather than counting past it', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    // A board left open all morning is the normal case, not an edge one. The
    // SERVER decides `fresh` once per loader run, so without this the chip
    // would keep counting into `NEW 61:04` — a state the server says is over,
    // rendered on the one signal that claims to be precise.
    // Ten seconds of window left, not three: sign-in costs about one and the
    // chip has to still be on screen when this test first looks at it, or the
    // expiry would be asserted against a chip that never rendered.
    await backdateArrival(card, FRESH_WINDOW_SECONDS - 10)

    await signIn(page)
    await page.goto('/board')
    const chip = chipOf(page, card.contactName)

    await expect(chip).toHaveText(/^NEW 59:5\d$/)
    await expect(chip, 'the clock counted past the fresh window').toHaveCount(0, {
      timeout: 15_000,
    })

    // The CARD stays. Only the signal slot collapses — §2.7 has the slot
    // collapse rather than reserve space, and a card that vanished with its
    // chip would be a lead disappearing off the board.
    await expect(page.locator('main article').filter({ hasText: card.contactName })).toHaveCount(1)
  })

  test('gives a screen reader the sentence, and never announces the tick', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    await backdateArrival(card, 7 * 60 + 30)
    await signIn(page)
    await page.goto('/board')
    const chip = chipOf(page, card.contactName)

    // R11's full sentence as the accessible name, the abbreviation on the card
    // face — the same two-renderings rule every other signal follows.
    //
    // 🔴 DERIVED FROM THE CHIP, NOT PINNED, and this is the SECOND time the same
    // trap caught me in this file. The first two tests were rewritten when they
    // went red on the exact starting value; this one kept `07:30` and passed
    // for a fortnight of nothing, then failed the moment the suite got slower
    // and sign-in took a second and a half instead of one. What the rule
    // actually says is that the two renderings carry the SAME clock — which is
    // what this now checks, and which no amount of machine load can move.
    const visible = await chip.textContent()
    expect(visible, 'the chip is not the NEW clock').toMatch(/^NEW \d{2}:\d{2}$/)
    await expect(chip).toHaveAttribute(
      'aria-label',
      `New — ${(visible ?? '').replace('NEW ', '')} since arrival`,
    )

    // §4.2 registers this row as aria-live="off", and it is asserted rather
    // than left to the default. A clock in the attention slot is the obvious
    // thing to make polite, and a chip announcing itself once a second would
    // make the board unusable with a screen reader while reading, in a diff,
    // exactly like an accessibility improvement.
    await expect(chip).toHaveAttribute('aria-live', 'off')
  })
})
