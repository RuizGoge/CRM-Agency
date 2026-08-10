import { expect, test, type Page, type Response } from '@playwright/test'

import { createOpenCard, removeCard, type FixtureCard } from './fixtures/board-data'
import { expectCount, expectUrl } from './fixtures/clock'
import { signIn } from './fixtures/seller'
import { POLL_SLOW_MS } from '~/styles/tokens/timing'

/**
 * The two pollers that did not exist.
 *
 * `POLL_SLOW_MS` named My Day and the board as its two consumers and had **zero
 * readers** — the constant sat in the tokens module while neither screen polled
 * at all. Both cover what OTHER systems did: a meeting that ended, a task that
 * came due, a card that went overdue. A seller who left either open through a
 * morning was reading a screen that stopped being today's the moment it
 * rendered.
 *
 * A FAKE CLOCK, so fifteen seconds costs nothing — the same
 * `page.clock.install()` the celebration suite uses. Waiting real intervals
 * would put minutes on the suite to prove what a fast-forward proves exactly as
 * well.
 *
 * 🔴 AND EVERY WAIT HERE COMES FROM NODE, never from inside the page. The first
 * version used `page.waitForResponse` and every test timed out — which is the
 * trap `fixtures/clock.ts` already documents from the other side: a frozen page
 * clock kills in-page polling, so an assertion that looks like it waits ten
 * seconds is a single shot taken immediately. `expect.poll` runs from the
 * driver, one round trip at a time, and is unaffected.
 */

const desktopOnly = 'one poll mechanism, one profile'
const TICK = POLL_SLOW_MS + 1_000

const SURFACES = [
  { screen: '/board', api: '/api/board', label: 'the board' },
  { screen: '/my-day', api: '/api/my-day', label: 'My Day' },
] as const

/** Every response this surface produced, collected driver-side. */
function collector(page: Page, api: string): Response[] {
  const seen: Response[] = []
  page.on('response', (r) => {
    if (r.url().includes(api)) seen.push(r)
  })
  return seen
}

/**
 * Advances one interval and returns the response that tick produced.
 *
 * 🔴 IT ADVANCES AGAIN UNTIL SOMETHING ARRIVES, and that is not slack — it is
 * the fix for a real ordering problem the first version tripped over. The
 * poller's interval is created in an effect, so it does not exist until React
 * has hydrated; with a frozen clock the first `fastForward` lands almost
 * instantly after `goto`, before hydration, and fires a timer that has not been
 * scheduled yet. Advancing once and giving up made the BOARD fail and My Day
 * pass — the same code, decided by which screen hydrates faster, which is the
 * same shape of flake `fixtures/clock.ts` records for the undo suite.
 */
