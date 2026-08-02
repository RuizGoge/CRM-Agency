import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Waiting that survives a faked clock.
 *
 * THE TRAP, and it cost a debugging pass: Playwright's built-in auto-waiting —
 * `expect(locator).toBeVisible()`, `waitForSelector` — polls from INSIDE the
 * page. `page.clock.install()` freezes the page's timers, so the poll never
 * runs a second time and a five-second assertion silently becomes a one-shot
 * check taken the instant the click returns. A client-side form submission has
 * not landed yet at that moment, so the assertion fails while the element
 * appears milliseconds later.
 *
 * What made it hard to see: the same assertion PASSED in another spec, because
 * there the click happened before hydration and submitted natively — a full
 * navigation, which `click()` waits out, so the one shot landed after the DOM
 * was already right. Two tests, same code, opposite results, decided by
 * hydration timing.
 *
 * `expect.poll` runs the callback from Node, one protocol round trip at a
 * time. It is unaffected by the page's clock, which is the whole point.
 */
export async function expectCount(target: Locator, count: number): Promise<void> {
  await expect.poll(() => target.count(), { timeout: 10_000 }).toBe(count)
}

export async function expectText(target: Locator, text: string): Promise<void> {
  await expect.poll(() => target.first().textContent(), { timeout: 10_000 }).toContain(text)
}

/** The board after a navigation has settled, without trusting a page timer. */
export async function expectUrl(page: Page, pattern: RegExp): Promise<void> {
  await expect.poll(() => page.url(), { timeout: 10_000 }).toMatch(pattern)
}

/**
 * The board is loaded AND hydrated. Anchor for every "this must not appear"
 * assertion.
 *
 * `expectCount(x, 0)` passes the instant it sees zero, which a page that has
 * not rendered yet also satisfies — so an absence assertion made too early
 * passes for the wrong reason and would go on passing if the thing it forbids
 * started appearing. Caught by writing a reload test that passed before the
 * reload had finished.
 *
 * `[data-drag]` is the anchor: the attribute is absent until the drag effect has
 * run and then reads `on` or `off`. Its PRESENCE means React mounted and ran
 * effects — the state in which a celebration would have appeared if it were
 * going to — and it says so on both profiles, unlike anything that only exists
 * where drag is armed.
 */
export async function expectBoardSettled(page: Page): Promise<void> {
  await expect.poll(() => page.locator('main [data-drag]').count(), { timeout: 10_000 }).toBe(1)
}
