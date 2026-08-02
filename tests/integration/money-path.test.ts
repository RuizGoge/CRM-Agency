import { readFileSync } from 'node:fs'

import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'
import { UNDO_PROJECTION_GUARD_MS, UNDO_WINDOW_MS } from '~/styles/tokens/timing'

import { TEST_URL } from './setup/urls'

/**
 * The money path, asserted before a single screen exists.
 *
 * `earnings_ledger` is the one artifact the product cannot reconstruct: it is
 * append-only, forward-only, and has no recompute job by design. Every
 * assertion here is about a failure that produces a believable wrong number
 * rather than an error — which is the only kind of failure that survives to
 * production on a public board fifty people watch.
 */

const TENANT = '00000000-0000-7000-8000-0000000000f4'
const SELLER = '00000000-0000-7000-8000-0000000000c1'
const RIVAL = '00000000-0000-7000-8000-0000000000c2'
/**
 * Owns no other entry in this file, deliberately. The undo assertions shrink
 * the reveal delay, which would also un-hide anything another test wrote in the
 * previous few seconds — and the run would fail, or pass, on timing that has
 * nothing to do with what is being asserted.
 */
const UNDOER = '00000000-0000-7000-8000-0000000000c3'

/** $249.99 monthly — the Final Expense case the Money unit test also pins. */
const MONTHLY_CENTS = 24_999n
const ANNUAL_CENTS = 299_988n

let sql: postgres.Sql

async function seedEntry(
  owner: string,
  sourceEventId: string,
  deltaCents: bigint,
  occurredAt = '2026-03-15T18:30:00Z',
): Promise<{ entryId: string; wasDuplicate: boolean }> {
  return withTenant({ tenantId: TENANT, userId: owner }, async (tx) => {
    const rows = await tx.execute<{ entry_id: string; was_duplicate: boolean }>(
      raw`SELECT * FROM app.ledger_append(
            ${owner}::uuid, ${sourceEventId}::uuid, 'opportunity.won',
            'sale'::app.ledger_entry_type, ${deltaCents.toString()}::bigint,
            ${occurredAt}::timestamptz,
            '00000000-0000-7000-8000-00000000aaa1'::uuid,
            '00000000-0000-7000-8000-00000000bbb1'::uuid,
            NULL, 'Closed Won', 1::bigint, NULL, NULL, NULL, NULL)`,
    )
    const row = rows[0]
    if (!row) throw new Error('ledger_append returned nothing')
    return { entryId: row.entry_id, wasDuplicate: row.was_duplicate }
  })
}

