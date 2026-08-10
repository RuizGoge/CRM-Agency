import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { jsonConditional } from '~/lib/http/conditional'
import { readBoardFor, type Period } from '~/routes/api/leaderboard'

import {
  FLOOR_ACTIVITIES,
  FLOOR_CONTACTS,
  FLOOR_LEDGER_ROWS,
  FLOOR_SELLER,
  FLOOR_SELLERS,
  FLOOR_TENANT,
  readPerfFloorShape,
  seedPerfFloor,
} from './fixtures/perf-floor'

/**
 * **P11 — leaderboard poll cost: p95 server time for a `304`.**
 *
 * `04b` §3.2 publishes the row: warn over **40 ms**, red over **80 ms**, tier
 * `server`. It is one half of Gate 6's floor leg, whose other half is P7 (API
 * p95 over the fourteen endpoints of §3.4, 50 virtual sellers).
 *
 * WHY THIS NUMBER CARRIES SO MUCH. §1183 builds the entire cost model on it:
 * *"At an assumed 2 ms of process CPU per `304` … 17 req/s × 2 ms = 34 ms of
 * CPU per wall second ≈ 7 % of a 0.5-CPU Starter instance. That is the number
 * that makes a 5-second poll compatible with USD 7/month of compute."* And it
 * says plainly that the 2 ms *"is an assumption until Puerta 2 measures it"*.
 * This is that measurement, for the surface it was written about.
 *
 * WHAT IS TIMED, and it is the honest whole rather than the flattering part:
 * everything the server does to answer a `304` — the projection read, the
 * payload build, the serialization and the tag comparison. The tag is derived
 * from the RENDERED body (see `~/lib/http/conditional`), so a `304` costs a
 * `200` minus the transfer. Timing only the comparison would report a number
 * about `===`.
 *
 * NOT A BROWSER, and not a round trip. P5.3 draws the same line for N13: the
 * SERVER p95 is the budget and the end-to-end figure is a consequence. A
 * network number here would measure this machine's loopback.
 */

/** The published thresholds, quoted rather than chosen. `04b` §3.2, row P11. */
const P11_WARN_MS = 40
const P11_RED_MS = 80

/** Enough samples for a p95 to mean something, few enough to stay a test. */
const RUNS = 40

const IDENTITY = { tenantId: FLOOR_TENANT, userId: FLOOR_SELLER }

/** All four, because the poll a seller leaves running is whichever they chose. */
const PERIODS: readonly Period[] = ['day', 'week', 'month', 'all_time']

beforeAll(async () => {
  await seedPerfFloor()
}, 300_000)

afterAll(() => {
  // Nothing to tear down: `crm_test` is dropped and rebuilt by globalSetup, so
  // a fixture that cleaned up after itself would only be slower.
})

describe('the floor fixture is the size it claims to be', () => {
  it('holds fifty books, the ledger behind them, and all four periods', async () => {
    // ASSERTED BEFORE ANYTHING IS TIMED. §3.5: *"an 'improvement' caused by a
    // smaller fixture fails"* — and for this budget the trap is specific. The
    // public board reads `leaderboard_projection`, so a fixture with fifty
    // sellers and no money produces an EMPTY projection, and a 304 measured
    // against an empty table is fast for the one reason that cannot be shipped.
    const shape = await readPerfFloorShape()

    expect(shape.sellers, 'perf-floor is defined as fifty books').toBe(FLOOR_SELLERS)
    expect(shape.contacts).toBe(FLOOR_CONTACTS)
    expect(shape.ledgerRows, 'the projection has nothing behind it').toBe(FLOOR_LEDGER_ROWS)
    expect(shape.activities).toBe(FLOOR_ACTIVITIES)

    // day · week · month · all_time. A projection missing a period_type is a
    // board whose selector has nothing to select between.
    expect(shape.projectionPeriods, 'the ledger did not spread across four periods').toBe(4)
  })

  it('nests the four periods, with all-time strictly above today', async () => {
    // Checked through the product's own read rather than against the fixture's
    // arithmetic.
    //
    // 🔬 NESTING, NOT FOUR DISTINCT TOTALS, and the difference was measured.
    // The first version demanded four different numbers and went red on a
    // Sunday — the week bucket lands on Monday, so on the FIRST day of a period
    // it coincides with the day bucket and two totals are legitimately equal.
    // Requiring distinctness was a wish about the calendar; what the product
    // actually guarantees is that the periods contain one another.
    const totals = await Promise.all(
      PERIODS.map(async (p) => BigInt((await readBoardFor(IDENTITY, p)).floorTotalCents)),
    )
    const [day, week, month, allTime] = totals as [bigint, bigint, bigint, bigint]

    expect(day <= week, `day ${day} > week ${week}`).toBe(true)
    expect(week <= month, `week ${week} > month ${month}`).toBe(true)
    expect(month <= allTime, `month ${month} > all-time ${allTime}`).toBe(true)

    // And the selector demonstrates SOMETHING: a board where every period reads
    // the same is a board whose selector proves nothing, whatever day it is.
    expect(allTime > day, `all-time ${allTime} is not above today ${day}`).toBe(true)
  })
})

