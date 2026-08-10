import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

import { TEST_URL } from './setup/urls'

/**
 * `consent_ledger` is the first `definer_only` table in the system, and the
 * class exists for a reason this suite has to prove rather than assume.
 *
 * Consent is keyed on the phone NUMBER and scoped to the TENANT, because a STOP
 * has to silence that number for every seller at once — ping-post resells the
 * same consumer to two sellers in one agency and both are dialling. But a
 * tenant-wide readable consent table is a cross-silo oracle: ask it about a
 * number, learn whether a colleague is working that consumer. So the table is
 * readable by nobody, and the only way in is a function that returns a verdict.
 *
 * The assertions that matter here are the negative ones, and they are the kind
 * that pass for the wrong reason if written carelessly: "returns no rows" is
 * satisfied both by a closed door and by an empty table.
 */

const TENANT = '00000000-0000-7000-8000-0000000c05e0'
const ANA = '00000000-0000-7000-8000-0000000c05a1'
const BEN = '00000000-0000-7000-8000-0000000c05b1'
const SUPER = '00000000-0000-7000-8000-0000000c05c1'

/** One consumer, in Ana's book. Ben has his own row for the same human. */
const PHONE = '+13055550171'
const BEN_PHONE = '+13055550172'

let sql: postgres.Sql
let anaContact: string
let benContact: string

/**
 * The whole error chain as text.
 *
 * Drizzle REWRAPS the driver error, so `permission denied` — and every SQLSTATE
 * — sits one level down in `cause` while the top-level message is only
 * "Failed query: …". The register already records this exact trap from the
 * quick-add duplicate: a guarantee in the database is half a guarantee until
 * the application can recognise the refusal.
 */
