import { readFileSync } from 'node:fs'

import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'
import { LOOKUP_CAP_PER_MINUTE } from '~/db/schema/lookup-meter'

import { TEST_URL } from './setup/urls'

/**
 * The non-attributive recent-contact signal.
 *
 * Ping-post resells the same consumer to two sellers in one agency, often
 * inside the hour. Ben needs to know the office already reached this household
 * — and he must not learn that the other lead is Ana's, that it exists as a
 * record, or anything he could use to find it.
 *
 * So this suite asserts two opposite things at once, which is the shape of the
 * whole feature: the DATA crosses the silo, and the ANSWER does not.
 */

const TENANT = '00000000-0000-7000-8000-0000000c0f10'
const ANA = '00000000-0000-7000-8000-0000000c0fa1'
const BEN = '00000000-0000-7000-8000-0000000c0fb1'

/** The consumer both sellers bought, ten minutes apart, from the same vendor. */
const SHARED = '+18135550140'
const LONELY = '+18135550141'
const STALE = '+18135550142'

let sql: postgres.Sql
let anasLead: string
let bensLead: string
let bensLonely: string
let bensStale: string

type Signal = { status: string; minutes_ago: number | null }

async function signal(userId: string, contactId: string): Promise<Signal> {
  const rows = await withTenant({ tenantId: TENANT, userId }, async (tx) =>
    tx.execute<Signal>(
      raw`SELECT status, minutes_ago FROM app.recent_contact_signal(${contactId}::uuid)`,
    ),
  )
  const first = rows[0]
  if (first === undefined) throw new Error('recent_contact_signal returned no row')
  return first
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Ping Post Agency', 'America/New_York')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@ping.test', 'Ana Seller', 'Ana A.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@ping.test', 'Ben Seller', 'Ben B.', 'seller')`

  const mk = async (owner: string, phone: string, touched: string | null): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via, last_touch_at)
      VALUES (${TENANT}, ${owner}, 'Marisol Vega', 'lead_intake',
              ${touched === null ? null : sql`clock_timestamp() - ${touched}::interval`})
      RETURNING id`
    const id = row?.id ?? ''
    await sql`
      INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
      VALUES (${TENANT}, ${id}, ${owner}, ${phone}, true)`
    return id
  }

  // The collision: one household, two books. Ana called twenty minutes ago.
  anasLead = await mk(ANA, SHARED, '20 minutes')
  bensLead = await mk(BEN, SHARED, null)

  // A household only Ben holds, and one the office last touched yesterday.
  bensLonely = await mk(BEN, LONELY, null)
  bensStale = await mk(BEN, STALE, null)
  await mk(ANA, STALE, '26 hours')
})

afterAll(async () => {
  await sql?.end()
})

describe('the data crosses the silo', () => {
  it('tells Ben the office reached this household, and how long ago', async () => {
    const s = await signal(BEN, bensLead)
    expect(s.status).toBe('recent')
    expect(s.minutes_ago).toBeGreaterThanOrEqual(19)
    expect(s.minutes_ago).toBeLessThanOrEqual(21)
  })

  it('says nothing about a household nobody else has touched', async () => {
    const s = await signal(BEN, bensLonely)
    expect(s.status).toBe('none')
    expect(s.minutes_ago).toBeNull()
  })

  it('goes quiet once the touch falls outside the window', async () => {
    const s = await signal(BEN, bensStale)
    expect(s.status).toBe('none')
  })

  it("does not fire on the seller's own activity", async () => {
    // Ana called this household herself twenty minutes ago. A signal that fired
    // on her own call would be noise on every card she works, and noise is what
    // teaches a seller to stop reading a chip.
    const s = await signal(ANA, anasLead)
    expect(s.status).toBe('none')
  })
})

describe('the answer does not cross the silo', () => {
  it('returns exactly two columns, and neither identifies anybody', async () => {
    // THE STRUCTURAL FORM OF "NON-ATTRIBUTIVE". Not a rule about what the UI
    // renders — a rule about what the function is able to say. There is no
    // name, no contact id, no owner, and deliberately not even a COUNT: that
    // two colleagues hold this household is a fact about the agency's book, and
    // nobody needs it in order to decide not to dial.
    const cols = await sql<{ name: string }[]>`
      SELECT p.proargnames[i] AS name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace,
             generate_subscripts(p.proargnames, 1) i
       WHERE n.nspname = 'app' AND p.proname = 'recent_contact_signal'
         AND p.proargmodes[i] IN ('o', 't')`
    expect(cols.map((c) => c.name).sort()).toEqual(['minutes_ago', 'status'])
  })

  it("gives a stranger's contact the same answer as an untouched one", async () => {
    // Ana asks about Ben's lead. `none` — identical to "nobody has touched this
    // household". A distinct answer for "not yours" would confirm the record
    // exists, which is the owner-scoped not-found rule wearing a status code.
    const s = await signal(ANA, bensLead)
    expect(s.status).toBe('none')
    expect(s.minutes_ago).toBeNull()
  })
})

describe('the meter is welded to the lookup', () => {
  it('leaves crm_app no way to read or write the meter', async () => {
    // The argument for metering inside the definer only holds if there is no
    // other door. There isn't: the application role holds nothing here.
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
      const [priv] = await sql<{ ok: boolean }[]>`
        SELECT has_table_privilege('crm_app', 'app.tenant_lookup_meter', ${p}) AS ok`
      expect(priv?.ok, `crm_app can ${p} tenant_lookup_meter`).toBe(false)
    }
  })

  it('refuses past sixty lookups in a minute', async () => {
    // Seeded to the cap rather than called sixty-one times: deterministic, and
    // it cannot straddle a minute boundary halfway through and quietly pass.
    await sql`
      INSERT INTO app.tenant_lookup_meter
        (tenant_id, user_id, minute_bucket, lookup_kind, lookup_count)
      VALUES (${TENANT}, ${BEN}, date_trunc('minute', clock_timestamp()), 'recent_contact',
              ${LOOKUP_CAP_PER_MINUTE})
      ON CONFLICT (tenant_id, user_id, minute_bucket, lookup_kind)
      DO UPDATE SET lookup_count = ${LOOKUP_CAP_PER_MINUTE}`

    const s = await signal(BEN, bensLead)
    expect(s.status).toBe('rate_limited')
    expect(s.minutes_ago).toBeNull()
  })

  it('counts a refused lookup too', async () => {
    // Metering after the read would let an attacker spend the whole budget on
    // successful answers and pay nothing for the misses.
    const [row] = await sql<{ n: number }[]>`
      SELECT lookup_count AS n FROM app.tenant_lookup_meter
       WHERE tenant_id = ${TENANT} AND user_id = ${BEN}
         AND lookup_kind = 'recent_contact'
       ORDER BY minute_bucket DESC LIMIT 1`
    expect(row?.n).toBeGreaterThan(LOOKUP_CAP_PER_MINUTE)
  })

  it('holds the same cap in TypeScript and in SQL', () => {
    // Values, never names — the same rule the card-height gate follows. A
    // constant that drifts from the function it documents is worse than no
    // constant, because it reads as authoritative.
    const migration = readFileSync('app/db/migrations/0039_recent_contact_signal.sql', 'utf8')
    expect(migration).toContain(`c_cap    constant integer := ${LOOKUP_CAP_PER_MINUTE}`)
  })
})
