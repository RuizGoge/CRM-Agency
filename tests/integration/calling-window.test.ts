import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

import { TEST_URL } from './setup/urls'

/**
 * The legal calling window: 9:00 AM – 8:00 PM lead-local, hard-blocked.
 *
 * §SEC-9's sharp part is that a ZIP or a state spanning two zones cannot be
 * collapsed to one answer, because the intuitive collapse is wrong in ONE
 * DIRECTION OF THE DAY. For a Florida lead — Eastern and Central — picking
 * Eastern closes the evening early (conservative) and opens the morning before
 * 9:00 AM Central (permissive). Picking Central inverts both. No single zone is
 * conservative at both ends.
 *
 * So the resolver returns a CANDIDATE SET and the window is the INTERSECTION.
 * The morning case below is the one that matters: it is the error a reasonable
 * implementation makes, and the one that produces an illegal dial.
 *
 * Every assertion pins the instant. A window test that reads the wall clock
 * passes or fails by the hour it happens to run, which is the same as not
 * asserting it.
 */

const TENANT = '00000000-0000-7000-8000-0000000ca110'
const ANA = '00000000-0000-7000-8000-0000000ca1a1'
const BEN = '00000000-0000-7000-8000-0000000ca1b1'

/** 13:30 UTC. Summer: 09:30 Eastern / 08:30 Central. Winter: 08:30 Eastern. */
const SUMMER_0930_ET = '2026-07-15T13:30:00Z'
const WINTER_SAME_UTC = '2026-01-15T13:30:00Z'
/** 23:30 UTC in summer = 19:30 Eastern / 18:30 Central — inside both. */
const SUMMER_1930_ET = '2026-07-15T23:30:00Z'
/** 00:30 UTC next day = 20:30 Eastern / 19:30 Central — outside Eastern. */
const SUMMER_2030_ET = '2026-07-16T00:30:00Z'

let sql: postgres.Sql
let florida: string
let newYork: string
let unknown: string
let bensLead: string
let zipped: string

/**
 * A `type` and not an `interface`, deliberately: `tx.execute<T>` constrains T to
 * `Record<string, unknown>`, and only a type alias carries the implicit index
 * signature that satisfies it.
 */
type Verdict = {
  allowed: boolean
  reason: string
  zones: string[]
  confidence: string | null
  source: string | null
}

async function check(userId: string, contactId: string, at: string): Promise<Verdict> {
  const rows = await withTenant({ tenantId: TENANT, userId }, async (tx) =>
    tx.execute<Verdict>(
      raw`SELECT allowed, reason, zones, confidence, source
            FROM app.calling_window_check(${contactId}::uuid, ${at}::timestamptz)`,
    ),
  )
  const first = rows[0]
  if (first === undefined) throw new Error('calling_window_check returned no row')
  return first
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Window Agency', 'America/New_York')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@win.test', 'Ana Seller', 'Ana A.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@win.test', 'Ben Seller', 'Ben B.', 'seller')`

  const mk = async (owner: string, state: string | null, zip: string | null): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via, state_code, zip5)
      VALUES (${TENANT}, ${owner}, 'Lead', 'lead_intake', ${state}, ${zip})
      RETURNING id`
    return row?.id ?? ''
  }

  florida = await mk(ANA, 'FL', null)
  newYork = await mk(ANA, 'NY', null)
  unknown = await mk(ANA, null, null)
  bensLead = await mk(BEN, 'NY', null)
  zipped = await mk(ANA, 'FL', '33101')

  // One ZIP row, so the precedence of the chain is observable. The real table
  // is generated from Census sources and ships empty here — see the schema.
  await sql`INSERT INTO ref.zip_timezone (zip5, tz) VALUES ('33101', 'America/New_York')`
})

afterAll(async () => {
  await sql?.end()
})

