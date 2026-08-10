import { expect, test, type Page } from '@playwright/test'

import { expectCount } from './fixtures/clock'
import {
  PERF_CARD_COUNT,
  PERF_OPEN_STAGES,
  PERF_SELLER_LOGIN,
  PERF_STAGES,
  readPerf500Shape,
  seedPerf500,
} from './fixtures/perf-500'
import { MAX_RENDERED_PER_COLUMN, VIRTUALIZE_ABOVE } from '~/lib/board/virtual-window'

/**
 * `04b` §2.1's virtualization contract, on a real board.
 *
 * THIS SPEC EXISTS BECAUSE P6's ENGAGEMENT ASSERTION HAD TO CHANGE, and it is
 * the reason that change is not a weakening. `drag-perf.spec.ts` asserted
 * `rendered === 500` — *"500 cards must be mounted while measuring"* — to close
 * a specific hole: a green frame budget obtained by measuring a board that was
 * not there. But the number it chose to express that is the one `04b` §9 R2-2
 * makes a BUILD FAILURE: *"> 14 cards rendered per column at any viewport"*. The
 * gate and the specification wanted opposite things, and the gate was written
 * second, by me, in a session where virtualization did not exist.
 *
 * So the property moved rather than went away, and it moved to somewhere
 * stronger. `rendered === 500` proved one thing — the board under the drag was
 * the whole board. Three assertions here prove it and more:
 *
 *   the fixture holds 500          the same precondition, unchanged
 *   the columns REPORT 500         server-computed counts, summed on screen
 *   scrolling reaches card N-1     no card was silently dropped by the window
 *
 * The third is the one `rendered === 500` could never make, because a board that
 * mounts everything cannot lose anything. A windowed board can, and losing a
 * card is a seller losing a lead — the failure that has no symptom, because a
 * column that ends one card early looks exactly like a column with one fewer
 * card in it.
 *
 * And the inverse is now asserted too: mounting MORE than 14 is red. The old
 * gate would have gone green on the regression this one is built to catch.
 */

