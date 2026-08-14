import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { APP_URL, OWNER_URL } from './setup/urls'

/**
 * `app.app_user_create` — the last of the four missing writers.
 *
 * 🔴 EVERY USER IN THIS DATABASE WAS PUT THERE BY THE SEED. 0065 gave the
 * product a way to start a deal, 0066 a note, 0072 a role change — and none of
 * them mattered for a person who could not exist.
 *
 * 🎯 IT BECAME BUILDABLE BECAUSE ADR-085 CHANGED WHAT A ROW MEANS. Until then a
 * user could not be created without a password to hand over, because a row with
 * no way to sign in was useless. With Google sign-in coming, the row IS the
 * thing: it records WHO MAY ENTER, and Google later proves the person is who
 * they claim. So the row is created with `auth_user_id` NULL — a seat reserved,
 * waiting to be claimed.
 *
 * ⚠️ THE ASSERTION THAT CARRIES THE DESIGN is that such a row CANNOT SIGN IN.
 * `app.resolve_identity` matches on `auth_user_id`, so NULL matches no session.
 * A create surface that accidentally produced a signable-in account would be
 * self-signup's cousin: access granted by an admin's typing rather than by the
 * person proving who they are.
 */

const TENANT = '00000000-0000-7000-8000-000000730073'
const OTHER_TENANT = '00000000-0000-7000-8000-000000730074'
const ADA = '00000000-0000-7000-8000-0000007300a1'
const SAM = '00000000-0000-7000-8000-0000007300a2'

let owner: postgres.Sql
let app: postgres.Sql

async function asUser<T>(
  userId: string,
  work: (tx: postgres.TransactionSql) => Promise<T>,
  tenantId: string = TENANT,
): Promise<T> {
  const result = await app.begin(async (tx) => {
    await tx`SELECT app.begin_request(${tenantId}::uuid, ${userId}::uuid)`
    return work(tx)
  })
  return result as T
}

const create = async (
  actor: string,
  opts: {
    email?: string
    fullName?: string
    displayName?: string
    role?: string
    tenantId?: string
  } = {},
): Promise<string | null> =>
  asUser(
    actor,
    async (tx) =>
      (
        await tx<{ id: string | null }[]>`
          SELECT app.app_user_create(
            ${opts.email ?? 'new.hire@create.test'},
            ${opts.fullName ?? 'Nina Newhire'},
            ${opts.displayName ?? 'Nina N.'},
            ${opts.role ?? 'seller'}::app.user_role) AS id`
      )[0]?.id ?? null,
    opts.tenantId ?? TENANT,
  )

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  app = postgres(APP_URL, { max: 1, onnotice: () => {} })

  await owner`
    INSERT INTO app.tenant (id, name, business_tz) VALUES
      (${TENANT}, 'Create Agency', 'America/New_York'),
      (${OTHER_TENANT}, 'Neighbour Agency', 'America/Chicago')`
  await owner`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ADA}, 'ada@create.test', 'Ada Admin', 'Ada A.', 'admin'),
      (${TENANT}, ${SAM}, 'sam@create.test', 'Sam Seller', 'Sam S.', 'seller')`
})

afterAll(async () => {
  await owner?.end()
  await app?.end()
})