function chain(error: unknown): string {
  const parts: string[] = []
  let cursor: unknown = error
  while (cursor instanceof Error) {
    parts.push(cursor.message)
    cursor = cursor.cause
  }
  return parts.join(' | ')
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Consent Agency', 'America/New_York')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA},   'ana@consent.test', 'Ana Seller', 'Ana A.', 'seller'),
      (${TENANT}, ${BEN},   'ben@consent.test', 'Ben Seller', 'Ben B.', 'seller'),
      (${TENANT}, ${SUPER}, 'sup@consent.test', 'Sam Super',  'Sam S.', 'supervisor')`

  const [ana] = await sql<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${ANA}, 'Marisol Vega', 'lead_intake')
    RETURNING id`
  const [ben] = await sql<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
    VALUES (${TENANT}, ${BEN}, 'Other Person', 'lead_intake')
    RETURNING id`

  anaContact = ana?.id ?? ''
  benContact = ben?.id ?? ''

  await sql`
    INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
    VALUES (${TENANT}, ${anaContact}, ${ANA}, ${PHONE}, true),
           (${TENANT}, ${benContact}, ${BEN}, ${BEN_PHONE}, true)`

  // BEN'S CONTACT HAS CONSENT OF ITS OWN, and the suite is worthless without
  // it. The first version of this fixture seeded consent only for Ana, so
  // "Ana reads nothing for Ben's contact" was satisfied by an empty table
  // rather than by the ownership predicate — and deleting that predicate left
  // every test green. Found by mutation, which is the only way it could be.
  await withTenant({ tenantId: TENANT, userId: BEN }, async (tx) => {
    await tx.execute(raw`
      SELECT app.consent_append('phone', ${BEN_PHONE}, 'sms', 'granted', 'express_written',
                                'vendor_certificate', now() - interval '3 days',
                                ${benContact}::uuid)`)
  })
})

afterAll(async () => {
  await sql?.end()
})

describe('the application role cannot reach the table at all', () => {
  it('holds no SELECT privilege — a revoked grant, not just a policy', async () => {
    // THE ASSERTION THIS MIGRATION CHANGED THE ENGINE FOR. Before 0035, harden()
    // granted SELECT unconditionally and relied on USING (false) to return zero
    // rows. That reads the same from the application and is NOT the same thing:
    // a privilege neutralised only by a policy is one dropped policy away from a
    // tenant-wide read of every consumer's consent history.
    const [priv] = await sql<{ ok: boolean }[]>`
      SELECT has_table_privilege('crm_app', 'app.consent_ledger', 'SELECT') AS ok`
    expect(priv?.ok, 'crm_app can SELECT consent_ledger').toBe(false)
  })

  it('holds no INSERT, UPDATE or DELETE either', async () => {
    for (const p of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const [priv] = await sql<{ ok: boolean }[]>`
        SELECT has_table_privilege('crm_app', 'app.consent_ledger', ${p}) AS ok`
      expect(priv?.ok, `crm_app can ${p} consent_ledger`).toBe(false)
    }
  })

  it('refuses a direct read with permission denied, not with an empty result', async () => {
    // The distinction this test exists to hold. An empty result is what a
    // policy-only closure produces, and it is indistinguishable from "no rows
    // matched" — so a future migration that reclassified this table would pass
    // a test written against emptiness. Permission denied can only come from
    // the privilege being gone.
    // CAUGHT OUTSIDE withTenant, not inside it. A refused statement ABORTS the
    // transaction, so catching within the callback leaves a poisoned session
    // that fails again on the way out — the register records the same Postgres
    // fact from the quick-add duplicate: refusing and then asking are always
    // two units of work.
    const refusal = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute(raw`SELECT 1 FROM app.consent_ledger LIMIT 1`),
    )
      .then(() => null)
      .catch((error: unknown) => chain(error))

    expect(refusal, 'the read was not refused at all').not.toBeNull()
    expect(refusal).toMatch(/permission denied/i)
  })

  it('still has a policy, so the catalog gate is met honestly', async () => {
    // `definer_only` generates an EXPLICIT deny rather than no policy at all.
    // The difference matters to the harness: "every managed relation has a
    // policy" must be satisfiable by reading the catalog, not by arguing that
    // this one does not need one.
    const [pol] = await sql<{ qual: string | null; with_check: string | null }[]>`
      SELECT qual::text, with_check::text FROM pg_policies
       WHERE schemaname = 'app' AND tablename = 'consent_ledger' AND policyname = 'p_app'`
    expect(pol?.qual).toBe('false')
    expect(pol?.with_check).toBe('false')
  })
})

describe('app.consent_append is the only writer', () => {
  it('appends and derives previous_status instead of trusting a caller', async () => {
    await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
      await tx.execute(raw`
        SELECT app.consent_append('phone', ${PHONE}, 'sms', 'granted', 'express_written',
                                  'vendor_certificate', now() - interval '2 days',
                                  ${anaContact}::uuid)`)
      await tx.execute(raw`
        SELECT app.consent_append('phone', ${PHONE}, 'sms', 'revoked', 'none',
                                  'stop_keyword', now() - interval '1 hour')`)
    })

    const rows = await sql<{ status: string; previous_status: string | null }[]>`
      SELECT status, previous_status FROM app.consent_ledger
       WHERE tenant_id = ${TENANT} AND contact_value_norm = ${PHONE} AND channel = 'sms'
       ORDER BY effective_at ASC`

    expect(rows.map((r) => r.status)).toEqual(['granted', 'revoked'])
    expect(rows[0]?.previous_status).toBeNull()
    // Derived from what was already there, which is the only version of this
    // column that can be used as evidence of a transition.
    expect(rows[1]?.previous_status).toBe('granted')
  })

  it('normalises the value inside the function, not at the call site', async () => {
    // Six ingress points reach consent. A helper all six must remember to call
    // is a helper one of them will not — and `+1 305 555 0171` failing to match
    // `+13055550171` is a STOP that silently does not apply.
    await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
      await tx.execute(raw`
        SELECT app.consent_append('phone', ' +1 305 555 0171 ', 'call', 'granted',
                                  'implied', 'manual', now())`)
    })

    const [row] = await sql<{ contact_value_norm: string }[]>`
      SELECT contact_value_norm FROM app.consent_ledger
       WHERE tenant_id = ${TENANT} AND channel = 'call'`
    expect(row?.contact_value_norm).toBe(PHONE)
  })

  it('records the actor from the session and never from a parameter', async () => {
    const [row] = await sql<{ actor_user_id: string | null }[]>`
      SELECT actor_user_id FROM app.consent_ledger
       WHERE tenant_id = ${TENANT} AND channel = 'call'`
    expect(row?.actor_user_id).toBe(ANA)
  })

  it('refuses to write outside a tenant session', async () => {
    // Fails closed. A consent row written into the wrong tenant is worse than a
    // refused write, and there is no repair for it: the table is immutable.
    await expect(
      sql`SELECT app.consent_append('phone', ${PHONE}, 'sms', 'granted', 'implied',
                                    'manual', now())`,
    ).rejects.toThrow(/CN001/)
  })
})

describe('the row is immutable once written', () => {
  it('raises AP001 on UPDATE even for the migrator', async () => {
    // The migrator is the owner and passes p_sys; the trigger is what stops it.
    // An UPDATE that flipped a revoked row back to granted is the single
    // cheapest way to commit a TCPA violation, so it is refused by the engine
    // rather than by review.
    await expect(
      sql`UPDATE app.consent_ledger SET status = 'granted' WHERE tenant_id = ${TENANT}`,
    ).rejects.toThrow(/AP001/)
  })

  it('raises AP001 on DELETE', async () => {
    await expect(sql`DELETE FROM app.consent_ledger WHERE tenant_id = ${TENANT}`).rejects.toThrow(
      /AP001/,
    )
  })
})

describe('the constraints refuse the two rows that would be worthless as evidence', () => {
  it('rejects an import that names no attesting admin', async () => {
    // A CSV import cannot assert that consent exists without naming the human
    // who says so. That name IS the evidentiary value of the row.
    await expect(
      sql`INSERT INTO app.consent_ledger
            (tenant_id, contact_value_kind, contact_value_norm, channel, status,
             consent_type, source, effective_at)
          VALUES (${TENANT}, 'phone', ${PHONE}, 'sms', 'granted', 'express_written',
                  'import_attestation', now())`,
    ).rejects.toThrow(/consent_import_names_attestor/)
  })

  it('rejects a phone value that is not E.164', async () => {
    await expect(
      sql`INSERT INTO app.consent_ledger
            (tenant_id, contact_value_kind, contact_value_norm, channel, status,
             consent_type, source, effective_at)
          VALUES (${TENANT}, 'phone', '305-555-0171', 'sms', 'granted', 'implied',
                  'manual', now())`,
    ).rejects.toThrow(/consent_phone_is_e164/)
  })
})

describe('app.consent_state answers for a contact the caller owns, and nothing else', () => {
  it('returns the latest row per channel', async () => {
    const state = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute<{ channel: string; status: string }>(
        // ORDERED BY THE TEXT, not by the enum. Postgres orders an enum by its
        // DECLARATION order, so `ORDER BY channel` yields sms before call —
        // correct, and a trap worth naming rather than encoding an expectation
        // that silently depends on the order the members were written in.
        raw`SELECT channel, status FROM app.consent_state(${anaContact}::uuid)
            ORDER BY channel::text`,
      ),
    )
    // sms revoked (the STOP superseded the grant), call granted.
    expect(state.map((r) => [r.channel, r.status])).toEqual([
      ['call', 'granted'],
      ['sms', 'revoked'],
    ])
  })

  it("returns nothing for a contact in another seller's book, and does not raise", async () => {
    // THE SILO PROPERTY, and the reason ownership is re-asserted INSIDE the
    // function: a definer runs as the migrator, so the RLS that scopes every
    // other read in this system is switched off in there. Without that
    // predicate Ana could pass any contact id and read a stranger's consent.
    //
    // Zero rows and NOT an error, on purpose. An error would confirm the record
    // exists — the same leak wearing a status code.
    const state = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute(raw`SELECT * FROM app.consent_state(${benContact}::uuid)`),
    )
    expect(state).toHaveLength(0)
  })

  it('has something to hide in the first place', async () => {
    // THE POSITIVE CONTROL, and the assertion above is worthless without it.
    // Emptiness proves nothing when the table is empty: the fixture must seed
    // consent that Ben can see, so "Ana sees none of it" is the ownership
    // predicate doing work rather than the absence of data. The first version
    // of this suite had no such row, and deleting the predicate left every
    // test green.
    const own = await withTenant({ tenantId: TENANT, userId: BEN }, async (tx) =>
      tx.execute<{ status: string }>(
        raw`SELECT status FROM app.consent_state(${benContact}::uuid)`,
      ),
    )
    expect(own).toHaveLength(1)
    expect(own[0]?.status).toBe('granted')
  })

  it('is indistinguishable from a contact that does not exist', async () => {
    const missing = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute(
        raw`SELECT * FROM app.consent_state('00000000-0000-7000-8000-0000000c05ff'::uuid)`,
      ),
    )
    expect(missing).toHaveLength(0)
  })

  it('lets a supervisor read across the tenant, which is the one sanctioned widening', async () => {
    const state = await withTenant({ tenantId: TENANT, userId: SUPER }, async (tx) =>
      tx.execute(raw`SELECT * FROM app.consent_state(${anaContact}::uuid)`),
    )
    expect(state.length).toBeGreaterThan(0)
  })
})
