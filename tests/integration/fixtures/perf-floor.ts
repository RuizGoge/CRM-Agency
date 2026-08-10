import postgres from 'postgres'

import { TEST_URL } from '../setup/urls'

/**
 * `perf-floor` — the fifty-seller fixture `04b` §3.1 sizes the server budgets
 * against.
 *
 * §3.1 declares it as *"50 sellers · 25 000 contacts · 200 000 activities ·
 * 6 400 ledger rows spread across all four periods"*, and names three budgets
 * that read it: **API p95 (P7)**, **leaderboard (P11)** and **search**.
 *
 * WHY THE LEDGER IS THE PART THAT MATTERS FOR P11. The public board never
 * aggregates over the ledger — §3.6 P7/P10 makes it read `leaderboard_projection`
 * — and that projection is maintained FORWARD by `app.ledger_append`. So a
 * fixture with fifty sellers and no money produces a projection with no rows,
 * and a `304` measured against it is a number about an empty table. The 6 400
 * appends are what make the measurement mean anything.
 *
 * EVERY ROW GOES IN THROUGH THE REAL FUNCTION. `ledger_append` is the only
 * writer the ledger has — it is append-only by trigger AND by revoked
 * privilege, and there is no recompute job by design — so a fixture that
 * INSERTed straight into `earnings_ledger` would be measuring a projection this
 * product cannot produce.
 *
 * ⚠️ IT IS BUILT ON EVERY RUN, unlike `perf-500`. `crm_test` is dropped and
 * rebuilt by `globalSetup`, so there is nothing to self-heal into. The cost is
 * paid once per suite and is why this lives behind a long `beforeAll` timeout.
 */

/** Its own tenant, like every other fixture here: a shared one is a shared fate. */
export const FLOOR_TENANT = '00000000-0000-7000-8000-00000000cf20'

/** The seller the measurements act as. One of the fifty, never a fifty-first. */
export const FLOOR_SELLER = '00000000-0000-7000-8000-0000cf000001'

/** The floor P5.2 sizes every other number in this project for. */
export const FLOOR_SELLERS = 50
export const FLOOR_CONTACTS_PER_SELLER = 500
export const FLOOR_CONTACTS = FLOOR_SELLERS * FLOOR_CONTACTS_PER_SELLER
export const FLOOR_LEDGER_ROWS = 6_400
export const FLOOR_ACTIVITIES = 200_000

function client(): postgres.Sql {
  return postgres(TEST_URL, { max: 1, onnotice: () => {} })
}

/** `('00000000-0000-7000-8000-0000cf' || six digits)` — seller n's id, in SQL. */
const sellerId = (expr: string): string =>
  `('00000000-0000-7000-8000-0000cf' || lpad((${expr})::text, 6, '0'))::uuid`