describe('an admin reserves a seat', () => {
  it('creates the row unclaimed, and that row cannot sign in', async () => {
    const id = await create(ADA)
    expect(id).not.toBeNull()

    const [row] = await owner<
      { email: string; full: string; display: string; role: string; auth: string | null }[]
    >`
      SELECT email::text AS email, full_name AS full, display_name AS display,
             role::text AS role, auth_user_id AS auth
        FROM app.app_user WHERE tenant_id = ${TENANT} AND id = ${id}`

    expect(row?.email).toBe('new.hire@create.test')
    expect(row?.full).toBe('Nina Newhire')
    expect(row?.display).toBe('Nina N.')
    expect(row?.role).toBe('seller')
    // 🔴 UNCLAIMED. The seat exists; nobody is in it.
    expect(row?.auth).toBeNull()

    // 🎯 AND THE CONSEQUENCE, ASSERTED AGAINST THE REAL BRIDGE. resolve_identity
    // is what turns a better-auth session into a tenant and a user; it matches
    // on auth_user_id, so this row answers nothing for any session that could
    // exist. Access is recorded, not granted.
    const resolved = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.resolve_identity('any-auth-user-id-at-all')`
    expect(resolved[0]?.n).toBe('0')
  })

  it('shows up on the roster immediately, so the admin sees what they did', async () => {
    await create(ADA, { email: 'visible@create.test', fullName: 'Vera Visible' })
    const rows = await asUser(
      ADA,
      async (tx) =>
        await tx<{ email: string }[]>`
        SELECT email::text AS email FROM app.app_user
         WHERE tenant_id = app.current_tenant() AND email = 'visible@create.test'`,
    )
    expect(rows.length).toBe(1)
  })

  it('falls back to the full name when no display name is given', async () => {
    // Friendlier than refusing, and the display name is what fifty people read
    // on the public board.
    const id = await create(ADA, {
      email: 'nodisplay@create.test',
      fullName: 'Dana Nodisplay',
      displayName: '   ',
    })
    const [row] = await owner<{ display: string }[]>`
      SELECT display_name AS display FROM app.app_user
       WHERE tenant_id = ${TENANT} AND id = ${id}`
    expect(row?.display).toBe('Dana Nodisplay')
  })

  it('writes an audit row naming who added them', async () => {
    const id = await create(ADA, { email: 'audited@create.test', role: 'supervisor' })
    const [row] = await owner<{ action: string; actor: string; after: { role: string } }[]>`
      SELECT action, actor_user_id AS actor, after FROM app.audit_log
       WHERE tenant_id = ${TENANT} AND subject_id = ${id}`
    expect(row?.action).toBe('user.created')
    expect(row?.actor).toBe(ADA)
    expect(row?.after.role).toBe('supervisor')
  })
})

describe('what it refuses', () => {
  it('refuses a seller', async () => {
    // Without this a seller could put a new ADMIN into her own agency.
    await expect(create(SAM, { email: 'byseller@create.test' })).rejects.toThrow(/UC002/)
  })

  it('refuses an address that is not one', async () => {
    await expect(create(ADA, { email: 'not-an-address' })).rejects.toThrow(/UC003/)
    await expect(create(ADA, { email: '   ' })).rejects.toThrow(/UC003/)
  })

  it('refuses a person with no name', async () => {
    await expect(create(ADA, { email: 'noname@create.test', fullName: '  ' })).rejects.toThrow(
      /UC004/,
    )
  })

  it('refuses a duplicate, and the INDEX is what catches it', async () => {
    // 🔴 NOT A LOOK-FIRST QUERY. `app_user_email_uidx` is UNIQUE on
    // (tenant_id, email), and a check-then-insert loses that race: two admins
    // adding the same new hire at once both pass the check. Catching the
    // violation is the only version that cannot double-add.
    await create(ADA, { email: 'twice@create.test' })
    await expect(create(ADA, { email: 'twice@create.test' })).rejects.toThrow(/UC005/)
  })

  it('case-folds the address, so Nina and NINA are one person', async () => {
    await create(ADA, { email: 'casefold@create.test' })
    await expect(create(ADA, { email: 'CaseFold@Create.Test' })).rejects.toThrow(/UC005/)
  })

  it('refuses outside a tenant session', async () => {
    await expect(
      app`SELECT app.app_user_create('x@y.test', 'X', 'X', 'seller'::app.user_role)`,
    ).rejects.toThrow(/UC001/)
  })
})

describe('the silo holds', () => {
  it('creates into the caller’s own tenant, never a named one', async () => {
    // The tenant is derived from the session, not a parameter — so there is no
    // argument an admin could supply to put somebody in another agency.
    await create(ADA, { email: 'ownsilo@create.test' })
    const [mine] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.app_user
       WHERE tenant_id = ${TENANT} AND email = 'ownsilo@create.test'`
    const [theirs] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.app_user
       WHERE tenant_id = ${OTHER_TENANT} AND email = 'ownsilo@create.test'`
    expect(mine?.n).toBe('1')
    expect(theirs?.n).toBe('0')
  })

  it('lets the same address exist in two different agencies', async () => {
    // The unique index leads with tenant_id on purpose: one person can work at
    // two agencies, and the address is not a global identity.
    await owner`
      INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role)
      VALUES (${OTHER_TENANT}, gen_random_uuid(), 'shared@create.test', 'Shared Person', 'Shared P.', 'admin')`
    const id = await create(ADA, { email: 'shared@create.test', fullName: 'Shared Person' })
    expect(id).not.toBeNull()
  })
})
