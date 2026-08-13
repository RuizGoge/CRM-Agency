import { randomUUID } from 'node:crypto'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { APP_URL, OWNER_URL } from './setup/urls'

/**
 * `app.app_user_set_role` / `app.app_user_set_active` — the writers the role
 * column never had.
 *
 * 🔴 WHY THIS STOPPED BEING TIDY AND BECAME URGENT. A user's role was whatever
 * the seed gave it, for ever. That was a gap while the role only chose a menu.
 * As of this week `app.scope_is_admin()` gates three surfaces: issuing and
 * revoking the ingest credential (0068), correcting the public earnings board
 * (0071), and reading dead letters. So the column that decides who can move
 * money was the one column nothing in the product could write.
 *
 * ⚠️ THE BLOCK THAT MATTERS MOST IS THE LAST ADMIN. Without that guard a tenant
 * can reach a state where NOBODY can issue a credential, correct a wrong number
 * or read a dead letter — and there is no recovery inside the product, because
 * the only fix is an admin and there is none. The remedy would be the
 * provider's SQL console: an outage with a database ticket attached.
 */

const TENANT = '00000000-0000-7000-8000-000000720072'
const OTHER_TENANT = '00000000-0000-7000-8000-000000720073'
const ADA = '00000000-0000-7000-8000-0000007200a1' // admin
const BEN = '00000000-0000-7000-8000-0000007200a2' // admin #2
const SAM = '00000000-0000-7000-8000-0000007200a3' // seller
const OUTSIDER = '00000000-0000-7000-8000-0000007200a4'

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

const setRole = async (
  actor: string,
  target: string,
  role: string,
  reason = 'Promoted to cover the floor while Ada is away.',
  tenantId: string = TENANT,
): Promise<boolean | undefined> =>
  asUser(
    actor,
    async (tx) =>
      (
        await tx<{ ok: boolean }[]>`
          SELECT app.app_user_set_role(${target}::uuid, ${role}::app.user_role, ${reason}) AS ok`
      )[0]?.ok,
    tenantId,
  )

const setActive = async (
  actor: string,
  target: string,
  active: boolean,
  reason = 'Left the agency at the end of the month.',
): Promise<boolean | undefined> =>
  asUser(
    actor,
    async (tx) =>
      (
        await tx<{ ok: boolean }[]>`
          SELECT app.app_user_set_active(${target}::uuid, ${active}, ${reason}) AS ok`
      )[0]?.ok,
  )

const roleOf = async (id: string): Promise<string | undefined> =>
  (
    await owner<{ role: string }[]>`
      SELECT role::text AS role FROM app.app_user WHERE tenant_id = ${TENANT} AND id = ${id}`
  )[0]?.role

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  app = postgres(APP_URL, { max: 1, onnotice: () => {} })

  await owner`
    INSERT INTO app.tenant (id, name, business_tz) VALUES
      (${TENANT}, 'Role Agency', 'America/New_York'),
      (${OTHER_TENANT}, 'Neighbour Agency', 'America/Chicago')`
  await owner`
    INSERT INTO app.app_user (tenant_id, id, email, full_name, display_name, role) VALUES
      (${TENANT}, ${ADA}, 'ada@role.test', 'Ada Admin', 'Ada A.', 'admin'),
      (${TENANT}, ${BEN}, 'ben@role.test', 'Ben Admin', 'Ben A.', 'admin'),
      (${TENANT}, ${SAM}, 'sam@role.test', 'Sam Seller', 'Sam S.', 'seller'),
      (${OTHER_TENANT}, ${OUTSIDER}, 'out@role.test', 'Otto Out', 'Otto O.', 'admin')`
})

afterAll(async () => {
  await owner?.end()
  await app?.end()
})

describe('an admin can change a role', () => {
  it('promotes a seller and records what it was before', async () => {
    expect(await setRole(ADA, SAM, 'supervisor')).toBe(true)
    expect(await roleOf(SAM)).toBe('supervisor')

    const [row] = await owner<
      { action: string; actor: string; before: { role: string }; after: { role: string } }[]
    >`
      SELECT action, actor_user_id AS actor, before, after FROM app.audit_log
       WHERE tenant_id = ${TENANT} AND subject_id = ${SAM} AND action = 'user.role_assigned'`

    expect(row?.action).toBe('user.role_assigned')
    expect(row?.actor).toBe(ADA)
    // 🔴 THE BEFORE VALUE IS THE HALF THAT MATTERS. "She is a supervisor" is a
    // fact anybody can read today; "she was made one on Tuesday, by him, for
    // this reason" is the one nobody can reconstruct afterwards.
    expect(row?.before.role).toBe('seller')
    expect(row?.after.role).toBe('supervisor')

    // Put it back so later cases start from a known role.
    expect(await setRole(ADA, SAM, 'seller', 'Cover period ended, back to selling.')).toBe(true)
  })

  it('is idempotent and records nothing for a no-op', async () => {
    // An audit row for a change that did not happen is a row somebody has to
    // explain later.
    const before = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.audit_log WHERE tenant_id = ${TENANT} AND subject_id = ${SAM}`
    expect(await setRole(ADA, SAM, 'seller')).toBe(false)
    const after = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.audit_log WHERE tenant_id = ${TENANT} AND subject_id = ${SAM}`
    expect(after[0]?.n).toBe(before[0]?.n)
  })
})

