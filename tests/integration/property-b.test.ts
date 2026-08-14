import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TEST_URL } from './setup/urls'

/**
 * PROPERTY (b), GRADED RATHER THAN CLAIMED.
 *
 * CLAUDE.md names three properties that survive "Claude writes a migration and
 * nobody reads the diff": (a) a symptom on screen, (b) a gate anchored outside
 * the working tree, (c) re-assertion at deploy and at boot. This tree has (a)
 * and (c) in many places and has never had (b) — while `05c` says twenty-plus
 * closures lean on it.
 *
 * 🔴 THE POINT OF THIS FILE IS THE PIN, NOT THE PASS. It asserts that (b) does
 * NOT hold today. That reads oddly until you notice which failure this project
 * keeps paying for: a claim in a document drifting away from the engine while
 * every test stays green. Eight stale rows were found in CONTEXT.md this week
 * alone, twice by a session planning work that had already been done.
 *
 * So the day somebody runs migrations as `crm_migrator` and (b) genuinely
 * starts holding, THIS TEST GOES RED and forces the claim to be updated. A
 * mechanism that keeps documentation honest is worth more here than one more
 * assertion about something already true.
 */

let sql: postgres.Sql

beforeAll(() => {
  sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await sql?.end()
})

const grade = async (role?: string) => {
  const [row] = await sql<{ holds: boolean; grade: string; reason: string }[]>`
    SELECT * FROM security.property_b_grade(${role ?? 'crm'})`
  return row
}

describe('E1b has a structure at last', () => {
  it('keeps the table OUT of the security schema, and that placement is the fix', async () => {
    // 🔴 THE FIRST VERSION PUT IT IN `security` AND COULD NOT WORK. 0062's
    // own_to_migrator() makes crm_migrator the owner of every object in the
    // managed schemas plus `security`, and an owner can always insert into its
    // own table — which is the one thing E1b needs this table to refuse the
    // deploy role. Two of this project's own mechanisms, incompatible in one
    // schema. Found by measurement: the grade read (b) when the file ran alone
    // and degraded in the full suite, because crm_test rebuilds from every
    // migration in order and own_to_migrator had taken the table back.
    const [row] = await sql<{ owner: string }[]>`
      SELECT tableowner AS owner FROM pg_tables
       WHERE schemaname = 'authz' AND tablename = 'ddl_authorization'`
    expect(row?.owner).toBe('crm')

    // And it survives the handover, which is the assertion that would have
    // caught the original mistake before the suite did.
    await sql`SELECT security.own_to_migrator()`
    const [after] = await sql<{ owner: string }[]>`
      SELECT tableowner AS owner FROM pg_tables
       WHERE schemaname = 'authz' AND tablename = 'ddl_authorization'`
    expect(after?.owner).toBe('crm')
  })

  it('has the authorisation table the erratum mandates', async () => {
    // E1b is normative rank 1 — "if this placement is not adopted, the boldface
    // claim is struck and §11.11 is graded (a)+(c) only" — and until 0075 there
    // was no `ddl_authorization` anywhere in the tree. Ungraded and unadopted
    // since Gate 5.
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM information_schema.tables
       WHERE table_schema = 'authz' AND table_name = 'ddl_authorization'`
    expect(row?.n).toBe('1')
  })

  it('refuses an authorisation that does not say what it authorises', async () => {
    // The purpose is read by a person deciding whether the deploy in front of
    // them is the one they authorised. "ok" is not that.
    await expect(sql`INSERT INTO authz.ddl_authorization (purpose) VALUES ('ok')`).rejects.toThrow(
      /ddl_authorization_purpose_present/,
    )
  })

  it('records who authorised it without being told', async () => {
    // `created_by` defaults from `current_user`: a caller that could name who
    // authorised it could name somebody who did not. Same rule as audit_write.
    const [row] = await sql<{ created_by: string }[]>`
      INSERT INTO authz.ddl_authorization (purpose)
      VALUES ('Authorising the property-b test to insert one row and roll it back')
      RETURNING created_by`
    expect(row?.created_by).toBe('crm')
    await sql`DELETE FROM authz.ddl_authorization WHERE purpose LIKE 'Authorising the property-b%'`
  })
})

describe('the grade is measured, and it discriminates', () => {
  it('🔴 PINS THE TRUTH: property (b) does NOT hold today', async () => {
    // If this goes red, (b) started holding and the claim in CLAUDE.md and
    // CONTEXT.md must be updated in the same change. That is the whole job of
    // this assertion. Do not "fix" it by loosening it.
    const g = await grade('crm')
    expect(g?.holds).toBe(false)
    expect(g?.grade).toBe('(a)+(c)')
    expect(g?.reason).toContain('SUPERUSER')
  })

  it('grades the isolated deploy role as (b), so the check is not stuck on no', async () => {
    // 🔴 THE POSITIVE CONTROL. A grading function that answered "degraded" for
    // everything would pin the truth above by accident and prove nothing.
    // `crm_migrator` is not a superuser, cannot INSERT an authorisation, and CAN
    // consume one — E1b's placement exactly. Running migrations under it is the
    // one configuration change that makes (b) real, and it is Jorge's.
    const g = await grade('crm_migrator')
    expect(g?.holds).toBe(true)
    expect(g?.grade).toBe('(b)')
  })

  it('refuses to grade a role that cannot deploy at all', async () => {
    // 🔴 A DEFECT IN THE FIRST VERSION, CAUGHT BY ASKING ABOUT EVERY ROLE RATHER
    // THAN THE DEFAULT ONE. `crm_app` cannot INSERT an authorisation, so it
    // passed the forgery check and graded (b) — a green for the wrong reason,
    // since it cannot read or spend one either and is not a deploy role. "Unable
    // to forge" and "able to deploy under an authorisation it cannot forge" are
    // different facts and only the second is the property.
    const g = await grade('crm_app')
    expect(g?.holds).toBe(false)
    expect(g?.grade).toBe('n/a')
  })

  it('says so rather than passing when the role does not exist', async () => {
    const g = await grade('a-role-nobody-created')
    expect(g?.holds).toBe(false)
  })
})
