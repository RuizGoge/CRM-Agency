import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withTenant } from '~/db'
import { resolveIdentity } from '~/lib/auth/identity'
import { auth } from '~/lib/auth/server'

import { TEST_URL } from './setup/urls'

/**
 * From a cookie to a scoped unit of work.
 *
 * The property under test is that the cookie decides only WHO signed in. What
 * seat that is, and what the seat is allowed to see, are both read from the
 * database afterwards — so a forged session payload buys an attacker nothing.
 */

const TENANT = '00000000-0000-7000-8000-0000000000f3'
const SEAT_ACTIVE = '00000000-0000-7000-8000-0000000000e1'
const SEAT_RETIRED = '00000000-0000-7000-8000-0000000000e2'

let sql: postgres.Sql

/** Signs up through better-auth and returns the auth user id. */
async function signUp(email: string, password: string): Promise<string> {
  const result = await auth.api.signUpEmail({
    body: { email, password, name: email },
  })
  return result.user.id
}

/** Signs in and returns a Request carrying the session cookie. */
async function signInAsRequest(email: string, password: string): Promise<Request> {
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  })
  const cookie = response.headers.get('set-cookie')
  expect(cookie, 'sign-in returned no session cookie').toBeTruthy()
  return new Request('http://localhost:3000/', {
    headers: { cookie: cookie ?? '' },
  })
}

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Auth Agency', 'America/Denver')`

  const activeAuthId = await signUp('active@auth.test', 'correct-horse-battery')
  const retiredAuthId = await signUp('retired@auth.test', 'correct-horse-battery')
  await signUp('seatless@auth.test', 'correct-horse-battery')

  await sql`
    INSERT INTO app.app_user
      (tenant_id, id, auth_user_id, email, full_name, display_name, role, deactivated_at)
    VALUES
      (${TENANT}, ${SEAT_ACTIVE},  ${activeAuthId},  'active@auth.test',  'Ana Active',  'Ana', 'supervisor', NULL),
      (${TENANT}, ${SEAT_RETIRED}, ${retiredAuthId}, 'retired@auth.test', 'Rob Retired', 'Rob', 'seller',     clock_timestamp())`
})

afterAll(async () => {
  await sql?.end()
})

describe('the bridge from a session to a seat', () => {
  it('resolves an active seat and carries its tenant', async () => {
    const request = await signInAsRequest('active@auth.test', 'correct-horse-battery')
    const identity = await resolveIdentity(request)

    expect(identity).toEqual({ tenantId: TENANT, userId: SEAT_ACTIVE })
  })

  it('reads a deactivated seller as signed out rather than disclosing the account', async () => {
    const request = await signInAsRequest('retired@auth.test', 'correct-horse-battery')
    const identity = await resolveIdentity(request)

    expect(identity).toBeNull()
  })

  it('reads an authenticated login with no seat as signed out', async () => {
    // A real state during onboarding: the account exists, an admin has not
    // granted it a seat yet.
    const request = await signInAsRequest('seatless@auth.test', 'correct-horse-battery')
    const identity = await resolveIdentity(request)

    expect(identity).toBeNull()
  })

  it('returns null for a request with no cookie at all', async () => {
    const identity = await resolveIdentity(new Request('http://localhost:3000/'))
    expect(identity).toBeNull()
  })

  it('returns null for a forged session cookie', async () => {
    const request = new Request('http://localhost:3000/', {
      headers: { cookie: 'better-auth.session_token=totally-made-up-token' },
    })
    expect(await resolveIdentity(request)).toBeNull()
  })
})

describe('the resolved identity drives the unit of work', () => {
  it('reaches withTenant and gets the scope its ROLE implies, not one it asked for', async () => {
    const request = await signInAsRequest('active@auth.test', 'correct-horse-battery')
    const identity = await resolveIdentity(request)
    expect(identity).not.toBeNull()

    // Ana is a supervisor. Nothing in the cookie says so, and nothing in the
    // call asks for it: begin_request re-reads app_user.role.
    const scope = identity ? await withTenant(identity, (_tx, s) => Promise.resolve(s)) : null

    expect(scope).toBe('tenant_read')
  })
})

describe('resolve_identity is reachable without session context', () => {
  it('answers even though app_user is unreadable with no context, and skips the deactivated', async () => {
    // Proves the definer property. A plain SELECT here would be denied by the
    // policy and return zero rows — a login that silently never resolves.
    const [row] = await sql<{ user_id: string }[]>`
      SELECT user_id FROM app.resolve_identity(
        (SELECT auth_user_id FROM app.app_user WHERE id = ${SEAT_ACTIVE}))`
    expect(row?.user_id).toBe(SEAT_ACTIVE)

    const retired = await sql<{ user_id: string }[]>`
      SELECT user_id FROM app.resolve_identity(
        (SELECT auth_user_id FROM app.app_user WHERE id = ${SEAT_RETIRED}))`
    expect(retired).toEqual([])
  })
})
