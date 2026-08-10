import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'

import { TEST_URL } from './setup/urls'

/**
 * Contact field editing and the bad-number flag (MVP item 27).
 *
 * `bad_number_at` was the second dead column this work found by asking who
 * writes a column before building on it. Its consequence was concrete: a number
 * that has already bounced was still offered for dialling, so a seller burned
 * attempts on a line that cannot connect and the vendor's data-quality rate was
 * unmeasurable.
 *
 * Both functions are SECURITY INVOKER, so the silo comes from RLS rather than
 * from a predicate somebody wrote — which means the cross-silo assertions here
 * are testing the CLASS of the table, and would catch a future migration
 * reclassifying it.
 */

const TENANT = '00000000-0000-7000-8000-0000000ed170'
const ANA = '00000000-0000-7000-8000-0000000ed1a1'
const BEN = '00000000-0000-7000-8000-0000000ed1b1'

let sql: postgres.Sql
let anaContact: string
let anaPhone: string
let benPhone: string

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Editing Agency', 'America/New_York')`
  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA}, 'ana@ed.test', 'Ana Seller', 'Ana A.', 'seller'),
      (${TENANT}, ${BEN}, 'ben@ed.test', 'Ben Seller', 'Ben B.', 'seller')`

  const mk = async (owner: string, phone: string): Promise<[string, string]> => {
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via, state_code, zip5)
      VALUES (${TENANT}, ${owner}, 'Marisol Vega', 'lead_intake', 'NY', '10001') RETURNING id`
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO app.contact_phone (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
      VALUES (${TENANT}, ${c?.id ?? ''}, ${owner}, ${phone}, true) RETURNING id`
    return [c?.id ?? '', p?.id ?? '']
  }

  ;[anaContact, anaPhone] = await mk(ANA, '+12125550190')
  ;[, benPhone] = await mk(BEN, '+12125550191')
})

afterAll(async () => {
  await sql?.end()
})

async function flag(userId: string, phoneId: string, reason: string): Promise<boolean> {
  const rows = await withTenant({ tenantId: TENANT, userId }, async (tx) =>
    tx.execute<{ contact_flag_bad_number: boolean }>(
      raw`SELECT app.contact_flag_bad_number(${phoneId}::uuid, ${reason})`,
    ),
  )
  return rows[0]?.contact_flag_bad_number ?? false
}

describe('the bad-number flag finally has a writer', () => {
  it('marks the number and records why', async () => {
    expect(await flag(ANA, anaPhone, 'carrier rejected: invalid number')).toBe(true)

    const [row] = await sql<{ at: Date | null; reason: string | null }[]>`
      SELECT bad_number_at AS at, bad_number_reason AS reason
        FROM app.contact_phone WHERE id = ${anaPhone}`
    expect(row?.at).not.toBeNull()
    expect(row?.reason).toBe('carrier rejected: invalid number')
  })

  it('refuses a flag with no reason', async () => {
    // The reason is what makes vendor data quality measurable. "bad" is not one,
    // and an empty string is how a required field becomes optional in practice.
    const refusal = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute(raw`SELECT app.contact_flag_bad_number(${benPhone}::uuid, '   ')`),
    )
      .then(() => null)
      .catch((e: unknown) => (e instanceof Error ? `${e.message} | ${String(e.cause)}` : ''))
    expect(refusal).toMatch(/CB001/)
  })

  it('keeps the FIRST flag, because the timestamp is evidence', async () => {
    // bad_number_at is when we LEARNED the number was bad. A later failed dial
    // does not make it newly bad, and overwriting would quietly move the
    // evidence of when the vendor sold us a dead line.
    const [before] = await sql<{ at: Date }[]>`
      SELECT bad_number_at AS at FROM app.contact_phone WHERE id = ${anaPhone}`

    expect(await flag(ANA, anaPhone, 'second failure, later')).toBe(false)

    const [after] = await sql<{ at: Date; reason: string }[]>`
      SELECT bad_number_at AS at, bad_number_reason AS reason
        FROM app.contact_phone WHERE id = ${anaPhone}`
    expect(after?.at.getTime()).toBe(before?.at.getTime())
    expect(after?.reason).toBe('carrier rejected: invalid number')
  })

  it('can be lifted, because a flag nobody can clear is a lead nobody can call', async () => {
    const cleared = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute<{ contact_clear_bad_number: boolean }>(
        raw`SELECT app.contact_clear_bad_number(${anaPhone}::uuid)`,
      ),
    )
    expect(cleared[0]?.contact_clear_bad_number).toBe(true)

    const [row] = await sql<{ at: Date | null }[]>`
      SELECT bad_number_at AS at FROM app.contact_phone WHERE id = ${anaPhone}`
    expect(row?.at).toBeNull()
  })
})

describe('the silo comes from RLS, not from a predicate somebody wrote', () => {
  it("cannot flag a number in another seller's book", async () => {
    // Returns false rather than raising: the UPDATE simply matches no visible
    // row. Owner-scoped not-found, for free, because contact_phone is
    // owner_scoped and the function is SECURITY INVOKER.
    expect(await flag(ANA, benPhone, 'trying to touch a stranger')).toBe(false)

    const [row] = await sql<{ at: Date | null }[]>`
      SELECT bad_number_at AS at FROM app.contact_phone WHERE id = ${benPhone}`
    expect(row?.at, "Ana flagged Ben's number").toBeNull()
  })

  it('lets the owner do it, which is what makes the assertion above mean something', async () => {
    expect(await flag(BEN, benPhone, 'owner flagging their own')).toBe(true)
  })
})

describe('editing fields', () => {
  it('changes only what was passed', async () => {
    // NULL means "leave this alone", so a caller sending one field cannot blank
    // the other three by omission.
    await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
      await tx.execute(raw`SELECT app.contact_edit(${anaContact}::uuid, 'Marisol Vega-Ruiz')`)
    })

    const [row] = await sql<{ full_name: string; state_code: string; zip5: string }[]>`
      SELECT full_name, state_code, zip5 FROM app.contact WHERE id = ${anaContact}`
    expect(row?.full_name).toBe('Marisol Vega-Ruiz')
    expect(row?.state_code).toBe('NY')
    expect(row?.zip5).toBe('10001')
  })

  it('lowercases the stored email rather than only comparing case-insensitively', async () => {
    // citext already folds case for comparison; the STORED value is what a
    // seller reads back, and two spellings of one address reading differently
    // on two screens is how a duplicate gets created by hand.
    await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
      await tx.execute(
        raw`SELECT app.contact_edit(${anaContact}::uuid, NULL, '  Marisol.Vega@Example.COM ')`,
      )
    })
    const [row] = await sql<{ email_norm: string }[]>`
      SELECT email_norm::text FROM app.contact WHERE id = ${anaContact}`
    expect(row?.email_norm).toBe('marisol.vega@example.com')
  })

  it('refuses to rename a contact to nothing', async () => {
    const refusal = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute(raw`SELECT app.contact_edit(${anaContact}::uuid, '   ')`),
    )
      .then(() => null)
      .catch((e: unknown) => (e instanceof Error ? `${e.message} | ${String(e.cause)}` : ''))
    expect(refusal).toMatch(/CB002/)
  })

  it('moves the calling window when the ZIP changes, which is why it is not cosmetic', async () => {
    // A ZIP edit changes which candidate zones the gate resolves, and therefore
    // when this lead may legally be called. Seeded with a Florida ZIP that
    // resolves, so the verdict is observably different from the state-only path.
    // A ZIP THIS SUITE OWNS. The first version seeded 33101 — which is the row
    // `calling-window.test.ts` inserts in its own beforeAll, without
    // ON CONFLICT — so whichever file ran second died on a duplicate key and
    // took its whole fixture with it. `crm_test` is shared, and this is the
    // fifth time that has been paid for; the first four were tenant ids, this
    // one was reference data.
    await sql`INSERT INTO ref.zip_timezone (zip5, tz) VALUES ('33139', 'America/New_York')
              ON CONFLICT DO NOTHING`
    await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) => {
      await tx.execute(raw`SELECT app.contact_edit(${anaContact}::uuid, NULL, NULL, 'FL', '33139')`)
    })

    const rows = await withTenant({ tenantId: TENANT, userId: ANA }, async (tx) =>
      tx.execute<{ source: string; zones: string[] }>(
        raw`SELECT source, zones FROM app.calling_window_check(${anaContact}::uuid)`,
      ),
    )
    // Resolved by ZIP now, not by the two-zone Florida state fallback.
    expect(rows[0]?.source).toBe('zip')
    expect(rows[0]?.zones).toEqual(['America/New_York'])
  })
})