describe('the straddle rule: the window is the intersection, not a choice', () => {
  it('BLOCKS a Florida lead at 9:30 Eastern, because it is 8:30 Central', async () => {
    // THE ASSERTION THIS WHOLE DESIGN EXISTS FOR. A resolver that collapsed
    // Florida to Eastern — the obvious, populous, defensible choice — would
    // allow this dial, and it would be illegal for every Panhandle consumer in
    // the book. Nothing else in the suite catches that.
    const v = await check(ANA, florida, SUMMER_0930_ET)
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('blocked_calling_window')
    expect(v.zones.sort()).toEqual(['America/Chicago', 'America/New_York'])
  })

  it('ALLOWS the same lead at 19:30 Eastern, inside both zones', async () => {
    const v = await check(ANA, florida, SUMMER_1930_ET)
    expect(v.allowed).toBe(true)
    expect(v.reason).toBe('allow')
  })

  it('BLOCKS at 20:30 Eastern even though Central is still open', async () => {
    // The evening half of the same rule. Here the collapse-to-Eastern choice
    // would have been conservative and the collapse-to-Central choice wrong —
    // which is exactly why neither is available.
    const v = await check(ANA, florida, SUMMER_2030_ET)
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('blocked_calling_window')
  })

  it('reports low confidence for a multi-zone state', async () => {
    const v = await check(ANA, florida, SUMMER_1930_ET)
    expect(v.confidence).toBe('low')
    expect(v.source).toBe('state')
  })
})

describe('a single-zone state is decided by its one zone', () => {
  it('allows New York at 9:30 Eastern', async () => {
    const v = await check(ANA, newYork, SUMMER_0930_ET)
    expect(v.allowed).toBe(true)
    expect(v.zones).toEqual(['America/New_York'])
    // `medium`, not `high`: a state is a coarse answer even when it is
    // unambiguous, and only a ZIP earns `high`.
    expect(v.confidence).toBe('medium')
  })

  it('blocks New York at 20:30 Eastern', async () => {
    const v = await check(ANA, newYork, SUMMER_2030_ET)
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('blocked_calling_window')
  })
})

describe('the evaluator is real tzdata and not a fixed offset', () => {
  it('reaches opposite verdicts for the same UTC clock time in summer and winter', async () => {
    // 13:30 UTC is 09:30 EDT in July and 08:30 EST in January. A hand-rolled
    // offset would give the same answer twice, and would be wrong for every
    // lead on the two DST transition days — the failure mode §SEC-9 names as
    // the reason this evaluation lives in Postgres rather than in JavaScript.
    const summer = await check(ANA, newYork, SUMMER_0930_ET)
    const winter = await check(ANA, newYork, WINTER_SAME_UTC)

    expect(summer.allowed).toBe(true)
    expect(winter.allowed).toBe(false)
    expect(winter.reason).toBe('blocked_calling_window')
  })
})

describe('unresolved fails closed', () => {
  it('blocks a lead with no zip, no area code and no state', async () => {
    const v = await check(ANA, unknown, SUMMER_1930_ET)
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('blocked_timezone_unknown')
    expect(v.zones).toEqual([])
  })

  it("gives the same closed answer for a lead in another seller's book", async () => {
    // THE SILO, HELD WITHOUT A LINE OF CODE. This function is SECURITY INVOKER
    // over owner_scoped tables, so RLS hides Ben's contact from Ana and the
    // resolver simply has nothing to resolve. Ana cannot tell a stranger's lead
    // from a lead that never existed — and the verdict fails closed rather than
    // open, which is the correct direction for an accident.
    const v = await check(ANA, bensLead, SUMMER_1930_ET)
    expect(v.reason).toBe('blocked_timezone_unknown')

    // Ben, who owns it, gets a real answer from the same call.
    const owned = await check(BEN, bensLead, SUMMER_1930_ET)
    expect(owned.reason).toBe('allow')
  })
})

describe('the resolver chain prefers the most precise layer it has', () => {
  it('uses the ZIP over the state, and calls a single ZIP row high confidence', async () => {
    // Same Florida state code, but this lead has a ZIP that resolves. The ZIP
    // wins, the candidate set collapses to one zone, and 09:30 Eastern becomes
    // legal — the straddle penalty is paid only where the ambiguity is real.
    const v = await check(ANA, zipped, SUMMER_0930_ET)
    expect(v.source).toBe('zip')
    expect(v.confidence).toBe('high')
    expect(v.zones).toEqual(['America/New_York'])
    expect(v.allowed).toBe(true)
  })
})

describe('a zone the database does not know cannot be stored', () => {
  it('raises TZ001 on a name absent from pg_timezone_names', async () => {
    // A typo here is not a data-quality issue: the row never matches, the
    // resolver falls through or returns nothing, and a lead becomes
    // permanently uncallable with no error anywhere.
    await expect(
      sql`INSERT INTO ref.state_timezone (state_code, tz) VALUES ('ZZ', 'America/Kentucky')`,
    ).rejects.toThrow(/TZ001/)
  })

  it('seeded every state and DC', async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(DISTINCT state_code)::int AS n FROM ref.state_timezone`
    expect(row?.n).toBe(51)
  })
})
