import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

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
      (${TENANT}, ${RIVAL},  'rival@money.test',  'Rita Rival',  'Rita', 'seller')`
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
})
