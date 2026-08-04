import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { toE164 } from '~/lib/phone/e164'
import { readContactFor } from '~/routes/api/contact'
import { readSearchFor } from '~/routes/api/search'

import { TEST_URL } from './setup/urls'

/**
 * Global search — `DEMO-08`, and §7's recovery path.
 *
 * Two properties carry everything here and they fail in opposite ways.
 *
 * THE SILO is the one that fails silently and badly: a search that reached
 * across books would show a seller another seller's leads, and the result set
 * looks completely normal — a list of names, with the wrong names on it. It is
 * asserted from BOTH directions, because a query that returns nothing passes a
 * naive silo test for the wrong reason.
 *
 * 🔬 AND A MUTATION THAT STAYED GREEN, recorded instead of hidden. Opening the
 * endpoint's own owner predicate to `true` changed nothing: `contact`'s
 * `owner_scoped` RLS policy had already scoped the rows before the query ran.
 * So what these assertions prove is the PROPERTY — a seller never sees another
 * book — and not which layer delivers it. The database does, which is the
 * design working; the application predicate is the second layer. Said plainly
 * because a test whose subject is not what its name implies is how a suite
 * stops meaning anything.
 *
 * THE NORMALISATION is the one that fails visibly and expensively: a seller
 * reads `937-555-0142` off a screen while her handset is ringing, and a search
 * that matched the typed text finds nothing on the one query the flow was
 * designed around.
 */

const TENANT = '00000000-0000-7000-8000-0000000000fc'
const OTHER_TENANT = '00000000-0000-7000-8000-0000000000fd'
const ANA = '00000000-0000-7000-8000-00000000fc01'
const BEN = '00000000-0000-7000-8000-00000000fc02'
const SUPERVISOR = '00000000-0000-7000-8000-00000000fc09'
const OUTSIDER = '00000000-0000-7000-8000-00000000fd01'

let sql: postgres.Sql

async function contact(
  tenant: string,
  owner: string,
  name: string,
  o: { phone?: string; email?: string } = {},
): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO app.contact (tenant_id, owner_user_id, full_name, email_norm, created_via)
    VALUES (${tenant}, ${owner}, ${name}, ${o.email ?? null}, 'lead_intake')
    RETURNING id`

  if (o.phone !== undefined) {
    await sql`
      INSERT INTO app.contact_phone
        (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
      VALUES (${tenant}, ${row?.id ?? null}, ${owner}, ${o.phone}, true)`
  }
}

const search = (userId: string, q: string, tenant = TENANT) =>
  readSearchFor({ tenantId: tenant, userId }, q)

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  for (const [id, name] of [
    [TENANT, 'Search Agency'],
    [OTHER_TENANT, 'Other Agency'],
  ] as const) {
    await sql`INSERT INTO app.tenant (id, name, business_tz)
              VALUES (${id}, ${name}, 'America/New_York')`
  }

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ANA},        'ana@s.test', 'Ana Reyes',  'Ana R.', 'seller'),
      (${TENANT}, ${BEN},        'ben@s.test', 'Ben Ortiz',  'Ben O.', 'seller'),
      (${TENANT}, ${SUPERVISOR}, 'sup@s.test', 'Sue Pardo',  'Sue P.', 'supervisor'),
      (${OTHER_TENANT}, ${OUTSIDER}, 'out@o.test', 'Otto Lin', 'Otto L.', 'seller')`

  await contact(TENANT, ANA, 'Curtis Vance', {
    phone: '+19375550142',
    email: 'curtis@example.test',
  })
  await contact(TENANT, ANA, 'Doris Whitfield', { phone: '+15125550188' })
  // Ben's, and the name deliberately shares a word with one of Ana's.
  await contact(TENANT, BEN, 'Curtis Bramble', { phone: '+16145550199' })
  // Another tenant entirely, same phone digits as Ana's contact.
  await contact(OTHER_TENANT, OUTSIDER, 'Curtis Elsewhere', { phone: '+19375550142' })
})

afterAll(async () => {
  await sql?.end()
})

describe('a seller searches their own book and only their own', () => {
  it('finds their own contact by name', async () => {
    const found = await search(ANA, 'Curtis')

    expect(found.hits.map((h) => h.fullName)).toEqual(['Curtis Vance'])
    expect(found.global).toBe(false)
  })

  it('does NOT find another seller in the same tenant', async () => {
    // The assertion that matters, from the direction that can fail silently.
    // Ben's `Curtis Bramble` matches the same query and must not appear.
    const found = await search(ANA, 'Curtis')

    expect(found.hits.map((h) => h.fullName)).not.toContain('Curtis Bramble')
  })

  it('proves the query itself is good, by finding it as its owner', async () => {
    // The other direction. Without this, "Ana cannot see Curtis Bramble" would
    // also pass if the search were simply broken.
    const found = await search(BEN, 'Curtis')

    expect(found.hits.map((h) => h.fullName)).toEqual(['Curtis Bramble'])
  })

  it('never crosses a tenant, even on an identical phone number', async () => {
    // Two tenants legitimately hold the same digits: one household, two
    // agencies that bought the same ping-post lead.
    const found = await search(ANA, '937-555-0142')

    expect(found.hits.map((h) => h.fullName)).toEqual(['Curtis Vance'])
    expect(found.hits.map((h) => h.fullName)).not.toContain('Curtis Elsewhere')
  })
})