async function nextTick(page: Page, seen: Response[]): Promise<Response> {
  const before = seen.length
  await expect
    .poll(
      async () => {
        await page.clock.fastForward(TICK)
        return seen.length
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(before)

  const last = seen[seen.length - 1]
  expect(last).toBeDefined()
  if (!last) throw new Error('unreachable')
  return last
}

test.describe('the polled surfaces actually poll', () => {
  for (const surface of SURFACES) {
    test(`${surface.label} polls its resource route and then answers 304`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

      await page.clock.install()
      await signIn(page)
      await page.goto(surface.screen)
      await expectCount(page.getByRole('navigation', { name: 'Main' }), 1)

      const seen = collector(page, surface.api)

      // FIRST TICK IS A 200 AND THAT IS BY DESIGN, not a defect being hidden:
      // the loader rendered through the framework rather than through
      // `jsonConditional`, so there is no entity tag to inherit and the poller
      // has nothing to send until it has been answered once.
      const first = await nextTick(page, seen)
      expect(first.status()).toBe(200)
      const tag = first.headers()['etag']
      expect(tag, `${surface.api} served no tag, so no later tick can be conditional`).toBeTruthy()

      // THE SECOND TICK IS THE WHOLE POINT. A poller that failed to send back
      // the tag it was given would look identical on screen and cost a full
      // query and a full serialization every fifteen seconds per seller.
      //
      // 🔴 For the board this is also the proof that `etagSourceOf` works on the
      // REAL path: its payload carries the NEW clock's starting second, so
      // without that projection the tag would differ on every tick and this
      // would be a 200 for ever.
      const second = await nextTick(page, seen)
      expect(second.status(), `${surface.api} re-sent an unchanged payload`).toBe(304)
      expect(second.headers()['etag']).toBe(tag)
    })

    test(`${surface.label} does not poll a tab nobody is looking at`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

      // §4.9 puts every poll on the visible tab only. A backgrounded board is
      // four requests a minute per seller nobody will read, and fifty sellers
      // with a forgotten tab doubles the floor for nothing.
      await page.clock.install()
      await signIn(page)
      await page.goto(surface.screen)
      await expectCount(page.getByRole('navigation', { name: 'Main' }), 1)

      const seen = collector(page, surface.api)
      // Drain one tick, so the count below is about the hidden tab rather than
      // about the poller not having started.
      await nextTick(page, seen)
      const beforeHidden = seen.length

      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          value: 'hidden',
          configurable: true,
        })
        document.dispatchEvent(new Event('visibilitychange'))
      })

      await page.clock.fastForward(TICK * 3)
      // Three intervals of nothing. Given from Node, so a frozen page clock
      // cannot make this pass by never checking.
      await expect.poll(() => seen.length, { timeout: 3_000 }).toBe(beforeHidden)

      // AND IT COMES BACK IMMEDIATELY on refocus rather than waiting out the
      // rest of an interval, so a seller returning to the tab never reads a
      // screen they can tell is stale.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          configurable: true,
        })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await expect.poll(() => seen.length, { timeout: 10_000 }).toBeGreaterThan(beforeHidden)
    })
  }

  test('a completed move wins over anything a tick fetched', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', desktopOnly)

    // THE WORST DEFECT THE POLLER CAN CAUSE, and the seller would watch it
    // happen: the card springing back to the column it came from, an undo
    // nobody asked for, on the one screen where trusting the board is the whole
    // product.
    //
    // 🔬 THIS ASSERTS THE PROPERTY, NOT THE MECHANISM, and the difference was
    // measured rather than assumed. Deleting the hook's "the loader wins" reset
    // leaves this test GREEN — because a move redirects, so the board remounts
    // and the hook's cache starts empty regardless. The reset is what covers a
    // revalidation that does NOT navigate, and neither of these two screens has
    // one yet. Recorded in the hook rather than left as a test that reports a
    // guarantee it is not making.
    const card: FixtureCard = await createOpenCard('Poll versus move fixture')
    try {
      await page.clock.install()
      await signIn(page)
      await page.goto('/board')
      await expectCount(page.getByRole('navigation', { name: 'Main' }), 1)

      const seen = collector(page, '/api/board')
      // Let a tick land first, so there IS a fetched payload for the move to
      // have to beat.
      await nextTick(page, seen)

      const holder = page.locator('main section').filter({ hasText: card.contactName }).first()
      const fromName = (await holder.getAttribute('aria-label')) ?? ''
      expect(fromName, 'the fixture card is not on the board').not.toBe('')

      await page.goto(`/board?move=${card.opportunityId}`)
      await expectCount(page.getByRole('dialog'), 1)
      const target = page
        .getByRole('dialog')
        .locator('form')
        .filter({ hasNot: page.locator('input[name="premium"]') })
        .filter({ hasNot: page.locator('select[name="lostReasonId"]') })
        .first()
      await target.getByRole('button', { name: 'Move here' }).click()
      await expectUrl(page, /[?&]moved=/)

      const landedIn = async (): Promise<string> =>
        (await page
          .locator('main section')
          .filter({ hasText: card.contactName })
          .first()
          .getAttribute('aria-label')) ?? ''

      await expect.poll(landedIn, { timeout: 10_000 }).not.toBe(fromName)

      // And it STAYS moved across the next tick, which is exactly where a hook
      // that preferred its own cache would put it back.
      await nextTick(page, seen)
      await expect.poll(landedIn, { timeout: 10_000 }).not.toBe(fromName)
    } finally {
      await removeCard(card)
    }
  })
})
