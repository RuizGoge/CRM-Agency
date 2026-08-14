import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertDefinerOwnerIsPolicyBound } from '~/db/boot-assert'

import { TEST_URL } from './setup/urls'

/**
 * THE PREMISE EVERY SECURITY DEFINER RESTS ON, made true and then pinned.
 *
 * 🔴 WHAT 0062 FOUND. `crm_migrator` was NOLOGIN, owned nothing and had no
 * USAGE on schema `app`; migrations ran as `crm`, a SUPERUSER. So every definer
 * body executed as a role matching NEITHER `p_app` (TO crm_app) NOR `p_sys` (TO
 * crm_migrator) on tables with FORCE ROW LEVEL SECURITY — it worked only
 * because the owner bypassed RLS, and the 66 `p_sys` policies had never
 * executed once in the project's life.
 *
 * Invisible in development, where the owner IS a superuser. Fatal on a managed
 * provider whose owner is not: `app.stage_move` raises `new row violates row
 * level security policy` at the FIRST CLOSE, after a green deploy, inside the
 * money path.
 */

let sql: postgres.Sql

beforeAll(() => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await sql?.end()
})

describe('the definer owner is the role the policies name', () => {
  it('owns every managed schema, and cannot bypass row level security', async () => {
    // 🎯 THE ASSERTION 0062 EXISTS FOR. Mutation: delete the
    // `PERFORM security.own_to_migrator()` line from
    // `security.managed_relations()` and every relation a later migration adds
    // stays owned by the migration role — green everywhere until a definer
    // tries to write one.
    const [schemas] = await sql<{ foreign_schemas: number }[]>`
      SELECT count(*)::int AS foreign_schemas
        FROM pg_namespace n
       WHERE n.nspname IN ('app', 'ref', 'security')
         AND pg_get_userbyid(n.nspowner) <> 'crm_migrator'`
    expect(schemas?.foreign_schemas).toBe(0)

    // 🔴 AND THE OWNER MUST NOT BE ABLE TO BYPASS. If it could, the handover
    // would have bought nothing: the definers would still work for the reason
    // they worked before, and the p_sys policies would still be decoration.
    const [owner] = await sql<{ can_bypass: boolean }[]>`
      SELECT rolsuper OR rolbypassrls AS can_bypass
        FROM pg_roles WHERE rolname = 'crm_migrator'`
    expect(owner?.can_bypass).toBe(false)

    // ⚠️ THIS LINE USED TO READ `expect(owner?.can_login).toBe(false)` AND IT WAS
    // TRADED DELIBERATELY ON 2026-08-14, not relaxed to make a build pass. The
    // deploy moved off the superuser onto this role, which needs a credential to
    // connect at all — so NOLOGIN and property (b) could not both hold.
    //
    // A separate `crm_deploy` role would look stricter and buy nothing: creating
    // objects in schemas this role owns requires MEMBERSHIP in it, membership
    // grants `SET ROLE crm_migrator`, and the definer-owner authority is
    // therefore reachable from any credential that can deploy. The wall is not
    // "no credential exists" — it is WHICH credentials can reach the owner.
    //
    // 🎯 SO THE ASSERTION IS NOW A CENSUS. The role that matters most is already
    // covered four tests down — `crm_app` is checked for USAGE *and* MEMBER, and
    // that one is the real wall. What NOLOGIN was quietly also doing was capping
    // the population: no credential could reach the owner because none existed.
    // A census keeps that cap without forbidding the deploy its connection. Add
    // a fourth login role that can reach the owner and this goes red WITH ITS
    // NAME, which is more than the boolean ever said.
    const reach = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles
       WHERE rolcanlogin AND pg_has_role(rolname, 'crm_migrator', 'USAGE')
       ORDER BY 1`
    expect(reach.map((r) => r.rolname)).toEqual(['crm', 'crm_migrator'])
  })

  it('leaves no managed relation a definer cannot write', async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM pg_class c
       WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity
         AND pg_get_userbyid(c.relowner) <> 'crm_migrator'`
    expect(row?.n).toBe(0)
  })

  it('gives every RLS relation a well-formed p_sys that names the owner', async () => {
    // Mutation: `DROP POLICY p_sys ON app.event_log`. Before 0062 that changed
    // nothing at all — the policy had never been consulted. After it, the close
    // gate raises `new row violates row-level security policy for table
    // "event_log"`, which is the point of the whole migration.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM pg_class c
       WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity
         AND NOT EXISTS (
           SELECT 1 FROM pg_policy pol
            WHERE pol.polrelid = c.oid AND pol.polname = 'p_sys'
              AND pol.polpermissive AND pol.polcmd = '*'
              AND pol.polroles = ARRAY['crm_migrator'::regrole::oid]
              AND pg_get_expr(pol.polqual, c.oid) = 'true'
              AND pg_get_expr(pol.polwithcheck, c.oid) = 'true')`
    expect(row?.n).toBe(0)
  })

  it('never lets the application role become the owner', async () => {
    // 🔴 THE GRANT THAT WAS INERT AND NOW IS NOT. `GRANT crm_migrator TO
    // crm_app` did nothing before 0062 — the role owned nothing. Afterwards it
    // is one SET ROLE from every row in every tenant.
    //
    // `crm_app` is NOINHERIT, so the leak is not automatic, which is WORSE
    // rather than better: `pg_has_role(…, 'USAGE')` stays false while
    // `'MEMBER'` is true. Asking the wrong one of those two is the defect this
    // test exists to prevent.
    const [row] = await sql<{ usage: boolean; member: boolean }[]>`
      SELECT pg_has_role('crm_app', 'crm_migrator', 'USAGE')  AS usage,
             pg_has_role('crm_app', 'crm_migrator', 'MEMBER') AS member`
    expect(row?.member).toBe(false)
    expect(row?.usage).toBe(false)
  })

  it('refuses to boot when the application role is a member of the owner', async () => {
    // The re-assertion, exercised by granting and revoking from the owner
    // connection. ⚠️ The `finally` is load-bearing twice over: `GRANT <role> TO
    // <role>` writes to `pg_auth_members`, which is CLUSTER-GLOBAL and outlives
    // the test database, so a leak here would follow the developer's machine
    // into every future run of every suite.
    await expect(assertDefinerOwnerIsPolicyBound(sql)).resolves.toBeUndefined()

    await sql.unsafe('GRANT crm_migrator TO crm_app')
    try {
      await expect(assertDefinerOwnerIsPolicyBound(sql)).rejects.toThrow(/BOOT007/)
    } finally {
      await sql.unsafe('REVOKE crm_migrator FROM crm_app')
    }

    await expect(assertDefinerOwnerIsPolicyBound(sql)).resolves.toBeUndefined()
  })
})
