import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { QUEUE_SPECS } from '~/jobs/queues'

import { TEST_URL } from './setup/urls'

/**
 * `ref.job_registry` — the latency axis (`05c` §11.7).
 *
 * 🔴 THE DEFECT IT CLOSES, in §2367's own words: `weight ∈ {light, heavy}` is a
 * CPU axis with no latency axis, so during the 20,000-message replay this
 * architecture itself sizes, **a TCPA STOP is job 14,000 in a FIFO drain**.
 * 0069 made a STOP suppress; the lanes are what make it suppress in time.
 *
 * ⚠️ THIS FILE ASSERTS THE CLASSIFICATION AND ITS GATES, NOT THE CLOCK. The
 * protected G6/P24 assertion — one STOP injected during a 20,000-webhook storm,
 * `suppression_list` within 5 s, a dial at T+5 s refused — needs the storm
 * harness in both topologies and is NOT here. What is here is the half that
 * makes that measurement mean something: that the classification exists, that it
 * cannot be omitted, and that the worker cannot silently drop the lane.
 */

let sql: postgres.Sql

beforeAll(() => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await sql?.end()
})

describe('every queue is classified', () => {
  it('registers exactly the queues the built bundle declares', async () => {
    // §2382(b): "any queue name present in the built bundle that has no registry
    // row" must fail. `QUEUE_SPECS` is that bundle — the same list the deploy
    // step creates queues from — so the two are independent and must agree. A
    // queue added to the code and not classified is a queue NO LANE DRAINS, and
    // the worker would start clean and consume nothing from it.
    const rows = await sql<{ queue_name: string }[]>`
      SELECT queue_name FROM ref.job_registry ORDER BY queue_name`

    expect(rows.map((r) => r.queue_name)).toEqual(
      [...QUEUE_SPECS].map((q) => q.name).sort((a, b) => a.localeCompare(b)),
    )
  })

  it('puts the STOP chain and the reminder tick in the compliance lane', async () => {
    const rows = await sql<{ queue_name: string; lane: string }[]>`
      SELECT queue_name, lane FROM ref.job_registry
       WHERE priority = 'compliance' ORDER BY queue_name`

    // 🔴 BOTH, AND THE SECOND IS THE ONE PEOPLE GET WRONG. §11.7.1 puts the
    // reminder tick in `compliance` rather than `interactive` and gives the
    // reason in one line: a late reminder can fire OUTSIDE the legal calling
    // window. It is not a UX promise, it is the same legal axis as the STOP.
    expect(rows.map((r) => r.queue_name)).toEqual(['message-merge', 'scheduled-job-dispatch'])
    for (const row of rows) expect(row.lane).toBe('lane_compliance')
  })

  it('keeps the storm queue OUT of the compliance lane', async () => {
    // `call-merge` is the queue Gate 6's 20,000-webhook storm actually fills.
    // Sharing a lane with the STOP chain is the exact contention the axis
    // exists to remove, so this asserts the separation rather than the value.
    const [call] = await sql<{ lane: string }[]>`
      SELECT lane FROM ref.job_registry WHERE queue_name = 'call-merge'`
    const [message] = await sql<{ lane: string }[]>`
      SELECT lane FROM ref.job_registry WHERE queue_name = 'message-merge'`

    expect(call?.lane).toBe('lane_interactive')
    expect(call?.lane).not.toBe(message?.lane)
  })
})

describe('the classification cannot be omitted or edited quietly', () => {
  it('refuses a row with no priority — NOT NULL and no default', async () => {
    // §2382: "NOT NULL with no default means the classification cannot be
    // omitted". A default — any default — would make "somebody forgot" a silent
    // `bulk`, and the one job where that is fatal is the STOP.
    await expect(
      sql`INSERT INTO ref.job_registry (queue_name, rationale, registered_in_migration)
          VALUES ('unclassified-queue', 'a rationale long enough to pass the check', 'test')`,
    ).rejects.toThrow(/null value in column "priority"|violates not-null/)

    const [col] = await sql<{ has_default: string }[]>`
      SELECT column_default IS NOT NULL AS has_default FROM information_schema.columns
       WHERE table_schema = 'ref' AND table_name = 'job_registry' AND column_name = 'priority'`
    expect(col?.has_default).toBe(false)
  })

  it('refuses to move a queue between lanes by a row edit', async () => {
    // §2407's walkability argument: reclassifying the STOP chain from
    // `compliance` to `bulk` must not be free. The table is registered
    // `immutable`, so harden() installs a refusal trigger and the change costs a
    // migration that drops a protected trigger — which is counted, not quiet.
    await expect(
      sql`UPDATE ref.job_registry SET priority = 'bulk' WHERE queue_name = 'message-merge'`,
    ).rejects.toThrow()

    const [row] = await sql<{ priority: string }[]>`
      SELECT priority::text AS priority FROM ref.job_registry WHERE queue_name = 'message-merge'`
    expect(row?.priority).toBe('compliance')
  })

  it('raises rather than returning NULL for a queue nobody classified', async () => {
    // A NULL lane would flow into a worker that starts cleanly and drains
    // nothing, which is the failure this whole file is about.
    await expect(sql`SELECT ref.job_lane_of('a-queue-that-does-not-exist')`).rejects.toThrow(
      /JL001/,
    )
  })
})

describe('the lane names the worker derives', () => {
  it('generates the lane from the priority, so the two cannot drift', async () => {
    const rows = await sql<{ priority: string; lane: string }[]>`
      SELECT priority::text AS priority, lane FROM ref.job_registry`
    for (const row of rows) expect(row.lane).toBe(`lane_${row.priority}`)
  })

  it('yields the three lanes §11.7 names, and no fourth', async () => {
    const rows = await sql<{ lane: string }[]>`
      SELECT DISTINCT lane FROM ref.job_registry ORDER BY lane`
    expect(rows.map((r) => r.lane)).toEqual(['lane_bulk', 'lane_compliance', 'lane_interactive'])
  })
})
