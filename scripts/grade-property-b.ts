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

  // 🔴 RECORDED, NOT ONLY PRINTED. A number nobody stores is one the suite
  // cannot pin, and an unpinned grade drifts exactly the way the claim it
  // replaced did. `ref.system_constant` is where this tree already keeps facts
  // about the environment it is running in.
  await sql`
    INSERT INTO ref.system_constant (key, value, reason)
    VALUES ('property_b_grade', ${row.grade},
            ${`Observed at deploy from MIGRATION_DATABASE_URL, whose role is ${row.role}. ${row.reason} NOTE: this grades E1b's PLACEMENT only. Nothing yet requires a protected change to consume an authorisation, so this role can still DROP a policy — measured 2026-08-14.`})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, reason = EXCLUDED.reason`

  // 🔴 THE WORDING IS NARROW ON PURPOSE. The first version printed
  // "✅ property (b)" and that overclaimed: what this measures is E1b's
  // PLACEMENT — the deploy can consume an authorisation it cannot create. It
  // does NOT mean protected objects are protected, because the requirement that
  // changing one CONSUME an authorisation is not built. Measured the same day:
  // `SET ROLE crm_migrator; DROP POLICY p_app ON app.contact;` still succeeds,
  // so seller isolation is removable by the deploy role today.
  const mark = row.holds ? '✅' : '⚠️ '
  console.log(
    `${mark} E1b placement: ${row.grade} — deploy runs as ${row.role}` +
      (row.holds ? ' and cannot authorise itself' : ''),
  )
  if (row.holds) {
    console.log(
      '   This is the PREREQUISITE, not the protection: nothing yet requires a ' +
        'protected change to consume an authorisation, so a migration can still ' +
        'drop a policy. See docs/sprint-0/deploy-credential-isolation.md.',
    )
  } else {
    console.log(`   ${row.reason}`)
  }
} finally {
  await sql.end()
}
