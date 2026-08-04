import { readFileSync } from 'node:fs'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readSearchFor } from '~/routes/api/search'

import { TEST_URL } from './setup/urls'

/**
 * **N13 — global search, server p95 ≤ 200 ms.**
 *
 * P5.3 is precise about which number goes to CI and which does not: the
 * SERVER p95 is the budget, and `US-LCP-08`'s 500 ms end-to-end is *"a
 * consequence, not a budget"*. So this measures the query, not a browser, and
 * it measures it at a scale the demo tenant cannot produce.
 *
 * WHY THE FIXTURE IS THE HARD PART. `04b` §3.6 states the rule this obeys: *"an
 * improvement caused by a smaller fixture fails."* The demo tenant holds a
 * dozen contacts, and a search across a dozen rows is fast on any
 * implementation, including one that would take four seconds at real scale.
 * The floor this product is sized for is fifty sellers, so the fixture is
 * fifty books — and the fixture ASSERTS ITSELF before anything is timed.
 *
 * The queries are the ones §7 puts a seller in front of, not synthetic ones: a
 * full phone as it is read off a screen, the last four digits, a surname, and
 * an email fragment. A p95 over a set that is all exact-index lookups would be
 * a number about the index and not about the search.
 */

const TENANT = '00000000-0000-7000-8000-0000000000fe'
const SELLER = '00000000-0000-7000-8000-00000000fe01'

/** Fifty books. The floor P5.2 sizes every other number in this project for. */
const SELLERS = 50
const CONTACTS_PER_SELLER = 500
const TOTAL_CONTACTS = SELLERS * CONTACTS_PER_SELLER

/** Enough samples for a p95 to mean something, few enough to stay a test. */
const RUNS = 40

let sql: postgres.Sql

interface Budget {
  readonly id: string
  readonly value: number | null
  readonly unit: string
}

const budget = (
  JSON.parse(readFileSync('perf-budgets.json', 'utf8')) as { budgets: readonly Budget[] }
).budgets.find((b) => b.id === 'N13')

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Scale Agency', 'America/New_York')`

  // Fifty seats, because the silo predicate's cost depends on how much it is
  // excluding — a book that is the whole tenant proves nothing about a book
  // that is one fiftieth of it.
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
    SELECT ${TENANT},
           ('00000000-0000-7000-8000-0000fe' || lpad(g::text, 6, '0'))::uuid,
           'seat' || g || '@scale.test', 'Seat ' || g, 'Seat ' || g, 'seller'
      FROM generate_series(1, ${SELLERS}) g`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
    VALUES (${TENANT}, ${SELLER}, 'me@scale.test', 'Mina Scale', 'Mina S.', 'seller')`

  // Names built from two lists so they collide the way real books do: a
  // surname search must return several rows, not one, or the measurement is of
  // a unique-index hit wearing a name search's clothes.
  await sql`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, email_norm, created_via)
    SELECT ${TENANT},
           CASE WHEN g % ${SELLERS + 1} = 0 THEN ${SELLER}::uuid
                ELSE ('00000000-0000-7000-8000-0000fe' ||
                      lpad(((g % ${SELLERS}) + 1)::text, 6, '0'))::uuid END,
           (ARRAY['Curtis','Doris','Wendell','Alma','Bernard','Ruth','Otis','Mabel'])[1 + g % 8]
             || ' ' ||
           (ARRAY['Vance','Whitfield','Pike','Betancourt','Cole','Alvarez','Nunez','Estes'])[1 + g % 8]
             || ' ' || g,
           'lead' || g || '@scale.test',
           'lead_intake'
      FROM generate_series(1, ${TOTAL_CONTACTS}) g`

  await sql`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
    SELECT c.tenant_id, c.id, c.owner_user_id,
           '+1' || lpad((2000000000 + row_number() OVER (ORDER BY c.id))::text, 10, '0'),
           true
      FROM app.contact c
     WHERE c.tenant_id = ${TENANT}`

  await sql`ANALYZE app.contact`
  await sql`ANALYZE app.contact_phone`
}, 180_000)

afterAll(async () => {
  await sql?.end()
})

describe('the search fixture is the size it claims to be', () => {
  it('holds fifty books, and the searching seller owns one of them', async () => {
    // ASSERTED BEFORE ANYTHING IS TIMED. §3.6: an improvement caused by a
    // smaller fixture fails. A p95 measured over a dozen rows would pass
    // forever and mean nothing.
    const [counts] = await sql<{ total: string; mine: string }[]>`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE owner_user_id = ${SELLER})::text AS mine
        FROM app.contact WHERE tenant_id = ${TENANT}`

    expect(Number(counts?.total)).toBe(TOTAL_CONTACTS)
    expect(Number(counts?.mine), 'the seller under test owns no book').toBeGreaterThan(100)
  })

  it('gives a surname more than one match, so the name path is really exercised', async () => {
    const found = await readSearchFor({ tenantId: TENANT, userId: SELLER }, 'Whitfield')
    expect(found.hits.length).toBeGreaterThan(1)
  })
})

describe('N13 — the server answers inside its budget at fifty books', () => {
  it('declares the budget rather than inventing one at runtime', () => {
    // E6's posture, applied here: a budget with no value fails rather than
    // passing quietly. This test is the only thing enforcing N13, so a missing
    // row must be loud.
    expect(budget, 'N13 is missing from perf-budgets.json').toBeDefined()
    expect(budget?.value, 'N13 has no measured value — E6: a null budget fails').not.toBeNull()
  })

  it('holds p95 under the budget across the queries §7 puts a seller in front of', async () => {
    const queries = [
      '+12000000042', // a full number, pasted
      '937-555-0142', // a full number, typed the way it is read
      '0042', // the last four, half-remembered
      'Whitfield', // a surname, several matches
      'Curtis', // a first name, many matches
      'lead4200@scale', // an email fragment
    ]

    const samples: number[] = []
    for (let run = 0; run < RUNS; run++) {
      const query = queries[run % queries.length] ?? 'Curtis'
      const started = process.hrtime.bigint()
      await readSearchFor({ tenantId: TENANT, userId: SELLER }, query)
      samples.push(Number(process.hrtime.bigint() - started) / 1_000_000)
    }

    const sorted = [...samples].sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
    const worst = sorted[sorted.length - 1] ?? 0

    console.log(
      `[N13] ${TOTAL_CONTACTS} contacts across ${SELLERS} books — ` +
        `p95=${p95.toFixed(1)}ms worst=${worst.toFixed(1)}ms (budget ${String(budget?.value)}ms)`,
    )

    expect(p95, `search p95 over ${String(budget?.value)}ms at fifty books`).toBeLessThanOrEqual(
      budget?.value ?? 0,
    )
  }, 120_000)
})
