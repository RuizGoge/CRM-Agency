import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { raiseProcessAlert } from '~/db'
import {
  __forceBreachWindow,
  __installFakeHistogram,
  sampleOnce,
  stopSaturationMonitor,
} from '~/jobs/saturation'
import { admitDelivery, drainSaturation } from '~/lib/ingest/semaphore'

import { TEST_URL } from './setup/urls'

/**
 * The three mechanisms Gate 6 needed and could not find.
 *
 * The storm ran on 2026-08-10 — 20,000 deliveries at 333/s, zero lost — and the
 * gate still could not close, because four of its assertions had no subject.
 * This file is the subject for three of them.
 */

const TENANT = '00000000-0000-7000-8000-0000000e5a01'

let sql: postgres.Sql

/**
 * Drizzle re-wraps the driver's error, so the Postgres message lands one level
 * down in `cause`. The register has this trap written down already — an
 * assertion against the top level watches the refusal work perfectly and
 * reports that it did not.
 */
async function refusalMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.cause : undefined
    return [
      err instanceof Error ? err.message : String(err),
      cause instanceof Error ? cause.message : '',
    ].join(' | ')
  }
  return 'NO REFUSAL'
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  // THE FAN-OUT WRITES ONE ROW PER TENANT, so with no tenants it writes none —
  // which is correct behaviour and made the first version of this file assert
  // nothing at all. The suite needs an agency for the alert to be about.
  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Saturation Agency', 'America/New_York')`
})

afterAll(async () => {
  stopSaturationMonitor()
  await sql?.end()
})

afterEach(async () => {
  // 🔴 THE SUSTAINED WINDOW IS MODULE STATE AND IT LEAKS BETWEEN TESTS. Without
  // this reset the un-acknowledge test inherited a window opened 31 s earlier
  // by the test before it, fired at a different sample than intended, and
  // reported `occurrence_count` of 1 where the assertion wanted 2 — a real
  // failure caused entirely by the harness. Which is also the honest reading of
  // the monitor: a long-lived process carries this state, and that is the
  // point.
  stopSaturationMonitor()
  await sql`DELETE FROM app.admin_alert WHERE kind = 'folded_topology_saturated'`
})

describe('the ingest bulkhead queues and cannot shed', () => {
  it('holds concurrency at the bound and still runs everything', async () => {
    // The property that matters is not the bound — it is that NOTHING is
    // refused for hitting it. G2 measured that Aloware never retries, so a
    // refused delivery is a permanently lost one, and Gate 6's failure
    // criterion is "any webhook lost".
    let concurrent = 0
    let peak = 0
    let completed = 0

    await Promise.all(
      Array.from({ length: 200 }, () =>
        admitDelivery(async () => {
          concurrent += 1
          peak = Math.max(peak, concurrent)
          await new Promise((r) => setTimeout(r, 1))
          concurrent -= 1
          completed += 1
        }),
      ),
    )

    expect(completed, 'a delivery was dropped by the bulkhead').toBe(200)
    expect(peak, 'the bound did not hold').toBeLessThanOrEqual(8)
    expect(peak, 'the bound never engaged, so this proved nothing').toBeGreaterThan(1)
  })

  it('reports a saturation count whose correct value is zero', async () => {
    // 🎯 GATE 6 ASKS FOR "the 429 count". It has a subject after all, and the
    // answer is zero BY CONSTRUCTION rather than by luck: `admitDelivery` takes
    // no options and exposes no path that refuses. 05c:905 asserts the same
    // thing from the other side — Gate 2 requires ZERO 429 on this surface.
    await admitDelivery(() => Promise.resolve())
    const s = drainSaturation()

    expect(s.shed).toBe(0)
    expect(s.inFlight).toBe(0)
  })

  it('measures how long deliveries waited, which is what the alert reports', async () => {
    // Waiting is the correct behaviour and it still has to be VISIBLE. A
    // bulkhead that queues silently is indistinguishable from one that is not
    // engaged, right up until the provider's 110-second tolerance runs out.
    drainSaturation()
    await Promise.all(
      Array.from({ length: 40 }, () => admitDelivery(() => new Promise((r) => setTimeout(r, 2)))),
    )
    const s = drainSaturation()

    expect(s.peakQueued, 'the queue never grew, so nothing was measured').toBeGreaterThan(0)
    expect(s.maxWaitMs).toBeGreaterThan(0)
  })
})

