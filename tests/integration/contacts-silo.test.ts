import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

import { TEST_URL } from './setup/urls'

/**
 * The silo-collision fixture (05c §7.7.1).
 *
 * The schema makes a genuine collision LEGAL, which is what makes this fixture
 * possible: identity is owner-scoped because ping-post resells the same
 * consumer to two sellers in one agency. So Ana and Ben each hold a contact
 * for the same human being, with the same name, the same email and the same
 * phone — and neither may ever see a byte of the other's.
 *
 * Every one of Ana's free-text fields additionally carries a canary token. The
 * central assertion is a byte-level check over the ENTIRE serialised response,
 * which is what makes it catch a leak through a field that does not exist yet.
 */

const TENANT = '00000000-0000-7000-8000-0000000000f5'
const ANA = '00000000-0000-7000-8000-0000000000a1'
const BEN = '00000000-0000-7000-8000-0000000000b1'
const SUPER = '00000000-0000-7000-8000-0000000000c5'

/** The colliding consumer. One human, two books. */
const SHARED_EMAIL = 'maria.rodriguez@example.com'
const SHARED_PHONE = '+13055550134'
const CANARY = 'ZZQA-ANA'

let sql: postgres.Sql

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Collision Agency', 'America/New_York')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA},   'ana@collide.test', 'Ana Seller', 'Ana', 'seller'),
      (${TENANT}, ${BEN},   'ben@collide.test', 'Ben Seller', 'Ben', 'seller'),
      (${TENANT}, ${SUPER}, 'sup@collide.test', 'Sam Super',  'Sam', 'supervisor')`

  // Three each, so counts can be asserted numerically rather than by presence.
  for (let i = 1; i <= 3; i++) {
    await sql`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, email_norm, created_via)
      VALUES (${TENANT}, ${ANA}, ${`Maria Rodriguez ${CANARY}-${i}`},
              ${`ana${i}.${SHARED_EMAIL}`}, 'lead_intake')`
    await sql`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, email_norm, created_via)
      VALUES (${TENANT}, ${BEN}, ${`Maria Rodriguez ${i}`},
              ${`ben${i}.${SHARED_EMAIL}`}, 'lead_intake')`
  }

  // The exact same phone number in both books — legal, and the point.
  const [anaContact] = await sql<{ id: string }[]>`
    SELECT id FROM app.contact WHERE tenant_id = ${TENANT} AND owner_user_id = ${ANA} LIMIT 1`
  const [benContact] = await sql<{ id: string }[]>`
    SELECT id FROM app.contact WHERE tenant_id = ${TENANT} AND owner_user_id = ${BEN} LIMIT 1`

  await sql`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary) VALUES
      (${TENANT}, ${anaContact?.id ?? null}, ${ANA}, ${SHARED_PHONE}, true),
      (${TENANT}, ${benContact?.id ?? null}, ${BEN}, ${SHARED_PHONE}, true)`
})

afterAll(async () => {
  await sql?.end()
})

/** Search as a seller would: the live view, name match, own book. */
async function searchAs(userId: string, term: string): Promise<unknown[]> {
  return withTenant({ tenantId: TENANT, userId }, async (tx) => {
    const rows = await tx.execute(
      raw`SELECT * FROM app.contact_live WHERE full_name ILIKE ${'%' + term + '%'}`,
    )
    return [...rows]
  })
}

describe('the collision fixture is legal, which is what makes the test possible', () => {
  it('lets two sellers hold the same consumer, with the same phone', async () => {
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.contact_phone
      WHERE tenant_id = ${TENANT} AND phone_e164 = ${SHARED_PHONE}`

    expect(row?.n).toBe('2')
  })

  it('refuses a SECOND row for the same phone in the SAME book', async () => {
    // Owner-scoped uniqueness: the dedupe rule expressed as a constraint
    // rather than as a helper at one of six ingress points.
    const [anaContact] = await sql<{ id: string }[]>`
      SELECT id FROM app.contact WHERE tenant_id = ${TENANT} AND owner_user_id = ${ANA} LIMIT 1`

    await expect(
      sql`
        INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164)
        VALUES (${TENANT}, ${anaContact?.id ?? null}, ${ANA}, ${SHARED_PHONE})`,
    ).rejects.toThrow(/contact_phone_owner_uidx/)
  })

  it('refuses a phone that is not E.164, at the storage layer', async () => {
    const [anaContact] = await sql<{ id: string }[]>`
      SELECT id FROM app.contact WHERE tenant_id = ${TENANT} AND owner_user_id = ${ANA} LIMIT 1`

    await expect(
      sql`
        INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164)
        VALUES (${TENANT}, ${anaContact?.id ?? null}, ${ANA}, '(305) 555-0134')`,
    ).rejects.toThrow(/contact_phone_is_e164/)
  })
})