describe('a phone number is found however the seller types it', () => {
  const shapes = ['937-555-0142', '(937) 555-0142', '9375550142', '+19375550142', '1 937 555 0142']

  for (const shape of shapes) {
    it(`finds the record from ${shape}`, async () => {
      // §7's whole recovery path: the handset is ringing, and the seller types
      // the number the way she reads it.
      const found = await search(ANA, shape)

      expect(found.hits.map((h) => h.fullName)).toEqual(['Curtis Vance'])
      expect(found.hits[0]?.matchedOn).toBe('phone')
    })
  }

  it('finds a record from the last four digits', async () => {
    const found = await search(ANA, '0188')

    expect(found.hits.map((h) => h.fullName)).toEqual(['Doris Whitfield'])
  })

  it('normalises to E.164 without validating, so a typo returns nothing', async () => {
    // Normalisation answers "what number could this be"; the database's CHECK
    // decides what is storable. A search that REFUSED a malformed query would
    // punish a typo instead of returning nothing.
    expect(toE164('937-555-0142')).toBe('+19375550142')
    expect(toE164('19375550142')).toBe('+19375550142')
    expect(toE164('Curtis')).toBeNull()

    const found = await search(ANA, '937-555-9999')
    expect(found.hits).toEqual([])
    expect(found.asPhone, 'the empty state needs the number to offer a quick-add').toBe(
      '+19375559999',
    )
  })
})

describe('the match is reported honestly', () => {
  it('says which field matched, and prefers the identification', async () => {
    // A contact found by phone AND by name is reported as found by phone: one
    // is an identification and the other is a guess.
    const byEmail = await search(ANA, 'curtis@example')
    expect(byEmail.hits[0]?.matchedOn).toBe('email')

    const byName = await search(ANA, 'Vance')
    expect(byName.hits[0]?.matchedOn).toBe('name')
  })

  it('returns nothing at all below the minimum query length', async () => {
    // Two characters, and until then the overlay shows `search.idle`. A
    // one-character query against a fifty-seller tenant is a table scan
    // nobody asked for.
    expect((await search(ANA, 'C')).hits).toEqual([])
  })
})

describe('a supervisor reads every book, and every row says whose', () => {
  it('returns both sellers and names the owner on each row', async () => {
    const found = await search(SUPERVISOR, 'Curtis')

    expect(found.global).toBe(true)
    expect(found.hits.map((h) => h.fullName).sort()).toEqual(['Curtis Bramble', 'Curtis Vance'])
    // §7: a global result set without an owner on each row is a supervisor
    // reading fifty books as if they were one.
    expect(found.hits.every((h) => h.ownerName !== null)).toBe(true)
  })

  it('gives a seller no owner chip, because there is nobody else on the list', async () => {
    const found = await search(ANA, 'Curtis')

    expect(found.hits.every((h) => h.ownerName === null)).toBe(true)
  })
})

describe('a foreign contact id is not found, never forbidden', () => {
  /**
   * Protected item `DEMO-04`, on the screen a pasted URL actually lands on.
   *
   * A 403 confirms the record exists. Not-found tells a prober nothing, which
   * is the entire point of a silo — and it is the difference between "somebody
   * has a contact with this id" and silence.
   */
  it('returns null for a contact that belongs to another seller', async () => {
    const [ben] = await sql<{ id: string }[]>`
      SELECT id FROM app.contact
       WHERE tenant_id = ${TENANT} AND full_name = 'Curtis Bramble'`

    expect(ben?.id, 'the fixture lost the contact this test is about').toBeDefined()
    expect(await readContactFor({ tenantId: TENANT, userId: ANA }, ben?.id ?? '')).toBeNull()
  })

  it('returns the same null for an id that does not exist at all', async () => {
    // The two answers must be INDISTINGUISHABLE. If "not yours" and "no such
    // record" differed by anything — a status, a message, a timing — the
    // difference would be the disclosure.
    const missing = await readContactFor(
      { tenantId: TENANT, userId: ANA },
      '00000000-0000-7000-8000-0000000000ff',
    )
    expect(missing).toBeNull()
  })

  it('returns null for a malformed id instead of raising', async () => {
    // A uuid cast on garbage raises 22P02 and answers 500, which tells a
    // prober their input was interesting and tells a seller their link is
    // broken rather than stale.
    expect(await readContactFor({ tenantId: TENANT, userId: ANA }, 'not-a-uuid')).toBeNull()
  })

  it('gives the owner the record, so the null above is scoping and not breakage', async () => {
    const [ana] = await sql<{ id: string }[]>`
      SELECT id FROM app.contact
       WHERE tenant_id = ${TENANT} AND full_name = 'Curtis Vance'`

    const record = await readContactFor({ tenantId: TENANT, userId: ANA }, ana?.id ?? '')

    expect(record?.fullName).toBe('Curtis Vance')
    expect(record?.phones.map((p) => p.e164)).toEqual(['+19375550142'])
  })

  it('lets a supervisor read across books, which is the one asymmetry', async () => {
    const [ben] = await sql<{ id: string }[]>`
      SELECT id FROM app.contact
       WHERE tenant_id = ${TENANT} AND full_name = 'Curtis Bramble'`

    const record = await readContactFor({ tenantId: TENANT, userId: SUPERVISOR }, ben?.id ?? '')
    expect(record?.fullName).toBe('Curtis Bramble')
  })

  it('never crosses a tenant, not even for a supervisor', async () => {
    const [outside] = await sql<{ id: string }[]>`
      SELECT id FROM app.contact
       WHERE tenant_id = ${OTHER_TENANT} AND full_name = 'Curtis Elsewhere'`

    expect(
      await readContactFor({ tenantId: TENANT, userId: SUPERVISOR }, outside?.id ?? ''),
    ).toBeNull()
  })
})
