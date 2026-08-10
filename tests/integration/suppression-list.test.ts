import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

import { TEST_URL } from './setup/urls'

/**
 * The suppression list is TENANT-WIDE, and that is the opposite of every other
 * table in this schema.
 *
 * Ping-post resells the same consumer to two sellers inside one agency. A STOP
 * given to Ana has to silence Ben's dialler too — immediately, and without Ben
 * ever learning that Ana holds that lead. Owner-scoping this table would ship a
 * product that honours a STOP for the seller who received it and keeps dialling
 * from the desk next door: a TCPA violation with a design document proving it
 * was deliberate.
 *
 * So the assertions here run in two directions at once, which is unusual. The
 * DATA must cross the silo. The READ must not.
 */

const TENANT = '00000000-0000-7000-8000-0000000509e0'
const OTHER_TENANT = '00000000-0000-7000-8000-0000000509ff'
const ANA = '00000000-0000-7000-8000-0000000509a1'
const BEN = '00000000-0000-7000-8000-0000000509b1'

/** The consumer both sellers bought. */
const SHARED = '+13055550188'

let sql: postgres.Sql

/** The whole error chain: Drizzle rewraps the driver error one level down. */
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
    INSERT INTO app.tenant (id, name, business_tz) VALUES
      (${TENANT},       'Suppression Agency', 'America/New_York'),
      (${OTHER_TENANT}, 'Unrelated Agency',   'America/Chicago')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@supp.test', 'Ana Seller', 'Ana A.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@supp.test', 'Ben Seller', 'Ben B.', 'seller')`
})

afterAll(async () => {
  await sql?.end()
})