describe('the event-loop monitor fires the alert §2444 names', () => {
  it('does NOT fire below the threshold, however long it lasts', async () => {
    // The negative control, and it goes first. Every assertion below is
    // satisfied by a monitor that fires constantly, and an alert that is always
    // on is the same as no alert while being harder to notice.
    __installFakeHistogram(199)
    __forceBreachWindow(0)
    const sample = await sampleOnce(10 * 60_000)

    expect(sample.alerted).toBe(false)
    const rows = await sql`SELECT 1 FROM app.admin_alert WHERE kind = 'folded_topology_saturated'`
    expect(rows).toHaveLength(0)
  })

  it('does NOT fire above the threshold until it is SUSTAINED', async () => {
    // §2444 says "p99 > 200 ms sustained 60 s". One spike is not saturation:
    // a GC pause is over before an operator could read about it.
    __installFakeHistogram(500)
    const first = await sampleOnce(0)
    expect(first.alerted).toBe(false)

    const short = await sampleOnce(30_000)
    expect(short.alerted, 'fired after 30 s, but the window is 60').toBe(false)
  })

  it('fires once the breach has lasted the full window', async () => {
    __installFakeHistogram(450, 900)
    await sampleOnce(0)
    const fired = await sampleOnce(60_000)

    expect(fired.alerted).toBe(true)
    expect(fired.loopP99Ms).toBe(450)

    // ONE ROW PER TENANT. The event loop is a property of the PROCESS, so the
    // statement is true for every agency it serves, and attributing it to one
    // would be a lie that reads like data.
    const [tenants] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app.tenant`
    const all = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.admin_alert WHERE kind = 'folded_topology_saturated'`
    expect(all[0]?.n).toBe(tenants?.n ?? 0)
    expect(tenants?.n ?? 0).toBeGreaterThan(0)

    const rows = await sql<{ detail: string; kind: string }[]>`
      SELECT kind, detail FROM app.admin_alert
       WHERE kind = 'folded_topology_saturated' AND tenant_id = ${TENANT}`
    expect(rows).toHaveLength(1)

    // §2444's remediation string, verbatim. An operator reading "the event loop
    // is slow" learns nothing they can act on; "Split the processes" is an
    // action.
    expect(rows[0]?.detail).toContain('Split the processes.')
    expect(rows[0]?.detail).toContain('450 ms')
  })

  it('clears an interrupted window rather than accumulating toward the alert', async () => {
    // "Sustained" means without interruption. A running average would let a
    // process that is fine most of the time accumulate its way to an alert,
    // which is a different claim than the one §2444 makes.
    __installFakeHistogram(500)
    await sampleOnce(0)

    __installFakeHistogram(10)
    await sampleOnce(30_000)

    __installFakeHistogram(500)
    await sampleOnce(31_000)
    const later = await sampleOnce(70_000)

    // 70 s after the FIRST breach, but only 39 s after the window restarted.
    expect(later.alerted).toBe(false)
  })

  it('un-acknowledges on recurrence, so the second storm is not silent', async () => {
    // 🔴 `admin_alert_subject_uidx` IS NOT PARTIAL, so a row acknowledged once
    // would be silenced forever — for a condition that comes and goes, that
    // means the FIRST storm is the only one anybody is ever told about.
    __installFakeHistogram(400)
    await sampleOnce(0)
    await sampleOnce(60_000)

    await sql`UPDATE app.admin_alert SET acknowledged_at = clock_timestamp()
               WHERE kind = 'folded_topology_saturated'`

    await sampleOnce(120_000)

    const rows = await sql<{ acknowledged_at: Date | null; occurrence_count: number }[]>`
      SELECT acknowledged_at, occurrence_count FROM app.admin_alert
       WHERE kind = 'folded_topology_saturated' AND tenant_id = ${TENANT}`
    expect(rows).toHaveLength(1)

    expect(rows[0]?.acknowledged_at, 'the recurrence stayed acknowledged').toBeNull()
    expect(rows[0]?.occurrence_count).toBeGreaterThan(1)
  })
})

describe('the process alert writer cannot manufacture a business signal', () => {
  it('refuses any kind that is not process health', async () => {
    // 0049 refuses to grant `admin_alert_raise` to the application by name:
    // "granting EXECUTE to the application would let a request manufacture an
    // operational signal". That reasoning holds, so this writer is narrower —
    // the worst a forged call can do is tell an admin the process is slow.
    expect(await refusalMessage(() => raiseProcessAlert('unmapped_number', 'forged'))).toMatch(
      /PA001/,
    )
    expect(
      await refusalMessage(() => raiseProcessAlert('reconciliation_unavailable', 'forged')),
    ).toMatch(/PA001/)
  })

  it('refuses an alert with no detail', async () => {
    // A row saying only that something happened is a row an operator cannot act
    // on, which is the same as no row with extra noise.
    expect(
      await refusalMessage(() => raiseProcessAlert('folded_topology_saturated', '   ')),
    ).toMatch(/PA002/)
  })

  it('is refused by the TABLE too, not only by the function', async () => {
    // Two layers, and they are not redundant: the CHECK is what holds if a
    // later migration adds a second writer that forgets the list.
    await expect(
      sql`INSERT INTO app.admin_alert (tenant_id, kind, subject_key, detail)
          SELECT id, 'not_a_kind', '', 'x' FROM app.tenant LIMIT 1`,
    ).rejects.toThrow(/admin_alert_kind/)
  })
})
