import { sql as raw } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withSystemWork, withTenant } from '~/db'

import { TEST_URL } from './setup/urls'

/**
 * The unit-of-work envelope.
 *
 * These assertions are about a failure with no error and no log line: a pooled
 * connection that still carries the previous seller's identity. The pages
 * render perfectly and the rows belong to someone else. Nothing here can be
 * demonstrated with a mock, because the thing under test is what PostgreSQL
 * does with a GUC across a transaction boundary.
 */

const TENANT = '00000000-0000-7000-8000-0000000000f2'
const SELLER = '00000000-0000-7000-8000-0000000000d1'
const SUPERVISOR = '00000000-0000-7000-8000-0000000000d2'
const ADMIN = '00000000-0000-7000-8000-0000000000d3'
const RETIRED = '00000000-0000-7000-8000-0000000000d4'

let sql: postgres.Sql

beforeAll(async () => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })

  await sql`
    INSERT INTO app.tenant (id, name, business_tz)
    VALUES (${TENANT}, 'Context Agency', 'America/Chicago')`

  await sql`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role, deactivated_at) VALUES
      (${TENANT}, ${SELLER},     'sel@ctx.test', 'Sel Ler',  'Sel',  'seller',     NULL),
      (${TENANT}, ${SUPERVISOR}, 'sup@ctx.test', 'Sup Er',   'Sup',  'supervisor', NULL),
      (${TENANT}, ${ADMIN},      'adm@ctx.test', 'Adm In',   'Adm',  'admin',      NULL),
      (${TENANT}, ${RETIRED},    'ret@ctx.test', 'Ret Ired', 'Ret',  'seller',     clock_timestamp())`
})

afterAll(async () => {
  await sql?.end()
})

/**
 * Drizzle wraps a driver error in "Failed query: ..." and keeps the PostgreSQL
 * one on `cause`, so a naive toThrow(/CTX002/) passes for the wrong reason —
 * it matches nothing and reports the wrapper. Worth knowing beyond the tests:
 * the route boundary that maps SQLSTATE to an HTTP status has to walk this
 * same chain, or a 42501 arrives looking like an unclassified 500.
 */
async function rejectionChain(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return '<resolved>'
  } catch (err: unknown) {
    const parts: string[] = []
    let current: unknown = err
    while (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    }
    return parts.join(' | ')
  }
}

describe('scope is derived by the engine, never supplied by the caller', () => {
  it.each([
    ['seller', SELLER, 'owner'],
    ['supervisor', SUPERVISOR, 'tenant_read'],
    ['admin', ADMIN, 'tenant_admin'],
  ])('maps a %s to scope %s', async (_role, userId, expected) => {
    const scope = await withTenant({ tenantId: TENANT, userId }, (_tx, s) => Promise.resolve(s))
    expect(scope).toBe(expected)
  })

  it('reads the scope back inside the transaction, matching what it returned', async () => {
    const seen = await withTenant({ tenantId: TENANT, userId: SUPERVISOR }, async (tx) => {
      const rows = await tx.execute<{ mode: string; tid: string; uid: string }>(
        raw`SELECT current_setting('app.scope_mode', true) AS mode,
                   current_setting('app.tenant_id',  true) AS tid,
                   current_setting('app.user_id',    true) AS uid`,
      )
      return rows[0]
    })

    expect(seen).toEqual({ mode: 'tenant_read', tid: TENANT, uid: SUPERVISOR })
  })

  it('refuses a deactivated user, so a departed seller cannot open a unit of work', async () => {
    const chain = await rejectionChain(
      withTenant({ tenantId: TENANT, userId: RETIRED }, () => Promise.resolve(null)),
    )
    expect(chain).toMatch(/CTX002/)
  })

  it('refuses a user id that belongs to no one, without saying which half was wrong', async () => {
    const chain = await rejectionChain(
      withTenant({ tenantId: TENANT, userId: '00000000-0000-7000-8000-0000000000ff' }, () =>
        Promise.resolve(null),
      ),
    )
    expect(chain).toMatch(/CTX002/)
    // Says nothing about whether the tenant or the user was the wrong half.
    expect(chain).not.toMatch(/tenant does not exist|no such user/i)
  })
})

describe('context does not survive the unit of work', () => {
  it('leaves nothing behind for the next unit of work on the same pooled connection', async () => {
    // This is the pg-boss-job-after-an-HTTP-request scenario reduced to its
    // mechanism: two consecutive units of work that will reuse a connection.
    // If the first one's identity survived, the second would silently act as
    // the wrong person.
    await withTenant({ tenantId: TENANT, userId: SUPERVISOR }, () => Promise.resolve(null))

    const second = await withTenant({ tenantId: TENANT, userId: SELLER }, async (tx) => {
      const rows = await tx.execute<{ uid: string; mode: string }>(
        raw`SELECT current_setting('app.user_id', true) AS uid,
                   current_setting('app.scope_mode', true) AS mode`,
      )
      return rows[0]
    })

    expect(second?.uid).toBe(SELLER)
    expect(second?.mode).toBe('owner')
  })

  it('resets the GUCs at COMMIT, leaving the raw connection contextless', async () => {
    await withTenant({ tenantId: TENANT, userId: ADMIN }, () => Promise.resolve(null))

    const [after] = await sql<{ tid: string | null }[]>`
      SELECT nullif(current_setting('app.tenant_id', true), '') AS tid`
    expect(after?.tid).toBeNull()
  })

  it('resets them after a failed unit of work too', async () => {
    await expect(
      withTenant({ tenantId: TENANT, userId: ADMIN }, () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const [after] = await sql<{ tid: string | null }[]>`
      SELECT nullif(current_setting('app.tenant_id', true), '') AS tid`
    expect(after?.tid).toBeNull()
  })
})

describe('leaked context is detected at the engine, on the first request', () => {
  it('raises CTX001 rather than serving the previous identity', async () => {
    // Deliberately creates the exact leak the design forbids: a SESSION-scoped
    // setting that survives the transaction, which is what a session-mode
    // pooler produces. One reserved connection, so the poisoned session is the
    // one begin_request then runs on.
    const reserved = await sql.reserve()
    try {
      // eslint-disable-next-line no-restricted-syntax -- this test exists to prove the guard's premise; it must create the leak to detect it
      await reserved`SET app.tenant_id = '00000000-0000-7000-8000-0000000000ee'`

      await expect(
        reserved`SELECT app.begin_request(${TENANT}::uuid, ${SELLER}::uuid)`,
      ).rejects.toThrow(/CTX001/)
    } finally {
      await reserved`RESET app.tenant_id`
      reserved.release()
    }
  })
})

describe('the system scope is a separate door', () => {
  it('carries no user and reports scope_mode = system', async () => {
    const seen = await withSystemWork(TENANT, async (tx) => {
      const rows = await tx.execute<{ mode: string; uid: string }>(
        raw`SELECT current_setting('app.scope_mode', true) AS mode,
                   current_setting('app.user_id',    true) AS uid`,
      )
      return rows[0]
    })

    expect(seen?.mode).toBe('system')
    expect(seen?.uid).toBe('')
  })
})