export async function seedPerfFloor(): Promise<void> {
  const sql = client()
  try {
    const [taken] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.tenant WHERE id = ${FLOOR_TENANT}`
    if (Number(taken?.n ?? '0') > 0) return

    await sql`
      INSERT INTO app.tenant (id, name, business_tz)
      VALUES (${FLOOR_TENANT}, 'Floor Agency', 'America/New_York')`

    // Fifty seats. The silo predicate's cost depends on how much it excludes,
    // and the projection's shape depends on how many rows a period holds — a
    // board of one is not a smaller version of a board of fifty, it is a
    // different query plan.
    await sql.unsafe(`
      INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
      SELECT '${FLOOR_TENANT}', ${sellerId('g')},
             'floor' || g || '@floor.test', 'Floor Seat ' || g,
             'Floor ' || g, 'seller'
        FROM generate_series(1, ${FLOOR_SELLERS}) g`)

    // One pipeline and three stages per seller, because ruling D4 makes stages
    // belong to a SELLER rather than to the tenant. The opportunities below
    // need somewhere legal to sit; nothing here reads the board.
    await sql.unsafe(`
      INSERT INTO app.pipeline (tenant_id, owner_user_id, name)
      SELECT '${FLOOR_TENANT}', ${sellerId('g')}, 'Floor pipeline'
        FROM generate_series(1, ${FLOOR_SELLERS}) g`)

    await sql.unsafe(`
      INSERT INTO app.stage (tenant_id, pipeline_id, owner_user_id, name, stage_type, sort_order)
      SELECT p.tenant_id, p.id, p.owner_user_id, s.name, s.kind::app.stage_type, s.ord
        FROM app.pipeline p
        CROSS JOIN (VALUES ('Floor Open', 'open', 0),
                           ('Floor Won', 'earning', 1),
                           ('Floor Lost', 'lost', 2)) AS s(name, kind, ord)
       WHERE p.tenant_id = '${FLOOR_TENANT}'`)

    await sql.unsafe(`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, email_norm, created_via)
      SELECT '${FLOOR_TENANT}', ${sellerId('((g - 1) % ' + FLOOR_SELLERS + ') + 1')},
             'Floor Lead ' || g, 'floor' || g || '@lead.test', 'lead_intake'
        FROM generate_series(1, ${FLOOR_CONTACTS}) g`)

    // The deals the ledger rows will point at. `earnings_deal_context_present`
    // refuses a money row with no deal behind it, which is the constraint that
    // makes every number on the public board explainable.
    //
    // 🎯 `premium_mode` IS HERE BECAUSE A CONSTRAINT DEMANDED IT. The first
    // version set the cents and left the mode null, and
    // `opportunity_premium_mode_declared` — `(premium_mode IS NULL) =
    // (premium_annual_cents IS NULL)` — refused every row. That is the move
    // sheet's "no preselected default" rule as a CHECK: an amount whose unit
    // nobody declared is how a monthly premium silently becomes an annual one,
    // and it is worth twelve times the truth on a public board. `annual`, since
    // the column these rows carry is already annualised.
    await sql.unsafe(`
      INSERT INTO app.opportunity
        (tenant_id, owner_user_id, contact_id, pipeline_id, stage_id,
         current_stage_type, created_from, premium_annual_cents, premium_mode)
      SELECT c.tenant_id, c.owner_user_id, c.id, s.pipeline_id, s.id,
             'earning', 'manual', 120000 + (row_number() OVER (ORDER BY c.id)) % 500000,
             'annual'::app.premium_mode
        FROM (SELECT * FROM app.contact
               WHERE tenant_id = '${FLOOR_TENANT}'
               ORDER BY id LIMIT ${FLOOR_LEDGER_ROWS}) c
        JOIN app.stage s
          ON s.tenant_id = c.tenant_id AND s.owner_user_id = c.owner_user_id
         AND s.stage_type = 'earning'`)

    // THROUGH THE REAL APPENDER, inside one system-scoped transaction. Six
    // thousand round trips would take minutes; one statement that calls the
    // function six thousand times takes seconds and exercises exactly the same
    // path, including the projection maintenance this whole fixture exists for.
    //
    // 🔴 FOUR ARRIVAL BUCKETS ANCHORED TO THE PERIOD BOUNDARIES IN THE TENANT'S
    // BUSINESS TIMEZONE, never to a fixed number of days back — and the first
    // version got this wrong in exactly the way the register already warns
    // about for the demo seed: *"'seven days ago' spans different buckets
    // depending on the day of the week, and a demo that works on Thursdays is
    // worse than one that never worked."*
    //
    // Measured, not reasoned: with `- interval '3 days'` the day and week
    // boards came back with the SAME total, because three days before a Sunday
    // is the previous week. The fixture would have been honest on some days and
    // silently degenerate on others.
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT app.begin_system_work('${FLOOR_TENANT}')`)
      await tx.unsafe(`
        WITH tz AS (SELECT business_tz AS name FROM app.tenant WHERE id = '${FLOOR_TENANT}'),
             now_local AS (SELECT clock_timestamp() AT TIME ZONE (SELECT name FROM tz) AS t)
        SELECT app.ledger_append(
                 o.owner_user_id, gen_random_uuid(), 'opportunity.won',
                 'sale'::app.ledger_entry_type, o.premium_annual_cents,
                 CASE (row_number() OVER (ORDER BY o.id)) % 4
                   WHEN 0 THEN (date_trunc('day',   (SELECT t FROM now_local)) + interval '1 hour')
                                 AT TIME ZONE (SELECT name FROM tz)
                   WHEN 1 THEN (date_trunc('week',  (SELECT t FROM now_local)) + interval '1 hour')
                                 AT TIME ZONE (SELECT name FROM tz)
                   WHEN 2 THEN (date_trunc('month', (SELECT t FROM now_local)) + interval '1 hour')
                                 AT TIME ZONE (SELECT name FROM tz)
                   ELSE clock_timestamp() - interval '200 days'
                 END,
                 o.id, o.contact_id, o.stage_id, 'Floor Won', 1::bigint,
                 NULL, NULL, NULL, NULL)
          FROM app.opportunity o
         WHERE o.tenant_id = '${FLOOR_TENANT}'`)
    })

    // The My Day / API surface P7 will read. Not used by P11, and built anyway
    // because a fixture that is only the shape one budget needs is a fixture
    // the next budget quietly shrinks.
    await sql.unsafe(`
      INSERT INTO app.activity
        (tenant_id, owner_user_id, contact_id, type, title, due_at, created_by)
      SELECT c.tenant_id, c.owner_user_id, c.id, 'task'::app.activity_type,
             'Floor task ' || g,
             clock_timestamp() + make_interval(mins => (g % 20000) - 10000),
             'human'::app.actor_type
        FROM generate_series(1, ${Math.floor(FLOOR_ACTIVITIES / FLOOR_CONTACTS)}) g
        CROSS JOIN app.contact c
       WHERE c.tenant_id = '${FLOOR_TENANT}'`)

    await sql`ANALYZE app.earnings_ledger`
    await sql`ANALYZE app.leaderboard_projection`
    await sql`ANALYZE app.activity`
    await sql`ANALYZE app.contact`
  } finally {
    await sql.end()
  }
}

export interface FloorShape {
  readonly sellers: number
  readonly contacts: number
  readonly ledgerRows: number
  readonly activities: number
  readonly projectionPeriods: number
}

/** Read back and asserted before anything is timed — §3.5, versioned fixtures. */
export async function readPerfFloorShape(): Promise<FloorShape> {
  const sql = client()
  try {
    const [row] = await sql<Record<string, string>[]>`
      SELECT
        (SELECT count(*) FROM app.app_user WHERE tenant_id = ${FLOOR_TENANT})::text AS sellers,
        (SELECT count(*) FROM app.contact WHERE tenant_id = ${FLOOR_TENANT})::text AS contacts,
        (SELECT count(*) FROM app.earnings_ledger WHERE tenant_id = ${FLOOR_TENANT})::text
          AS ledger_rows,
        (SELECT count(*) FROM app.activity WHERE tenant_id = ${FLOOR_TENANT})::text AS activities,
        (SELECT count(DISTINCT period_type) FROM app.leaderboard_projection
          WHERE tenant_id = ${FLOOR_TENANT})::text AS projection_periods`
    return {
      sellers: Number(row?.['sellers'] ?? '0'),
      contacts: Number(row?.['contacts'] ?? '0'),
      ledgerRows: Number(row?.['ledger_rows'] ?? '0'),
      activities: Number(row?.['activities'] ?? '0'),
      projectionPeriods: Number(row?.['projection_periods'] ?? '0'),
    }
  } finally {
    await sql.end()
  }
}