describe('THE canary: a byte-level assertion over the whole response', () => {
  it("returns none of Ana's bytes to Ben, through ANY field", async () => {
    const body = JSON.stringify(await searchAs(BEN, 'Maria'))

    // Not "no rows with the wrong owner_user_id" — no OCCURRENCE of the token,
    // anywhere in the serialised response. That is what makes this catch a
    // leak through a column added six months from now that no test knows about.
    expect(body).not.toContain('ZZQA-')
  })

  it('returns exactly three rows to Ben, all his own', async () => {
    const rows = (await searchAs(BEN, 'Maria')) as { owner_user_id: string }[]

    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.owner_user_id === BEN)).toBe(true)
  })

  it('returns exactly three to Ana, and hers DO carry the canary', async () => {
    // The negative assertion above is only meaningful if the token is really
    // in the data. This is the control.
    const body = JSON.stringify(await searchAs(ANA, 'Maria'))

    expect(body).toContain('ZZQA-')
    expect(await searchAs(ANA, 'Maria')).toHaveLength(3)
  })

  it('shows a supervisor both books, which is the sanctioned widening', async () => {
    const rows = await searchAs(SUPER, 'Maria')
    expect(rows).toHaveLength(6)
  })
})

describe('contact_live is a view that does not become a way around RLS', () => {
  it('is declared security_invoker, so policies evaluate as the caller', async () => {
    // Without the keyword, a view owned by the migrator reads with the
    // migrator's policy — USING (true) — which is a total silo bypass wearing
    // the word "view".
    const [row] = await sql<{ opts: string | null }[]>`
      SELECT array_to_string(c.reloptions, ',') AS opts
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = 'contact_live'`

    expect(row?.opts ?? '').toContain('security_invoker=true')
  })

  it('hides an archived contact from its owner', async () => {
    const before = (await searchAs(ANA, 'Maria')).length

    const [victim] = await sql<{ id: string }[]>`
      SELECT id FROM app.contact
      WHERE tenant_id = ${TENANT} AND owner_user_id = ${ANA} ORDER BY id LIMIT 1`
    await sql`
      UPDATE app.contact SET deleted_at = clock_timestamp()
      WHERE tenant_id = ${TENANT} AND id = ${victim?.id ?? null}`

    try {
      expect((await searchAs(ANA, 'Maria')).length).toBe(before - 1)
    } finally {
      await sql`
        UPDATE app.contact SET deleted_at = NULL
        WHERE tenant_id = ${TENANT} AND id = ${victim?.id ?? null}`
    }
  })
})

describe('the ownership predicate lives inside the search index', () => {
  it('carries tenant_id, owner_user_id and the trigram in one index key', async () => {
    // A tenant-wide trigram index filtered AFTER retrieval is the silo leak
    // that rules out a separate search service: rows are fetched first and
    // discarded second, and every layer above has to be trusted to discard.
    //
    // Asserted structurally rather than through EXPLAIN. On a six-row fixture
    // the planner correctly prefers the primary key, so a plan assertion here
    // would test the planner's cost model, not our index. G1e already proved
    // the plan against 20,000 rows; what this guards is someone quietly
    // dropping owner_user_id out of the key.
    const [row] = await sql<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes
      WHERE schemaname = 'app' AND indexname = 'contact_name_trgm_idx'`

    expect(row?.def).toBeDefined()
    expect(row?.def).toMatch(/USING gin \(tenant_id, owner_user_id, full_name gin_trgm_ops\)/)
  })
})

describe('an unknown timezone cannot masquerade as a known one', () => {
  it('refuses high confidence with no zone', async () => {
    // The lead-local zone decides whether a dial is legal. A confident-looking
    // NULL is the shape that makes an illegal call look permitted.
    await expect(
      sql`
        INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via, tz_confidence)
        VALUES (${TENANT}, ${ANA}, 'No Zone', 'manual', 'high')`,
    ).rejects.toThrow(/contact_tz_confidence_coherent/)
  })
})