async function signInAsPerfSeller(page: Page): Promise<void> {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(PERF_SELLER_LOGIN.email)
  await page.getByLabel('Password').fill(PERF_SELLER_LOGIN.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expectCount(page.getByRole('navigation', { name: 'Main' }), 1)
  await page.goto('/board')
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()

  // 🔴 WAITS FOR HYDRATION, and leaving this out was a defect that passed for
  // weeks and then failed only inside the full suite. Every marker these tests
  // read — `data-virtualized`, `data-card-total`, the first ten cards — is
  // rendered by the SERVER, so they are all true before any JavaScript has run.
  // The scroll handler is not: without it a column scrolls natively and the
  // window never moves, so `reaches the LAST card` looked for card 499 in a
  // page that was still showing the server's ten.
  //
  // It only went red once the board gained a poller and the suite got slower,
  // which is the point — the test was always racing hydration and winning by
  // luck.
  //
  // THE ATTRIBUTE, NOT ITS VALUE, and the first version got that wrong too:
  // waiting for `'on'` passed on desktop and hung on mobile, where drag is
  // correctly OFF. `pipeline-columns.tsx` states the rule where the attribute
  // is written — it is absent until the effect has run, so its PRESENCE is the
  // hydration signal and its value is a separate answer about this viewport.
  await expect(page.locator('main [data-drag]')).toHaveAttribute('data-drag', /^(on|off)$/)
}

const zone = (page: Page, stage: string) =>
  page.locator(`section[aria-label="${stage}"] > [data-virtualized]`)

test.describe('04b §2.1 · the board windows its columns', () => {
  test.beforeAll(async () => {
    await seedPerf500()
  })

  test('mounts a window, and the column still reports the whole column', async ({ page }) => {
    // The fixture precondition, first and for the same reason P6 states it
    // first: §3.5 rules that *"an 'improvement' caused by a smaller fixture
    // fails"*, and every number below is meaningless against 200 cards.
    const shape = await readPerf500Shape()
    expect(shape.cards, 'perf-500 must hold exactly 500 cards').toBe(PERF_CARD_COUNT)
    expect(shape.stages).toBe(PERF_STAGES.length)

    await signInAsPerfSeller(page)

    // THE COUNTS ON SCREEN SUM TO THE WHOLE FIXTURE. This is what carries the
    // property `rendered === 500` used to carry: the board being measured is
    // the whole board. It is server-computed and rendered in each column
    // header, so it stays true no matter how few cards are mounted — which is
    // exactly why it survives virtualization and the DOM count did not.
    const reported = await page.evaluate(() =>
      [...document.querySelectorAll('main section[aria-label] > [data-card-total]')].map((el) =>
        Number(el.getAttribute('data-card-total')),
      ),
    )
    expect(
      reported.reduce((a, b) => a + b, 0),
      'the board is not the whole board',
    ).toBe(PERF_CARD_COUNT)

    // R2-2, the half that is new. Every column is over the threshold on this
    // fixture — 500 across four open stages is 125 each — so every column must
    // be windowed and none may exceed the node budget.
    for (const stage of PERF_OPEN_STAGES) {
      const column = zone(page, stage)
      await expect(column).toHaveAttribute('data-virtualized', 'on')

      const total = Number(await column.getAttribute('data-card-total'))
      expect(total, `${stage} is below the threshold and would not window`).toBeGreaterThan(
        VIRTUALIZE_ABOVE,
      )

      const mounted = await column.locator('article').count()
      expect(mounted, `${stage} mounts ${mounted} cards, over R2-2's ceiling`).toBeLessThanOrEqual(
        MAX_RENDERED_PER_COLUMN,
      )
      // And not so few that the column has visible holes: the window has to
      // cover the viewport, or virtualization is just missing cards.
      expect(
        mounted,
        `${stage} mounts ${mounted} cards, which cannot fill a column`,
      ).toBeGreaterThan(1)
    }
  })

  test('reaches the LAST card of a column by scrolling', async ({ page }) => {
    // The assertion a board that mounts everything cannot make, and the one
    // failure mode virtualization introduces that has no symptom. An off-by-one
    // at the bottom edge does not look broken: the column simply ends, exactly
    // as a column with one fewer card would. A seller finds out when a lead
    // they know they have is not on the board.
    await signInAsPerfSeller(page)

    const stage = PERF_OPEN_STAGES[0]
    expect(stage, 'perf-500 has no open stages').toBeDefined()
    if (!stage) return

    const column = zone(page, stage)
    const total = Number(await column.getAttribute('data-card-total'))
    expect(total).toBeGreaterThan(VIRTUALIZE_ABOVE)

    // The first card of the column is mounted and the last is not — otherwise
    // the scroll below proves nothing.
    await expect(column.locator('[data-card-index="0"]')).toHaveCount(1)
    await expect(column.locator(`[data-card-index="${total - 1}"]`)).toHaveCount(0)

    await column.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })

    await expect(
      column.locator(`[data-card-index="${total - 1}"]`),
      'the last card of the column is unreachable',
    ).toHaveCount(1)

    // Still inside the budget at the bottom, where the clamp runs.
    const mounted = await column.locator('article').count()
    expect(mounted).toBeLessThanOrEqual(MAX_RENDERED_PER_COLUMN)

    // And the top is released rather than accumulated — a "virtualizer" that
    // only ever appends is a slow leak that passes every count taken early.
    await expect(column.locator('[data-card-index="0"]')).toHaveCount(0)
  })

  test('lays the window out on exactly the pitch the token declares', async ({ page }) => {
    // R2-1 asks for two things and `card-anatomy.spec.ts` measures one of them:
    // it collects card HEIGHTS and calls the set of them the pitch. Height is
    // not pitch. The distance from one card's top to the next is what the
    // scroll container computes offsets in, and until this test nothing in the
    // tree compared it to anything.
    //
    // In the windowed path they cannot merely happen to agree: the offsets ARE
    // `calc(var(--card-pitch) * i)`, so this asserts that the number the
    // stylesheet lays out on is the number the arithmetic counts in. If they
    // part, cards overlap or gap and the drop target lands on the wrong card.
    //
    // 🔬 WHAT THIS TEST CANNOT SEE, measured rather than assumed. Retuning
    // `--size-card-pitch` to 120 — the stale figure `04b` §2.1 publishes — left
    // this GREEN. It proves the layout and the arithmetic agree with EACH
    // OTHER, and at 120 they still do: every card simply sits flush against the
    // next with the design gap gone. What went red was
    // `tests/integration/card-height.test.ts`, which compares the pitch to the
    // PINNED card height and names the missing 8px. Two tests, two different
    // questions, and neither is redundant.
    await signInAsPerfSeller(page)

    const expected = await page.evaluate(() =>
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--card-pitch'),
      ),
    )
    expect(expected, '--card-pitch does not resolve to a number').toBeGreaterThan(0)

    const stage = PERF_OPEN_STAGES[0]
    if (!stage) return
    const column = zone(page, stage)

    const tops = await column.locator('article').evaluateAll((els) =>
      els
        .map((el) => ({
          index: Number(el.getAttribute('data-card-index')),
          top: el.getBoundingClientRect().top,
          height: el.getBoundingClientRect().height,
        }))
        .sort((a, b) => a.index - b.index),
    )
    expect(tops.length, 'no cards to measure').toBeGreaterThan(2)

    const cardH = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-h')),
    )

    for (let i = 1; i < tops.length; i += 1) {
      const prev = tops[i - 1]
      const cur = tops[i]
      if (!prev || !cur) continue
      expect(cur.index - prev.index, 'the mounted window is not contiguous').toBe(1)
      expect(
        Math.abs(cur.top - prev.top - expected),
        `pitch between card ${prev.index} and ${cur.index} is ${cur.top - prev.top}, not ${expected}`,
      ).toBeLessThan(1)
    }

    // The card box itself, in the windowed path. `card-anatomy.spec.ts` only
    // ever sees the plain-DOM path, because the demo tenant never reaches
    // thirty cards in a column — so absolute positioning could have broken the
    // height on a real seller's board with every existing spec still green.
    for (const card of tops) {
      expect(Math.abs(card.height - cardH), `card ${card.index} is ${card.height}px`).toBeLessThan(
        3,
      )
    }
  })

  test('never drops focus to body when the column scrolls under it', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-ci', 'one keyboard path, one profile')

    // `04b` §1.9: *"Focus is never dropped to `<body>`"* — a ratified rule, and
    // virtualization is the one thing in this product that can break it without
    // anybody writing a bug. Tabbing alone does not expose it, because the
    // browser scrolls a newly focused element into view and the window follows.
    // Scrolling with focus parked in the column is what drops it.
    await signInAsPerfSeller(page)

    const stage = PERF_OPEN_STAGES[0]
    if (!stage) return
    const column = zone(page, stage)

    await column.locator('[data-card-index="1"]').getByRole('link', { name: 'Move' }).focus()
    await expect(page.locator('[data-card-index="1"] a:focus')).toHaveCount(1)

    await column.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })

    const landed = await page.evaluate(() => {
      const active = document.activeElement
      return {
        isBody: active === document.body || active === null,
        cardIndex: active?.closest('[data-card-index]')?.getAttribute('data-card-index') ?? null,
      }
    })

    expect(landed.isBody, 'focus was dropped to body by the virtualizer').toBe(false)
    expect(landed.cardIndex, 'the focused card was unmounted out from under it').toBe('1')
  })
})
