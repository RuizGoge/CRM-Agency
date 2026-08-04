import { readFileSync } from 'node:fs'

import { expect, test } from '@playwright/test'

import { measureTti, median, perfSellerCookie } from './fixtures/lighthouse'
import { PERF_CARD_COUNT, PERF_STAGES, readPerf500Shape, seedPerf500 } from './fixtures/perf-500'

/**
 * Sprint-0 Gate 11, the half that was open — P20, mobile time-to-interactive.
 *
 * The bundle half has been measured and enforced since 2026-08-02. This one was
 * a row in `perf-budgets.json` with `"value": null` and a `blocked_on` list, and
 * the list had gone stale: it named the `perf-500` fixture, which Gate 12 built.
 * What was actually missing was a tier that RUNS Lighthouse.
 *
 * IT RUNS HERE RATHER THAN IN A NIGHTLY JOB, and that is a deliberate downgrade
 * of the original plan. A nightly GitHub Actions tier costs minutes, and cost
 * control on this project is the absence of a payment method (§9.4.1) — so a
 * nightly tier is a gate that would be switched off before it ever caught
 * anything. The e2e suite already builds the production bundle and serves it on
 * :3001 for the drag budget; measuring here costs one existing server and about
 * forty seconds, and it runs on every full suite instead of on a schedule
 * nobody is paying for.
 *
 * ⚠️ THIS NUMBER IS MACHINE-DEPENDENT, unlike P12 and P13. Those count bytes and
 * would report the same total on any computer. Lighthouse simulates the network
 * but multiplies THIS machine's observed task durations by four, so a slower
 * runner measures a larger TTI. The consequence is worth stating plainly because
 * the ratchet makes it sharp: if this gate is ever run somewhere slower than
 * where 2300 was measured, it goes red, and `monotonic_down` will refuse to
 * loosen it. That refusal is the mechanism working — re-baselining a budget onto
 * different hardware should be a decision somebody makes, not a number that
 * drifts up when the CI fleet changes.
 */

interface Budget {
  readonly id: string
  readonly value: number | null
  readonly ceiling: number
  readonly runs: number
}

const budget = (
  JSON.parse(readFileSync('perf-budgets.json', 'utf8')) as { budgets: readonly Budget[] }
).budgets.find((b) => b.id === 'P20')

if (!budget) throw new Error('P20 is missing from perf-budgets.json')

test.describe('P20 · the board is interactive on a phone inside budget', () => {
  test.beforeAll(async () => {
    await seedPerf500()
  })

  test('measures time-to-interactive on a 500-card board under mobile throttling', async ({
    baseURL,
  }) => {
    test.setTimeout(180_000)

    // THE FIXTURE IS ASSERTED BEFORE ANYTHING IS MEASURED (04b §3.6), for the
    // same reason Gate 12 asserts it: a board with 200 cards is interactive
    // sooner, and "an improvement caused by a smaller fixture fails".
    const shape = await readPerf500Shape()
    expect(shape.cards, 'perf-500 must hold exactly 500 cards').toBe(PERF_CARD_COUNT)
    expect(shape.stages, 'perf-500 is defined as six stages').toBe(PERF_STAGES.length)

    if (baseURL === undefined) throw new Error('the lh-ci profile must carry a baseURL')

    const cookie = await perfSellerCookie(baseURL)
    const { samples, finalUrl } = await measureTti(`${baseURL}/board`, cookie, budget.runs)

    // 🔴 THE ASSERTION THAT KEEPS THE REST HONEST. Without a session the shell
    // redirects, and Lighthouse would happily measure the SIGN-IN page — a form
    // with no cards, interactive almost immediately, reporting a number that
    // looks like a triumph. A budget measured against the wrong page passes
    // forever and protects nothing.
    expect(finalUrl, 'lighthouse must have measured /board, not the sign-in redirect').toContain(
      '/board',
    )

    const ttis = samples.map((s) => s.ttiMs)
    const measured = Math.round(median(ttis))

    console.log(
      `[P20] median of ${budget.runs} runs — tti=${measured}ms ` +
        `(all runs: ${ttis.map((t) => Math.round(t)).join(', ')}) ` +
        `fcp=${Math.round(median(samples.map((s) => s.fcpMs)))}ms ` +
        `tbt=${Math.round(median(samples.map((s) => s.tbtMs)))}ms ` +
        `(budget ${budget.value ?? 'UNSET'}ms, ceiling ${budget.ceiling}ms)`,
    )

    // A row that reaches this tier with no number is E6's null-budget failure,
    // and it fails HERE as well as in the checker — this is the process that can
    // actually produce the number, so it is the one that has to refuse without
    // it. The message carries the value §8.1 prescribes so nobody has to
    // rediscover the rounding rule.
    expect(
      budget.value,
      `P20 has no value. Measured ${measured}ms; §8.1 rounds up to the next 100 ms, so ` +
        `write ${Math.ceil(measured / 100) * 100} into perf-budgets.json and register it in ` +
        `ref.ci_ratchet with a migration.`,
    ).not.toBeNull()

    // The ceiling is not the budget. §8.1 caps what a measurement is ALLOWED to
    // fix the budget at: past 3000 ms the answer is to make the board faster,
    // not to write down what it currently does.
    expect(measured, `${measured}ms exceeds the 3000ms ceiling §8.1 sets`).toBeLessThanOrEqual(
      budget.ceiling,
    )

    expect(
      measured,
      `${measured}ms over a budget of ${budget.value}ms. Do not raise the number: the row is ` +
        `monotonic_down and ref.ci_ratchet refuses a loosening with AP002.`,
    ).toBeLessThanOrEqual(budget.value ?? budget.ceiling)
  })
})
