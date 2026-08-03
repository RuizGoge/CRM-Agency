import { expect, test } from '@playwright/test'

import { signIn } from './fixtures/seller'

/**
 * The period selector's own copy — protected item 9's last gap.
 *
 * `DEMO-09` recorded it in words: the board told all-time and a period apart,
 * but the four periods did not each have their own line. `04b` §4.10 ratifies
 * four, *"deliberately different from All time so the seller knows the FILTER
 * changed, not the data"* — and the four sentences themselves are guarded
 * mechanically in `app/components/leaderboard/empty-copy.test.ts`, which is
 * where a collapse back into one interpolated string turns the build red.
 *
 * What is left for a browser is what only a browser can answer: which of them
 * a seller actually sees, and on which tab.
 */
test.describe('the board says which window it is describing', () => {
  const PERIODS = [
    ['day', 'Today'],
    ['week', 'This week'],
    ['month', 'This month'],
  ] as const

  const BOUNDARY = 'Periods reset at midnight, agency time.'

  for (const [period, label] of PERIODS) {
    test(`tells a ${label} board when it resets`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-ci', 'this is copy, and copy renders once')

      await signIn(page)
      await page.goto(`/earnings?period=${period}`)
      await expect(page.getByRole('heading', { name: 'Earnings' })).toBeVisible()

      // `lb.footnote.period_boundary`, and §4.8 calls it "the one place
      // tenant_business_tz renders as a word". A seller in Phoenix reading a
      // Today board stamped in the agency's timezone will otherwise answer
      // "when does this reset" with their own clock — wrong by up to three
      // hours, on the number they are judged by.
      await expect(page.getByText(BOUNDARY)).toBeVisible()
    })
  }

  test('says nothing of the kind on All time, which has no boundary', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'this is copy, and copy renders once')

    await signIn(page)
    await page.goto('/earnings?period=all_time')
    await expect(page.getByRole('heading', { name: 'Earnings' })).toBeVisible()

    // The other direction, and it is the one that keeps the line meaning
    // something: a reset notice on the board that never resets is noise, and
    // noise is what gets a footnote deleted.
    await expect(page.getByText(BOUNDARY)).toHaveCount(0)
  })

  test('the period selector actually changes the board', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'one profile is enough to read four numbers')

    // §1529: the seed "spans all four periods". It did not — measured, not
    // assumed: every bucket held the identical total, because `stage_move` can
    // only stamp now() and every seeded win went through it. Four tabs showing
    // one number is a period selector that demonstrates nothing at minute
    // 0:30, and §1533 names the mirror-image failure as demo-fatal.
    //
    // Read off a seller no other spec touches. Renata closes deals in
    // `celebration.spec.ts` and her Today number moves with every run; Priya's
    // does not, and the gap between her Today and her All time is the
    // backdated history the seed now writes.
    const totalFor = async (period: string): Promise<string> => {
      await page.goto(`/earnings?period=${period}`)
      await expect(page.getByRole('heading', { name: 'Earnings' })).toBeVisible()
      const row = page.locator('main').getByText('Priya N.').first().locator('..')
      return ((await row.innerText()) ?? '').replace(/\s+/g, ' ')
    }

    await signIn(page)
    const today = await totalFor('day')
    const allTime = await totalFor('all_time')

    expect(
      today,
      'Today and All time show the same board — the seed does not span periods',
    ).not.toBe(allTime)
  })

  test('never teaches an empty board over a board with money on it', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'this is copy, and copy renders once')

    // The empty block hangs off the FLOOR TOTAL rather than off `rows.length`,
    // because migration 0017 made the board start from the roster and `rows`
    // is never empty once a tenant has sellers. Getting that backwards renders
    // "No earnings yet" above a podium showing five figures.
    await signIn(page)
    await page.goto('/earnings?period=all_time')

    await expect(page.getByText('No earnings yet')).toHaveCount(0)
    await expect(page.getByText(/Nothing on the board yet/)).toHaveCount(0)
  })
})
