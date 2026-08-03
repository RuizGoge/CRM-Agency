import { expect, test, type Page } from '@playwright/test'

import { BREAKPOINTS } from '~/styles/tokens/timing'

import { signIn } from './fixtures/seller'

/**
 * Protected item 10's last missing piece, read off the screen.
 *
 * `04-ux-flows.md` §7 narrates the first ten seconds of the demo and puts one
 * sentence at the centre of them: the seller home paints and Ray sees
 * `You're #2 · $41,300 · $6,900 behind Dana R.` before he has clicked
 * anything. Nothing about that is enforceable by a type or a constraint — it
 * is a sentence, in a place, within a viewport — so a test that reads the
 * screen is the only mechanism available.
 *
 * THE AMOUNTS ARE NOT ASSERTED, and that is deliberate rather than lazy. Every
 * full run of this suite credits Renata $3,720, because `celebration.spec.ts`
 * cannot prove what it proves without closing a real deal against an
 * append-only ledger with no recompute job. A spec that pinned $9,029.88 would
 * be green once and red forever after. What is asserted is the SHAPE of the
 * sentence and the place it occupies — both of which are what the item
 * actually protects, and neither of which drifts with the ledger.
 */

/** The third clause has three shapes, and only one of them mentions a rival. */
const GAP = String.raw`(\$[\d,]+(\.\d{2})? to pass .+|Leading by \$[\d,]+(\.\d{2})?|Leading the board|Tied with .+)`

/**
 * `You're #2 · $9,029.88 · $2,550.12 to pass Priya N.`
 *
 * Below the density breakpoint the sentence wraps and the LAST separator is
 * removed, because the line break is doing that separator's job and a `·` left
 * hanging at the end of a wrapped line was the one blemish on the screen that
 * opens the demo. Both forms are asserted rather than one loose pattern that
 * would accept either: a dot that silently disappeared on desktop would be a
 * regression, and a pattern permitting both could not see it.
 */
function expected(page: Page): RegExp {
  const stacked = (page.viewportSize()?.width ?? 0) < BREAKPOINTS.md
  return new RegExp(String.raw`^You.re #\d+ · \$[\d,]+(\.\d{2})? ${stacked ? '' : '· '}${GAP}$`)
}

/**
 * The RESOLVED block, not merely a present one.
 *
 * The band renders on the server as a skeleton and fills in after hydration,
 * so the section is `visible` a beat before the sentence exists — and the
 * first version of this spec read an empty string off it and reported a
 * missing line that was simply not there yet. Worse, the fold assertion
 * measured the skeleton's box, which is shorter than the sentence it stands in
 * for: it would have passed on a phone where the real line wrapped below the
 * fold. Waiting for the link is waiting for the ready state, because no other
 * state has one.
 */
async function resolvedStanding(page: Page) {
  const standing = page.getByRole('region', { name: 'Your standing' })
  await expect(standing.getByRole('link')).toBeVisible()
  return standing
}

test.describe('the rank and the gap, above the fold on the seller home', () => {
  test('DEMO-10-rank: renders the standing sentence on My Day', async ({ page }) => {
    await signIn(page)
    await page.goto('/my-day')

    const standing = await resolvedStanding(page)

    // The dot separators are aria-hidden, so this reads the VISIBLE sentence
    // rather than the accessible name. Whitespace is normalised because the
    // line is built from several spans and JSX indents them.
    const line = ((await standing.innerText()) ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/ See the board$/, '')
      .trim()

    expect(line, 'the standing sentence does not have the shape §7 describes').toMatch(
      expected(page),
    )
  })

  test('sits above the fold, and above the first row of the day', async ({ page }) => {
    // The item says "above the fold" and means it: a rank a presenter has to
    // scroll to is a rank the room never sees. Both profiles run this, because
    // the phone is the viewport that can actually lose it.
    await signIn(page)
    await page.goto('/my-day')

    const standing = await resolvedStanding(page)

    const box = await standing.boundingBox()
    const viewport = page.viewportSize()
    expect(box, 'the standing block has no box').not.toBeNull()
    expect(viewport, 'no viewport to measure against').not.toBeNull()

    const bottom = (box?.y ?? 0) + (box?.height ?? 0)
    expect(bottom, 'the standing block is below the fold').toBeLessThanOrEqual(
      viewport?.height ?? 0,
    )

    // And ahead of the day's work, not tucked under it. Measured in the
    // document rather than assumed from the source: the undo bar taught this
    // project that DOM order is the thing a seller experiences, and that a
    // note in a file claiming a position can be wrong for weeks.
    const firstSection = page.locator('main section').first()
    await expect(firstSection).toBeVisible()
    expect(await firstSection.getAttribute('aria-label')).toBe('Your standing')
  })

  test('taps through to the full board', async ({ page }) => {
    // Feature 28: the widget is a way IN to the board. A rank with no route to
    // the names above it is a scoreboard with the names torn off.
    await signIn(page)
    await page.goto('/my-day')

    await page.getByRole('region', { name: 'Your standing' }).getByRole('link').click()
    await expect(page.getByRole('heading', { name: 'Earnings' })).toBeVisible()
  })

  test('a downed standings read does not take My Day down with it', async ({ page }) => {
    // §1.1 reason 2, asserted rather than asserted-in-prose. It is the reason
    // this block fetches its own data instead of riding My Day's loader: with
    // a page loader, the response below turns the whole screen into an error
    // boundary and a seller loses their appointments because a leaderboard
    // read failed.
    await signIn(page)
    await page.route('**/api/leaderboard*', (route) => route.fulfill({ status: 500, body: '' }))
    await page.goto('/my-day')

    // The day survives, in full.
    await expect(page.getByRole('heading', { name: 'My Day' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Needs outcome' })).toBeVisible()

    // And the block says so, in the seller's words, with a way out. A silent
    // empty band is how a seller learns to distrust the number.
    const standing = page.getByRole('region', { name: 'Your standing' })
    await expect(standing.getByText(/We couldn.t load your rank\./)).toBeVisible()
    await expect(standing.getByRole('button', { name: 'Retry' })).toBeVisible()
  })
})
