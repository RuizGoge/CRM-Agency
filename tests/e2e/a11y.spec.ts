import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { expectCount, expectUrl } from './fixtures/clock'
import { signIn, signInAsAdmin } from './fixtures/seller'

/**
 * WCAG 2.1 AA with zero serious or critical findings is declared a gate, and
 * until now it was declared and nothing else — `test:e2e` was a script in
 * package.json with no test behind it. A gate nobody can watch go red is
 * documentation.
 *
 * Scoped to serious and critical on purpose. axe's `minor` and `moderate`
 * buckets carry advisory rules that a screen can fail while being perfectly
 * usable; folding them in makes the number noisy, and a noisy gate gets its
 * threshold raised. The two buckets that stay are the ones that mean a seller
 * with a screen reader or a keyboard cannot do the thing.
 *
 * Both profiles run every case: `mobile-ci` is not a smaller desktop. The
 * move sheet is the universal move path precisely because drag is desktop
 * only, so it has to be reachable there first.
 */

const RULE_SET = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const

async function seriousOrCritical(
  page: Page,
): Promise<Array<{ id: string; impact: string; nodes: string[] }>> {
  const results = await new AxeBuilder({ page }).withTags([...RULE_SET]).analyze()

  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: v.impact ?? 'unknown',
      // The selector, so a red build names the element instead of the rule.
      nodes: v.nodes.map((n) => n.target.join(' ')),
    }))
}

test.describe('every surface passes axe with no serious or critical finding', () => {
  test('sign-in, signed out', async ({ page }) => {
    await page.goto('/sign-in')
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()

    expect(await seriousOrCritical(page)).toEqual([])
  })

  test('my day', async ({ page }) => {
    await signIn(page)
    await page.goto('/my-day')
    await expect(page.getByRole('heading', { name: 'My Day' })).toBeVisible()

    // 🔴 THE HEADING IS NOT THE SCREEN. It comes from the loader, so it is on
    // the page before either block that fetches its own data — the standing
    // sentence and the first-run checklist. axe was assessing My Day
    // half-rendered.
    //
    // It went red on a freshly seeded demo: the shell's scroll region does not
    // overflow until those blocks arrive, so axe caught the one frame where the
    // region had become scrollable and had not yet been given its tab stop.
    // Waiting is not papering over that — a rule evaluated against content that
    // has not arrived also MISSES whatever that content would have violated, so
    // this widens the coverage rather than narrowing it.
    await expect(page.getByText(/You’re #\d+/)).toBeVisible()
    await expect(page.getByText('Get set up')).toBeVisible()

    expect(await seriousOrCritical(page)).toEqual([])
  })

  test('the pipeline board', async ({ page }) => {
    await signIn(page)
    await page.goto('/board')
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()

    expect(await seriousOrCritical(page)).toEqual([])
  })

  test('the move sheet, which is the universal move path', async ({ page }) => {
    await signIn(page)
    await page.goto('/board')

    // Discovered from the page rather than pinned: the demo ids are uuidv7 and
    // change on every seed.
    await page.getByRole('link', { name: 'Move' }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()

    expect(await seriousOrCritical(page)).toEqual([])
  })

  test('the public leaderboard', async ({ page }) => {
    await signIn(page)
    await page.goto('/earnings')
    await expect(page.getByRole('heading', { name: 'Earnings' })).toBeVisible()

    expect(await seriousOrCritical(page)).toEqual([])
  })

  test('the search overlay, which is a keyboard surface first', async ({ page }) => {
    // A combobox driving a listbox it does not contain is the shape axe is
    // strictest about, and it is the one this overlay uses on purpose: focus
    // stays in the input while the highlight moves, so `aria-activedescendant`
    // is doing the work a roving tabindex usually does.
    await signIn(page)
    await page.goto('/my-day')

    const dialog = page.getByRole('dialog', { name: 'Search' })
    await expect
      .poll(async () => {
        await page.keyboard.press('Control+k')
        return dialog.count()
      })
      .toBe(1)

    await dialog.getByRole('combobox').fill('Doris')
    await expect(dialog.getByRole('option').first()).toBeVisible()

    expect(await seriousOrCritical(page)).toEqual([])
  })

  test('integration health, including the credential form', async ({ page }) => {
    // ⚠️ THIS SCREEN WAS NEVER UNDER THE GATE. It has existed since the
    // dead-letter work and no axe case ever visited it — a surface outside the
    // scan is not gated, whatever the constitution says. It is added here
    // because 0068 gave it a FORM: a labelled text input, a create button and a
    // two-step revoke, which is the first genuinely interactive control on an
    // admin screen and exactly the class of thing axe exists to check.
    await signInAsAdmin(page)
    await page.goto('/admin/integration-health')
    await expect(page.getByRole('heading', { name: 'Integration health' })).toBeVisible()

    // The section fetches its own data, so the heading is on the page before
    // the credential list is — the same half-rendered trap My Day set above.
    await expect(page.getByRole('heading', { name: 'Aloware connection' })).toBeVisible()
    await expect(page.getByLabel('Add an endpoint')).toBeVisible()

    expect(await seriousOrCritical(page)).toEqual([])
  })

  test('the contact record, and the not-found it shares a shape with', async ({ page }) => {
    await signIn(page)
    await page.goto('/contacts/00000000-0000-7000-8000-0000000000ff')
    await expect(page.getByRole('heading', { name: /isn.t in your book/ })).toBeVisible()

    expect(await seriousOrCritical(page)).toEqual([])
  })

  test('the undo bar, which only exists for five seconds', async ({ page }) => {
    // The clock is faked BEFORE the page loads so the bar's own dismiss timer
    // never fires. Without it this scan races a five-second window, and a
    // flaky accessibility test is a gate that gets deleted.
    //
    // Which also means Playwright's auto-waiting is off — it polls from inside
    // the page. Every wait below comes from the driver instead. This test
    // passed on auto-waiting once, by the accident of clicking before
    // hydration; see ./fixtures/clock.
    await page.clock.install()
    await signIn(page)

    await page.goto('/board')
    await page.getByRole('link', { name: 'Move' }).first().click()
    await expectCount(page.getByRole('dialog'), 1)

    // An open stage, so the scan cannot append to the append-only ledger.
    const target = page.getByRole('dialog').locator('form').first()
    await expectCount(target.locator('input[name="premium"]'), 0)
    await target.getByRole('button', { name: 'Move here' }).click()

    await expectUrl(page, /[?&]moved=/)
    await expectCount(page.locator('[role="status"]'), 1)

    expect(await seriousOrCritical(page)).toEqual([])
  })
})