describe('P11 · the cost of a leaderboard 304', () => {
  it('answers a conditional poll inside the published budget', async () => {
    const url = 'http://floor.test/api/leaderboard?period=all_time'

    // The tag the client would be holding, obtained the way a client obtains
    // it: from a real 200.
    const warm = jsonConditional(new Request(url), await readBoardFor(IDENTITY, 'all_time'))
    expect(warm.status).toBe(200)
    const tag = warm.headers.get('etag')
    expect(tag, 'the leaderboard served no tag, so there is no 304 to measure').toBeTruthy()

    const conditional = new Request(url, { headers: { 'if-none-match': tag ?? '' } })

    const samples: number[] = []
    // SPLIT IN TWO, because the fix depends on which half it is. N13's first
    // measurement was 1,053 ms and the answer was the QUERY, not the schema —
    // the index was already there and the SQL could not use it. A total with no
    // split would send the next reader to optimise whichever half they guessed.
    const readMs: number[] = []
    const tagMs: number[] = []

    for (let i = 0; i < RUNS; i += 1) {
      const started = performance.now()
      const payload = await readBoardFor(IDENTITY, 'all_time')
      const afterRead = performance.now()
      const response = jsonConditional(conditional, payload)
      const done = performance.now()

      samples.push(done - started)
      readMs.push(afterRead - started)
      tagMs.push(done - afterRead)

      // EVERY RUN, not once at the end. A loop that silently started answering
      // 200 would report the cost of the thing this budget exists to avoid,
      // under the name of the thing it exists to protect.
      expect(response.status, 'the poll stopped being conditional mid-measurement').toBe(304)
    }

    const sorted = [...samples].sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Infinity
    const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity

    const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

    console.log(
      `[P11] leaderboard 304 over ${FLOOR_SELLERS} sellers / ${FLOOR_LEDGER_ROWS} ledger rows — ` +
        `p95=${p95.toFixed(1)}ms median=${median.toFixed(1)}ms ` +
        `min=${(sorted[0] ?? 0).toFixed(1)}ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(1)}ms ` +
        `(04b §3.2: warn>${P11_WARN_MS}, red>${P11_RED_MS})`,
    )
    console.log(
      `[P11] split — read(mean)=${mean(readMs).toFixed(1)}ms ` +
        `tag+serialize(mean)=${mean(tagMs).toFixed(1)}ms`,
    )

    expect(p95, `a 304 costs ${p95.toFixed(1)}ms, over the §3.2 ceiling`).toBeLessThanOrEqual(
      P11_RED_MS,
    )
    // Forty real reads against a fifty-book projection do not fit vitest's
    // five-second default, and a measurement that times out reports nothing.
  }, 120_000)

  it('costs the same on every period a seller can leave selected', async () => {
    // The poll runs on whichever period the seller chose, and `all_time` is the
    // default on every fresh load (R5.3). A budget measured only on the default
    // would miss a `day` board that scans differently.
    for (const period of PERIODS) {
      const first = jsonConditional(
        new Request(`http://floor.test/api/leaderboard?period=${period}`),
        await readBoardFor(IDENTITY, period),
      )
      const tag = first.headers.get('etag') ?? ''
      const conditional = new Request(`http://floor.test/api/leaderboard?period=${period}`, {
        headers: { 'if-none-match': tag },
      })

      const samples: number[] = []
      for (let i = 0; i < 12; i += 1) {
        const started = performance.now()
        const response = jsonConditional(conditional, await readBoardFor(IDENTITY, period))
        samples.push(performance.now() - started)
        expect(response.status).toBe(304)
      }

      const sorted = [...samples].sort((a, b) => a - b)
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Infinity
      console.log(`[P11] ${period}: p95=${p95.toFixed(1)}ms`)
      expect(p95, `${period} costs ${p95.toFixed(1)}ms`).toBeLessThanOrEqual(P11_RED_MS)
    }
  }, 120_000)
})
