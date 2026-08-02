import type postgres from 'postgres'

/**
 * Sprint-0 gate G4(a): the application refuses to boot when its connection
 * user can bypass row level security.
 *
 * The failure this prevents has no symptom. A superuser, a role with
 * BYPASSRLS, or the owner of the schema reads straight through every policy —
 * FORCE included — so every page renders perfectly, with every seller's rows,
 * and nothing logs anything. There is no screen that goes wrong and no query
 * that errors. The only way to notice is to already know.
 *
 * So the check is a refusal to start. That IS the symptom: a deploy that will
 * not come up is loud, immediate, and impossible to mistake for working.
 *
 * The gate specifically calls for pointing the app at "the superuser string
 * docker compose hands out by default", because the development environment
 * trains the broken configuration with perfect fidelity — which is exactly how
 * this project shipped for eight items before the canary fixture caught it.
 */

export interface ConnectionPosture {
  readonly user: string
  readonly isSuperuser: boolean
  readonly bypassesRls: boolean
  readonly ownsManagedSchema: boolean
}

export async function readConnectionPosture(sql: postgres.Sql): Promise<ConnectionPosture> {
  const rows = await sql<
    {
      user_name: string
      is_superuser: boolean
      bypasses_rls: boolean
      owns_managed_schema: boolean
    }[]
  >`
    SELECT current_user::text AS user_name,
           r.rolsuper       AS is_superuser,
           r.rolbypassrls   AS bypasses_rls,
           EXISTS (
             SELECT 1 FROM pg_namespace n
             WHERE n.nspname IN ('app', 'ref')
               AND pg_get_userbyid(n.nspowner) = current_user
           )                AS owns_managed_schema
    FROM pg_roles r
    WHERE r.rolname = current_user`

  const row = rows[0]
  if (!row) {
    throw new Error('BOOT001: could not read the connection role')
  }

  return {
    user: row.user_name,
    isSuperuser: row.is_superuser,
    bypassesRls: row.bypasses_rls,
    ownsManagedSchema: row.owns_managed_schema,
  }
}

/** The reasons this posture is unsafe, or an empty list. */
export function unsafeReasons(posture: ConnectionPosture): readonly string[] {
  const reasons: string[] = []
  if (posture.isSuperuser) reasons.push('it is a superuser')
  if (posture.bypassesRls) reasons.push('it has BYPASSRLS')
  if (posture.ownsManagedSchema) reasons.push('it owns the app or ref schema')
  return reasons
}

/**
 * Throws when the connection can see past the silo. Callers decide whether to
 * exit the process or fail a test; the check itself makes no such decision, so
 * the same function serves both.
 */
export async function assertSafeConnection(sql: postgres.Sql): Promise<void> {
  const posture = await readConnectionPosture(sql)
  const reasons = unsafeReasons(posture)
  if (reasons.length === 0) return

  throw new Error(
    `BOOT002: refusing to start. The database user "${posture.user}" bypasses row level ` +
      `security because ${reasons.join(', and ')}.\n\n` +
      `Every seller would see every seller's book, with no error and no log line. ` +
      `Point DATABASE_URL at the crm_app role — the owner credential belongs to ` +
      `migrations only.`,
  )
}
