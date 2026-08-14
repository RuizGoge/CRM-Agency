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
    //
    // ⚠️ ROLLED BACK RATHER THAN DELETED, AND THAT CHANGED ON 2026-08-14. The
    // guard made this table append-only — `AUTHZ003: an authorisation is a
    // record of who allowed what` — for the same reason `earnings_ledger` and
    // `audit_log` are: a spend that can be erased is a spend nobody can audit.
    // The DELETE this test used to end with now raises.
    let createdBy: string | undefined
    await sql
      .begin(async (tx) => {
        const [row] = await tx<{ created_by: string }[]>`
          INSERT INTO authz.ddl_authorization (purpose)
          VALUES ('Authorising the property-b test to insert one row and roll it back')
          RETURNING created_by`
        createdBy = row?.created_by
        throw new Error('rollback')
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== 'rollback') throw err
      })
    expect(createdBy).toBe('crm')
  })
})

describe('the grade is measured, and it discriminates', () => {
  it('🔴 PINS WHAT THE DEPLOY OBSERVED, not a role name typed here', async () => {
    // 🔴 THE FIRST VERSION PINNED `grade('crm')` AND STOPPED MEANING ANYTHING
    // THE MOMENT IT MATTERED. When Jorge pointed MIGRATION_DATABASE_URL at
    // crm_migrator, the deploy role changed and this stayed GREEN: `crm` is
    // still a superuser, it simply no longer deploys. The pin was true and had
    // become a statement about nothing.
    //
    // The function knows role privileges; it cannot know which role the deploy
    // connects as. So `scripts/grade-property-b.ts` runs over
    // MIGRATION_DATABASE_URL, grades `current_user` — the deploy role BY
    // CONSTRUCTION — and records it. This pins the RECORDING.
    const [row] = await sql<{ value: string; reason: string }[]>`
      SELECT value, reason FROM ref.system_constant WHERE key = 'property_b_grade'`

    expect(row, 'no deploy ever recorded a grade').toBeDefined()

    // ⚠️ `(a)+(c)` HERE IS THE HONEST ANSWER, NOT A STALE ONE. The grade belongs
    // to whoever deployed, and this database was built by global-setup over
    // OWNER_URL, which is `crm` — a superuser. The DEVELOPMENT database records
    // `(b)`, because `npm run db:migrate` runs over MIGRATION_DATABASE_URL,
    // which Jorge pointed at crm_migrator on 2026-08-14. Two environments, two
    // true answers, and neither is hardcoded: each records what it observed.
    // Point the harness at an isolated role and this goes red.
    expect(row?.value).toBe('(a)+(c)')

    // ⚠️ AND THE RECORDING SAYS WHICH HALF IS MISSING. Until 2026-08-14 this
    // read "PLACEMENT only", because nothing required a protected change to
    // consume an authorisation and `DROP POLICY p_app ON app.contact` from the
    // deploy role simply worked. The guard closed that half; what keeps THIS
    // database degraded is now the role alone — global-setup deploys as `crm`,
    // a superuser — and the reason has to say which, or the next reader learns
    // the wrong thing from a true grade.
    expect(row?.reason).toContain('guard IS armed')
    expect(row?.reason).toContain('SUPERUSER')
  })

  it('still grades a superuser deploy as degraded, which is the discrimination', async () => {
    // `crm` is what this used to deploy as. It remains a superuser, so asking
    // about it still answers degraded — which is what keeps the function honest
    // rather than stuck on yes now that the real answer flipped.
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
