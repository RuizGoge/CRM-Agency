import postgres from 'postgres'

/**
 * PO001 at deploy — `05c` §11.11.4's first enforcement point.
 *
 * 🔴 THIS IS THE PRIMARY, AND THE EVENT-TRIGGER GUARD IS THE BELT-AND-BRACES.
 * `05c` §11.11.3 is titled "Platform reality, and it is why this cannot be the
 * primary": `CREATE EVENT TRIGGER` needs superuser, which a managed provider
 * may never grant (R2, still unmeasured). This check needs no superuser at all.
 * It runs as the deploy, over the same connection that just applied the
 * migrations, and it stops the deploy rather than the request.
 *
 * What it compares is a SURFACE COMPUTED BY CLASS — every RLS policy, every
 * `t_immutable_*` trigger, every SECURITY DEFINER body, and the RLS flags —
 * against what the last authorised deploy recorded. Additions are free.
 * A removal or a changed definition costs an `authz.ddl_authorization` row the
 * deploy role cannot create.
 *
 * ⚠️ IT RUNS AFTER `drizzle-kit migrate`, SO THE MIGRATION HAS ALREADY
 * COMMITTED. That is weaker than the event trigger, which refuses in the same
 * transaction, and it is the honest shape of the no-superuser case: §11.11.5
 * names all three enforcement points and this is (ii) — "stopping the next
 * deploy at PO001". The deploy fails, the previous image keeps serving, and
 * `security.harden()` regenerates anything the migration removed.
 */

const url = process.env['MIGRATION_DATABASE_URL']
if (url === undefined || url === '') {
  console.error('PO010: MIGRATION_DATABASE_URL is required — this checks the DEPLOY connection.')
  process.exit(1)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })

try {
  const [change] = await sql<{ added: number; changed: number; removed: number }[]>`
    SELECT * FROM security.assert_protected_objects()`

  if (change === undefined) {
    console.error('PO011: the protected-object check returned no row.')
    process.exit(1)
  }

  const [digest] = await sql<{ record_protected_digest: string }[]>`
    SELECT security.record_protected_digest()`

  const moved = change.changed + change.removed
  const mark = moved > 0 ? '⚠️ ' : '🔒'
  console.log(
    `${mark} Protected surface: ${String(change.added)} added, ` +
      `${String(change.changed)} changed, ${String(change.removed)} removed — ` +
      `digest ${(digest?.record_protected_digest ?? '').slice(0, 12)}…`,
  )

  // 🔴 SAID OUT LOUD RATHER THAN COUNTED SILENTLY. A weakening that got through
  // because an authorisation existed is exactly the event this whole mechanism
  // is built to make visible, and a deploy log that reports it in the same tone
  // as "0 changed" teaches nobody to look.
  if (moved > 0) {
    console.log(
      `   An authorisation was SPENT to allow this. ${String(change.removed)} protected ` +
        `object(s) are gone and ${String(change.changed)} changed definition.\n` +
        '   security.protected_object_history has the list, and it is append-only.',
    )
  }
} finally {
  await sql.end()
}