/** The other half of an undo: a reversal that names the credit it cancels. */
async function seedReversal(
  owner: string,
  sourceEventId: string,
  deltaCents: bigint,
  reversesEntryId: string,
): Promise<void> {
  await withTenant({ tenantId: TENANT, userId: owner }, (tx) =>
    tx.execute(
      raw`SELECT * FROM app.ledger_append(
            ${owner}::uuid, ${sourceEventId}::uuid, 'opportunity.reopened',
            'reversal'::app.ledger_entry_type, ${deltaCents.toString()}::bigint,
            '2026-03-15T18:30:00Z'::timestamptz,
            '00000000-0000-7000-8000-00000000aaa1'::uuid,
            '00000000-0000-7000-8000-00000000bbb1'::uuid,
            NULL, 'Closed Won', 1::bigint, NULL, NULL, NULL,
            ${reversesEntryId}::uuid)`,
    ),
  )
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  // America/New_York on purpose: the fixture times below straddle a UTC day
  // boundary that this timezone puts on the other side.
  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Money Agency', 'America/New_York')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${SELLER}, 'closer@money.test', 'Cleo Closer', 'Cleo', 'seller'),
      (${TENANT}, ${RIVAL},  'rival@money.test',  'Rita Rival',  'Rita', 'seller'),
      (${TENANT}, ${UNDOER}, 'undoer@money.test', 'Uma Undo',    'Uma',  'seller')`
})

afterAll(async () => {
  await sql?.end()
})

describe('the ledger cannot be mutated, by anyone, by any statement', () => {
  it('gives crm_app no INSERT at all — the only writer is a definer', async () => {
    const grants = await sql<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'crm_app' AND table_schema = 'app' AND table_name = 'earnings_ledger'
      ORDER BY 1`

    expect(grants.map((g) => g.privilege_type)).toEqual(['SELECT'])
  })

  it('refuses UPDATE even as the table owner, because FORCE is not the guard here', async () => {
    await seedEntry(SELLER, '00000000-0000-7000-8000-00000000e001', 1000n)

    // Run as the superuser the provider's SQL console hands out. A REVOKE
    // against crm_app means nothing there; the trigger is what binds.
    await expect(sql`UPDATE app.earnings_ledger SET delta_cents = 999999`).rejects.toThrow(/AP001/)
  })

  it('refuses a DELETE that matches ZERO rows — the case a row trigger misses', async () => {
    // A FOR EACH ROW trigger never fires when nothing matches, so the
    // statement succeeds silently. It deleted nothing today; the point is that
    // the guard did not object, and the next predicate might match.
    await expect(sql`DELETE FROM app.earnings_ledger WHERE false`).rejects.toThrow(/AP001/)
  })

  it('refuses TRUNCATE — which bypasses row triggers AND the DELETE privilege', async () => {
    // The single statement that can erase the entire append-only record.
    await expect(sql.unsafe('TRUNCATE app.earnings_ledger')).rejects.toThrow(/AP001/)
  })

  it('leaves the row intact after all of that', async () => {
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.earnings_ledger WHERE tenant_id = ${TENANT}`
    expect(row?.n).toBe('1')
  })
})

describe('exactly once, and the second delivery is a SUCCESS', () => {
  it('credits once and reports the duplicate without changing the total', async () => {
    const eventId = '00000000-0000-7000-8000-00000000e002'

    const first = await seedEntry(SELLER, eventId, ANNUAL_CENTS)
    expect(first.wasDuplicate).toBe(false)

    // A double-tap, a provider retry and a replay all land here. None of them
    // is an error, and none of them moves the number.
    const second = await seedEntry(SELLER, eventId, ANNUAL_CENTS)
    expect(second.wasDuplicate).toBe(true)
    expect(second.entryId).toBe(first.entryId)

    const [row] = await sql<{ total: string; n: string }[]>`
      SELECT total_cents::text AS total, entry_count::text AS n
      FROM app.leaderboard_projection
      WHERE tenant_id = ${TENANT} AND user_id = ${SELLER} AND period_type = 'all_time'`

    // 1000 from the earlier test plus one credit of 299,988 — not two.
    expect(row?.total).toBe((1000n + ANNUAL_CENTS).toString())
    expect(row?.n).toBe('2')
  })
})

describe('period keys are stamped from the TENANT BUSINESS timezone', () => {
  it('puts a late-evening sale on the local day, not the UTC one', async () => {
    // 2026-03-16T02:30:00Z is 2026-03-15 22:30 in America/New_York. Stamping
    // from UTC would move this sale into the next day, and at a month boundary
    // into the next month — silently, on a board with a period selector.
    await seedEntry(SELLER, '00000000-0000-7000-8000-00000000e003', 500n, '2026-03-16T02:30:00Z')

    const [row] = await sql<{ d: string; w: string; m: string; tz: string }[]>`
      SELECT period_day::text AS d, period_week::text AS w, period_month::text AS m,
             business_tz_snapshot AS tz
      FROM app.earnings_ledger
      WHERE tenant_id = ${TENANT} AND source_event_id = '00000000-0000-7000-8000-00000000e003'`

    expect(row?.d).toBe('2026-03-15')
    expect(row?.m).toBe('2026-03-01')
    expect(row?.tz).toBe('America/New_York')
  })

  it('maintains all four period buckets on every append', async () => {
    const rows = await sql<{ period_type: string }[]>`
      SELECT period_type FROM app.leaderboard_projection
      WHERE tenant_id = ${TENANT} AND user_id = ${SELLER} ORDER BY period_type`

    expect(rows.map((r) => r.period_type).sort()).toEqual(['all_time', 'day', 'month', 'week'])
  })
})

describe('annualisation is server-side and exact', () => {
  it('turns $249.99 monthly into $2,999.88, not 2999.8799999999997', async () => {
    // Final Expense sells monthly and Earnings are annual. Without the x12 the
    // public board is wrong by a factor of twelve and looks entirely plausible.
    const [row] = await sql<{ annual: string }[]>`
      SELECT app.annualize(${MONTHLY_CENTS.toString()}::bigint)::text AS annual`

    expect(row?.annual).toBe(ANNUAL_CENTS.toString())
  })

  it('stays exact across a wide range of monthly premiums', async () => {
    const [row] = await sql<{ mismatches: string }[]>`
      SELECT count(*)::text AS mismatches
      FROM generate_series(1, 100000) g
      WHERE app.annualize(g::bigint) <> (g * 12)::bigint`

    expect(row?.mismatches).toBe('0')
  })
})

describe('the ledger input set is frozen in the engine', () => {
  it('refuses a row sourced from contact.owner_changed', async () => {
    // One keystroke from contact.merged in the registry, and one of them is a
    // public-money mutation. US-9.12: money does not move with the record.
    await expect(
      sql`
        INSERT INTO app.earnings_ledger
          (tenant_id, owner_user_id, source_event_id, source_event_name, entry_type,
           delta_cents, opportunity_id, contact_id, stage_name_snapshot, stage_config_version,
           period_day, period_week, period_month, business_tz_snapshot, occurred_at)
        VALUES
          (${TENANT}, ${RIVAL}, gen_random_uuid(), 'contact.owner_changed', 'sale',
           50000, gen_random_uuid(), gen_random_uuid(), 'Closed Won', 1,
           DATE '2026-03-15', DATE '2026-03-09', DATE '2026-03-01', 'America/New_York', now())`,
    ).rejects.toThrow(/earnings_source_is_a_declared_input/)
  })

  it('allows a zero-delta projection_repair, which errata E3 requires', async () => {
    // 05b §678 says CHECK (delta_cents <> 0) literally. Following that older
    // text would make every projection repair impossible to insert.
    await expect(
      sql`
        INSERT INTO app.earnings_ledger
          (tenant_id, owner_user_id, source_event_id, entry_type, delta_cents,
           period_day, period_week, period_month, business_tz_snapshot, occurred_at, reason)
        VALUES
          (${TENANT}, ${RIVAL}, gen_random_uuid(), 'projection_repair', 0,
           DATE '2026-03-15', DATE '2026-03-09', DATE '2026-03-01', 'America/New_York', now(),
           'rebuild after replay')`,
    ).resolves.toBeDefined()
  })
})

describe('the two intervals are never given one name', () => {
  it('keeps undo_deadline and projection_reveal_delay distinct', async () => {
    const [row] = await sql<{ undo: number; reveal: number }[]>`
      SELECT app.undo_deadline_ms() AS undo, app.projection_reveal_delay_ms() AS reveal`

    expect(row?.undo).toBe(5000)
    expect(row?.reveal).toBe(5500)
    // Errata E7/NEW-1: one name meaning two durations kills every celebration
    // in one branch and reveals an undoable win on a public board in the other.
    expect(row?.undo).not.toBe(row?.reveal)
  })

  it('defines no function called app.undo_window, and nothing calls one', async () => {
    // Assertion IV004, scoped to the CALL rather than the substring — the
    // constant key is `undo_deadline_ms`, so banning the substring would make
    // no deploy able to succeed.
    const offenders = await sql<{ proname: string }[]>`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('app', 'ref', 'security')
        AND (p.proname = 'undo_window' OR p.prosrc ~ '\\mapp\\.undo_window\\s*\\(')`

    expect(offenders).toEqual([])
  })

  /**
   * Gate 10, the part that was missing. The undo window had three live
   * representations — TypeScript, CSS and SQL — and nothing that noticed if one
   * moved. They only started disagreeing in ways a seller would feel once the
   * undo existed: the toast's lifetime comes from TypeScript, the rail that
   * draws it from CSS, and whether the public board ever publishes the pair
   * from SQL. Three seconds of divergence is a cancelled sale on a leaderboard
   * fifty people watch.
   *
   * Compares VALUES, never names. E7/NEW-1 records that a drift test comparing
   * names stays green through exactly the failure it was written to catch.
   */
  it('keeps the undo window identical in TypeScript, CSS and SQL', async () => {
    const css = readFileSync(
      new URL('../../app/styles/tokens/motion.css', import.meta.url),
      'utf-8',
    )
    const declared = /--time-undo-window:\s*(\d+)ms/.exec(css)?.[1]

    const [row] = await sql<{ undo: number }[]>`SELECT app.undo_deadline_ms() AS undo`

    expect(UNDO_WINDOW_MS).toBe(5000)
    expect(Number(declared)).toBe(UNDO_WINDOW_MS)
    expect(row?.undo).toBe(UNDO_WINDOW_MS)

    // The FOURTH representation: the celebration claim. Gate 10 asked for the
    // number to agree in four places and this is the last of them.
    const [claim] = await sql<{ src: string }[]>`
      SELECT prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'celebrate_once'`
    expect(claim?.src).toContain('undo_deadline_ms')
    // And NOT the other one. E7/NEW-1: the branch that reaches for the public
    // projection's guard here is the branch that silently refuses every
    // celebration, and a drift test comparing names would stay green through it.
    expect(claim?.src).not.toContain('projection_reveal_delay_ms')
  })

  it('keeps the reveal delay exactly one guard interval above the undo window', async () => {
    const [row] = await sql<{ reveal: number }[]>`
      SELECT app.projection_reveal_delay_ms() AS reveal`

    // Not "5500", which is a number someone could re-derive wrongly. The
    // relationship is the rule: recorded_at is stamped at INSERT while the
    // seller's undo timer starts after COMMIT plus the network.
    expect(row?.reveal).toBe(UNDO_WINDOW_MS + UNDO_PROJECTION_GUARD_MS)
  })
})

describe('the public board hides a win that can still be undone', () => {
  /**
   * Must run with session context. `leaderboard_read` is a definer that scopes
   * on `app.current_tenant()`, so calling it from a raw connection returns zero
   * rows — and an assertion comparing two zeroes passes for the wrong reason.
   * That is exactly how this test failed the first time it ran.
   */
  async function publicTotal(userId: string): Promise<bigint> {
    return withTenant({ tenantId: TENANT, userId }, async (tx) => {
      const rows = await tx.execute<{ total: string }>(
        raw`SELECT total_cents::text AS total
            FROM app.leaderboard_read('all_time', DATE '1970-01-01')
            WHERE user_id = ${userId}::uuid`,
      )
      return BigInt(rows[0]?.total ?? '0')
    })
  }

  it('excludes an entry younger than the reveal delay, then shows it once aged', async () => {
    const baseline = await publicTotal(RIVAL)

    await seedEntry(RIVAL, '00000000-0000-7000-8000-00000000e004', 77_700n)

    // Just written, so still inside the window: the public number must not
    // have moved. R1.3 — no viewer ever sees a number that later corrects
    // itself.
    expect(await publicTotal(RIVAL)).toBe(baseline)

    // Collapse the window rather than sleeping 5.5 seconds. This also proves
    // the predicate READS the constant instead of hard-coding a number.
    await sql`UPDATE ref.timing_constant SET value_ms = 0 WHERE key = 'projection_reveal_delay_ms'`
    try {
      expect(await publicTotal(RIVAL)).toBe(baseline + 77_700n)
    } finally {
      await sql`UPDATE ref.timing_constant SET value_ms = 5500 WHERE key = 'projection_reveal_delay_ms'`
    }

    // And back to hidden once the window is restored — so the exclusion is the
    // window, not a coincidence of ordering.
    expect(await publicTotal(RIVAL)).toBe(baseline)
  })

  /**
   * The defect the 5-second undo exposed, reproduced at the instant it shows.
   *
   * Withholding entries younger than the reveal delay makes the public board a
   * delayed replay of the ledger. That is right for a correction and wrong for
   * an undo, because an undo is TWO entries and the delay is measured on each
   * one separately: the sale ages out first and the board publishes a sale the
   * seller already cancelled, then takes it back seconds later.
   *
   * The fixture builds exactly that instant — a sale old enough to be public
   * next to a reversal still inside the window — instead of sleeping through
   * the real 5.5 seconds. Before migration 0019 this assertion is the wrong
   * number by the full amount of the sale, which is the symptom on screen.
   */
  it('never publishes a sale that was undone, not even while the reversal is young', async () => {
    const baseline = await publicTotal(UNDOER)
    const sale = await seedEntry(UNDOER, '00000000-0000-7000-8000-00000000e010', 88_800n)

    // A real gap, so a reveal delay can be chosen that separates the two rows.
    // Well inside undo_deadline_ms (5000), which is what makes this an undo.
    //
    // The margins are generous on BOTH sides deliberately. The first version
    // used a 1.1s gap against a 900ms window, which left the second assertion
    // needing the reversal to still be younger than 900ms after two more round
    // trips — and it failed once, under the load of a pre-commit run, for a
    // reason that had nothing to do with the ledger. A flaky money test is a
    // failing money test.
    const GAP_MS = 2_500
    const REVEAL_MS = 2_000

    await new Promise((r) => setTimeout(r, GAP_MS))
    await seedReversal(UNDOER, '00000000-0000-7000-8000-00000000e011', -88_800n, sale.entryId)

    await sql`
      UPDATE ref.timing_constant SET value_ms = ${REVEAL_MS}
      WHERE key = 'projection_reveal_delay_ms'`
    try {
      // The fixture asserts ITSELF before it asserts the product. This test is
      // only meaningful at one instant — sale already public, reversal not yet —
      // and a machine slow enough to miss that instant would otherwise report a
      // ledger defect that is really a stopwatch defect.
      const [ages] = await sql<{ sale_ms: number; reversal_ms: number }[]>`
        SELECT
          -- epoch, never the milliseconds field: that one is the
          -- seconds-and-milliseconds component and wraps every minute.
          max(CASE WHEN entry_type = 'sale'
                   THEN extract(epoch from clock_timestamp() - recorded_at) * 1000 END)::int
            AS sale_ms,
          max(CASE WHEN entry_type = 'reversal'
                   THEN extract(epoch from clock_timestamp() - recorded_at) * 1000 END)::int
            AS reversal_ms
        FROM app.earnings_ledger
        WHERE tenant_id = ${TENANT} AND owner_user_id = ${UNDOER}`

      expect(ages?.sale_ms, 'the sale must be old enough to be public').toBeGreaterThan(REVEAL_MS)
      expect(ages?.reversal_ms, 'the reversal must still be young').toBeLessThan(REVEAL_MS)

      // The exact instant in which the old predicate republished the win: sale
      // past the reveal delay, reversal still inside it.
      expect(await publicTotal(UNDOER)).toBe(baseline)

      // The other side of the gate. Shrink the undo deadline below the gap and
      // the same two rows stop being an undo and become an ordinary
      // correction — which the board is supposed to reveal on the delay. A
      // rule that withheld EVERY reversal would stay green here and would be
      // hiding real corrections forever.
      //
      // 200ms is well under the 2.5s gap, so the pair fails the undo test by a
      // wide margin rather than by a hair.
      await sql`UPDATE ref.timing_constant SET value_ms = 200 WHERE key = 'undo_deadline_ms'`
      expect(await publicTotal(UNDOER)).toBe(baseline + 88_800n)
    } finally {
      await sql`UPDATE ref.timing_constant SET value_ms = 5000 WHERE key = 'undo_deadline_ms'`
      await sql`UPDATE ref.timing_constant SET value_ms = 5500 WHERE key = 'projection_reveal_delay_ms'`
    }

    // Both aged out: the pair nets to zero and the board never moved at all.
    await sql`UPDATE ref.timing_constant SET value_ms = 0 WHERE key = 'projection_reveal_delay_ms'`
    try {
      expect(await publicTotal(UNDOER)).toBe(baseline)
    } finally {
      await sql`UPDATE ref.timing_constant SET value_ms = 5500 WHERE key = 'projection_reveal_delay_ms'`
    }
  })

  it('refuses a reversal that does not say what it reverses', async () => {
    // Without the link an undo is indistinguishable from a correction, so it
    // takes the correction path and lands on the public board. The constraint
    // is what stops that from being a matter of remembering.
    await expect(
      sql`
        INSERT INTO app.earnings_ledger
          (tenant_id, owner_user_id, source_event_id, source_event_name, entry_type,
           delta_cents, opportunity_id, contact_id, stage_name_snapshot,
           stage_config_version, period_day, period_week, period_month,
           business_tz_snapshot, occurred_at)
        VALUES
          (${TENANT}, ${SELLER}, gen_random_uuid(), 'opportunity.reopened', 'reversal',
           -100, '00000000-0000-7000-8000-00000000aaa1',
           '00000000-0000-7000-8000-00000000bbb1', 'Closed Won', 1,
           DATE '2026-03-15', DATE '2026-03-09', DATE '2026-03-01',
           'America/New_York', now())`,
    ).rejects.toThrow(/earnings_reversal_names_its_target/)
  })
})
