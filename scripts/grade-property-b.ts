/**
 * Records which grade property (b) actually holds, from the deploy's own
 * connection.
 *
 * 🔴 WHY THIS EXISTS, AND IT IS A CORRECTION TO 0075. That migration's
 * `security.property_b_grade()` takes the deploy role as a PARAMETER defaulting
 * to `'crm'`. The function knows role privileges; it cannot know which role
 * `MIGRATION_DATABASE_URL` points at. So the default was an unverified claim
 * about deploy configuration — the exact species of claim the whole exercise
 * exists to eliminate, reintroduced by the object built to eliminate it.
 *
 * It showed the moment Jorge switched the credential: the grade for the role
 * that now deploys read `(b)`, and `property-b.test.ts` stayed GREEN because it
 * pinned the grade for `crm`, which is still a superuser and simply no longer
 * deploys. The pin was true and had stopped being about anything.
 *
 * 🎯 THE FIX IS TO STOP ASKING AND START OBSERVING. This runs as part of the
 * deploy, over `MIGRATION_DATABASE_URL`, and grades `current_user` — which is
 * the deploy role BY CONSTRUCTION rather than by assertion. There is no
 * parameter to get wrong. It writes the result to `ref.system_constant` so the
 * suite can pin the OBSERVED grade rather than a hardcoded role name.
 */

import postgres from 'postgres'

const url = process.env['MIGRATION_DATABASE_URL']
if (url === undefined || url === '') {
  console.error('PROPB001: MIGRATION_DATABASE_URL is required — this grades the DEPLOY connection.')
  process.exit(1)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })

try {
  const [row] = await sql<{ role: string; holds: boolean; grade: string; reason: string }[]>`
    SELECT current_user AS role, g.holds, g.grade, g.reason
      FROM security.property_b_grade(current_user) g`

  if (row === undefined) {
    console.error('PROPB002: the grade returned no row.')
    process.exit(1)
  }

  // 🔴 THE SECOND HALF, AND UNTIL 2026-08-14 IT DID NOT EXIST. Placement — the
  // deploy can consume an authorisation and cannot create one — is a
  // PREREQUISITE. It says nothing about whether changing a protected object
  // actually costs an authorisation, and for a day it did not: the same deploy
  // role that could not forge a row could still run `DROP POLICY p_app ON
  // app.contact` for free. Grading placement alone is how a green reading comes
  // to mean less than its reader thinks.
  //
  // The guard is installed OUT OF BAND, so it can be absent on a database this
  // script migrated perfectly. That is exactly why it is measured here.
  const [guard] = await sql<{ armed: number; disabled: number; registry: number }[]>`
    SELECT (SELECT count(*)::int FROM pg_event_trigger
             WHERE evtname IN ('authz_guard_policy', 'authz_guard_alter', 'authz_guard_drop')
               AND evtenabled <> 'D') AS armed,
           (SELECT count(*)::int FROM pg_event_trigger
             WHERE evtname IN ('authz_guard_policy', 'authz_guard_alter', 'authz_guard_drop')
               AND evtenabled = 'D') AS disabled,
           (SELECT count(*)::int FROM pg_trigger
             WHERE tgname = 't_authz_guard_registry' AND NOT tgisinternal
               AND tgenabled <> 'D') AS registry`

  const armed = guard !== undefined && guard.armed === 3 && guard.registry === 1
  const holds = row.holds && armed

  // 🔴 RECORDED, NOT ONLY PRINTED. A number nobody stores is one the suite
  // cannot pin, and an unpinned grade drifts exactly the way the claim it
  // replaced did. `ref.system_constant` is where this tree already keeps facts
  // about the environment it is running in.
  const note = armed
    ? 'The E1b guard is ARMED: a protected change spends an authorisation this role cannot create.'
    : 'NOTE: the E1b guard is NOT ARMED, so this role can still DROP a policy in one statement. ' +
      'Placement without protection is a prerequisite, not the property. Run `npm run db:guard` as the owner.'

  await sql`
    INSERT INTO ref.system_constant (key, value, reason)
    VALUES ('property_b_grade', ${holds ? row.grade : '(a)+(c)'},
            ${`Observed at deploy from MIGRATION_DATABASE_URL, whose role is ${row.role}. ${row.reason} ${note}`})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, reason = EXCLUDED.reason`

  const mark = holds ? '🔒' : '⚠️ '
  console.log(
    `${mark} E1b: ${holds ? '(b)' : '(a)+(c)'} — deploy runs as ${row.role}; ` +
      `placement ${row.holds ? 'holds' : 'does not hold'}, guard ${armed ? 'armed' : 'NOT ARMED'}.`,
  )
  if (!row.holds) console.log(`   ${row.reason}`)
  if (!armed) {
    console.log(
      '   The guard is installed out of band and this database does not have it. ' +
        'Until it does, a protected change costs nothing:\n' +
        '     npm run db:guard        (as the OWNER, not the deploy credential)',
    )
  }
  if (guard !== undefined && guard.disabled > 0) {
    console.log(
      `   🔴 ${String(guard.disabled)} guard trigger(s) are DISABLED. That needs superuser, ` +
        'so it was not the deploy — somebody turned the protection off.',
    )
  }
} finally {
  await sql.end()
}