describe('a STOP crosses the silo, because the consumer does', () => {
  it('is stored with no owner column at all', async () => {
    // THE STRUCTURAL FORM OF THE RULE. Owner-scoping cannot be added by
    // accident later if there is nowhere to write an owner: the absence of the
    // column is the guarantee, and the registry row agreeing is what stops a
    // future migration from classifying this table as owner_scoped and
    // silently making a STOP seller-local.
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name = 'suppression_list'
         AND column_name = 'owner_user_id'`
    expect(cols).toHaveLength(0)

    const [reg] = await sql<{ policy_class: string; owner_column: string | null }[]>`
      SELECT policy_class, owner_column FROM security.table_registry
       WHERE schema_name = 'app' AND table_name = 'suppression_list'`
    expect(reg?.policy_class).toBe('definer_only')
    expect(reg?.owner_column).toBeNull()
  })

  it("records Ana's STOP against the number, not against Ana", async () => {
    await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
      await tx.execute(raw`
        SELECT app.suppression_append(${SHARED}, 'stop', now() - interval '2 hours',
                                      'sms', NULL, NULL, 'replied STOP')`)
    })

    // Found by number alone, with nothing owner-shaped in the way. This is the
    // row Ben's dialler has to see without Ben ever seeing Ana's lead.
    const rows = await sql<{ kind: string; actor_user_id: string | null }[]>`
      SELECT kind, actor_user_id FROM app.suppression_list
       WHERE tenant_id = ${TENANT} AND phone_e164 = ${SHARED}`
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('stop')
    // The actor is recorded as provenance — it is not a scope.
    expect(rows[0]?.actor_user_id).toBe(ANA)
  })

  it('still stops at the tenant boundary', async () => {
    // Tenant-wide is not global. A STOP in one agency says nothing about
    // another agency's relationship with the same consumer.
    const rows = await sql`
      SELECT 1 FROM app.suppression_list
       WHERE tenant_id = ${OTHER_TENANT} AND phone_e164 = ${SHARED}`
    expect(rows).toHaveLength(0)
  })
})

describe('a START does not erase the STOP', () => {
  it('appends and leaves the earlier row in place', async () => {
    await withTenant({ tenantId: TENANT, userId: BEN }, async (tx) => {
      await tx.execute(raw`
        SELECT app.suppression_append(${SHARED}, 'start', now(), 'sms',
                                      NULL, NULL, 'replied START')`)
    })

    const rows = await sql<{ kind: string }[]>`
      SELECT kind FROM app.suppression_list
       WHERE tenant_id = ${TENANT} AND phone_e164 = ${SHARED}
       ORDER BY effective_at ASC`

    // Both, in order. "Was this number suppressed on the 14th" has to keep
    // answering yes forever, so the re-opt-in is a row and never an update.
    expect(rows.map((r) => r.kind)).toEqual(['stop', 'start'])
  })

  it('refuses an UPDATE with AP001, even for the migrator', async () => {
    // An UPDATE flipping a stop to a start is the single cheapest way to commit
    // a TCPA violation, so the engine refuses it rather than a reviewer.
    await expect(
      sql`UPDATE app.suppression_list SET kind = 'start' WHERE tenant_id = ${TENANT}`,
    ).rejects.toThrow(/AP001/)
  })

  it('refuses a DELETE with AP001', async () => {
    await expect(sql`DELETE FROM app.suppression_list WHERE tenant_id = ${TENANT}`).rejects.toThrow(
      /AP001/,
    )
  })
})

describe('the application role cannot read the list', () => {
  it('holds no privilege of any kind', async () => {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
      const [priv] = await sql<{ ok: boolean }[]>`
        SELECT has_table_privilege('crm_app', 'app.suppression_list', ${p}) AS ok`
      expect(priv?.ok, `crm_app can ${p} suppression_list`).toBe(false)
    }
  })

  it('is refused with permission denied rather than an empty result', async () => {
    // WHY THE LIST IS NOT READABLE EVEN THOUGH IT IS TENANT-WIDE. `stop` means
    // a consumer replied STOP to somebody in this agency — so answering "is
    // this number suppressed" for an arbitrary number answers "is a colleague
    // working this consumer". The data must cross the silo; the query must not.
    const refusal = await withTenant({ tenantId: TENANT, userId: BEN }, async (tx) =>
      tx.execute(raw`SELECT 1 FROM app.suppression_list LIMIT 1`),
    )
      .then(() => null)
      .catch((error: unknown) => chain(error))

    expect(refusal, 'the read was not refused at all').not.toBeNull()
    expect(refusal).toMatch(/permission denied/i)
  })
})

describe('the writer normalises and fails closed', () => {
  it('normalises however the number was typed or delivered', async () => {
    // A STOP arrives from an Aloware webhook, a DNC import, a carrier block and
    // a human. A row whose format does not match what the dialler queries is a
    // suppression that silently never fires.
    await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
      await tx.execute(raw`
        SELECT app.suppression_append(' +1 (305) 555-0199 ', 'dnc_federal', now())`)
    })

    const rows = await sql<{ phone_e164: string }[]>`
      SELECT phone_e164 FROM app.suppression_list
       WHERE tenant_id = ${TENANT} AND kind = 'dnc_federal'`
    expect(rows[0]?.phone_e164).toBe('+13055550199')
  })

  it('leaves channel null when the suppression covers every channel', async () => {
    // A federal DNC listing is not "do not text me", it is "do not contact me".
    // Forcing a channel here would have quietly narrowed it to one.
    const [row] = await sql<{ channel: string | null }[]>`
      SELECT channel FROM app.suppression_list
       WHERE tenant_id = ${TENANT} AND kind = 'dnc_federal'`
    expect(row?.channel).toBeNull()
  })

  it('refuses to write outside a tenant session', async () => {
    await expect(sql`SELECT app.suppression_append(${SHARED}, 'stop', now())`).rejects.toThrow(
      /SP001/,
    )
  })

  it('refuses a value that is not E.164 after normalisation', async () => {
    await expect(
      sql`INSERT INTO app.suppression_list (tenant_id, phone_e164, kind, effective_at)
          VALUES (${TENANT}, 'not-a-number', 'stop', now())`,
    ).rejects.toThrow(/suppression_phone_is_e164/)
  })
})