describe('the tenant cannot be locked out', () => {
  it('refuses to demote the LAST admin', async () => {
    // Ben goes first and is allowed: two admins, one left.
    expect(await setRole(ADA, BEN, 'seller', 'Moving Ben back to a selling seat.')).toBe(true)

    // Now Ada is the only one. Ben — no longer an admin — cannot even ask.
    await expect(setRole(BEN, ADA, 'seller')).rejects.toThrow(/UR002/)

    // And Ada cannot do it herself, by either door.
    await expect(setRole(ADA, ADA, 'seller')).rejects.toThrow(/UR004/)
    await expect(setActive(ADA, ADA, false)).rejects.toThrow(/UR009/)

    expect(await roleOf(ADA)).toBe('admin')

    // Restore Ben so the last-admin path can be exercised from the other door.
    expect(await setRole(ADA, BEN, 'admin', 'Ben returns to covering admin duties.')).toBe(true)
  })

  it('closes the same hole on the deactivation door', async () => {
    // `scope_is_admin()` requires `deactivated_at IS NULL`, so deactivating the
    // last admin locks the tenant out exactly as demoting them does.
    expect(await setRole(ADA, BEN, 'seller', 'Ben moves to a selling seat again.')).toBe(true)

    // Ben, no longer an admin, cannot reach the function at all.
    await expect(setActive(BEN, ADA, false)).rejects.toThrow(/UR007/)
    // And Ada cannot remove herself.
    await expect(setActive(ADA, ADA, false)).rejects.toThrow(/UR009/)

    expect(await setRole(ADA, BEN, 'admin', 'Ben returns to admin duties.')).toBe(true)
  })

  it('leaves the last-admin counters UNREACHABLE, and that is worth writing down', async () => {
    // 🔴 A FINDING ABOUT THIS MIGRATION, FOUND BY THIS TEST. `UR005` and `UR010`
    // count the OTHER live admins and refuse at zero. They can never fire:
    // reaching either requires the caller to be an admin, and an admin who is
    // not the target IS another live admin, so the count is at least one; an
    // admin who IS the target is stopped earlier by UR004 / UR009.
    //
    // They are kept rather than deleted, because the invariant they state — a
    // tenant always has one reachable admin — is the real one, and they become
    // load-bearing the moment somebody relaxes a self-guard. But the protection
    // that ACTUALLY holds today is UR004 and UR009, and saying otherwise would
    // be claiming a mechanism the engine never executes.
    //
    // What this asserts is the reachable shape: with two admins, removing one
    // is allowed, and the remaining one still cannot remove themselves.
    expect(await setActive(ADA, BEN, false, 'Ben is on leave for two months.')).toBe(true)
    await expect(setActive(ADA, ADA, false)).rejects.toThrow(/UR009/)
    await expect(setRole(ADA, ADA, 'seller')).rejects.toThrow(/UR004/)

    // Reactivation works and is recorded.
    expect(await setActive(ADA, BEN, true, 'Ben is back from leave.')).toBe(true)
    const [row] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM app.audit_log
       WHERE tenant_id = ${TENANT} AND subject_id = ${BEN} AND action = 'user.access_revoked'`
    expect(row?.n).toBe('1')
  })
})

describe('what it refuses', () => {
  it('refuses a seller', async () => {
    await expect(setRole(SAM, SAM, 'admin')).rejects.toThrow(/UR002/)
    await expect(setActive(SAM, SAM, false)).rejects.toThrow(/UR007/)
  })

  it('refuses a change with no reason worth reading', async () => {
    await expect(setRole(ADA, SAM, 'supervisor', 'oops')).rejects.toThrow(/UR003/)
    await expect(setActive(ADA, SAM, false, '   ')).rejects.toThrow(/UR008/)
  })

  it('gives a neighbouring tenant’s user the not-found answer', async () => {
    // Same answer as an id that never existed — never an error that confirms
    // the user is real in another agency.
    expect(await setRole(ADA, OUTSIDER, 'seller')).toBe(false)
    expect(await setRole(ADA, randomUUID(), 'seller')).toBe(false)

    const [row] = await owner<{ role: string }[]>`
      SELECT role::text AS role FROM app.app_user
       WHERE tenant_id = ${OTHER_TENANT} AND id = ${OUTSIDER}`
    expect(row?.role).toBe('admin')
  })

  it('refuses everything outside a tenant session', async () => {
    await expect(
      app`SELECT app.app_user_set_role(${SAM}::uuid, 'admin'::app.user_role, 'no session at all')`,
    ).rejects.toThrow(/UR001/)
  })
})
