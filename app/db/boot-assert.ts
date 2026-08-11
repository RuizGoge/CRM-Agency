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

/**
 * Throws when the compliance gate can be asked without recording the answer.
 *
 * 🔴 RE-ASSERTION AT BOOT, and it is here because of what CLAUDE.md says about
 * the actor who writes migrations nobody reads. Migration 0060's whole
 * mechanism is one absence: `crm_app` has no EXECUTE on
 * `app.compliance_check`, so the only reachable door is
 * `app.compliance_attempt`, which has already written the audit row and emitted
 * `compliance.send_blocked` before it returns a verdict.
 *
 * A later migration containing one `GRANT EXECUTE` would undo that in a diff
 * nobody reads, and NOTHING WOULD LOOK WRONG: every dial still refuses
 * correctly, every seller sentence is unchanged, and the refusals simply stop
 * being counted. Of the three properties that survive that actor — a symptom on
 * screen, a gate anchored outside the tree, re-assertion at deploy and at boot
 * — this is the third. The deploy does not come up.
 *
 * It also refuses the opposite direction: a gate that is missing entirely means
 * the migration was never applied to this database.
 *
 * Not production-only, deliberately. `assertRequiredCapabilities` is, and its
 * own comment calls that its weakness — development and CI never exercise the
 * refusal. This one follows `assertSafeConnection` instead and runs everywhere.
 */
export async function assertGateIsRecording(sql: postgres.Sql): Promise<void> {
  const rows = await sql<{ present: boolean; granted: boolean | null }[]>`
    SELECT to_regprocedure('app.compliance_check(uuid,app.channel,timestamptz)') IS NOT NULL
             AS present,
           CASE WHEN to_regprocedure('app.compliance_check(uuid,app.channel,timestamptz)') IS NULL
                THEN NULL
                ELSE has_function_privilege(
                       'crm_app',
                       to_regprocedure('app.compliance_check(uuid,app.channel,timestamptz)'),
                       'EXECUTE') END AS granted`

  const row = rows[0]
  if (row === undefined || !row.present) {
    throw new Error(
      'BOOT003: refusing to start. app.compliance_check does not exist in this database.\n\n' +
        'Every dial, text and reminder passes through it. Run the migrations.',
    )
  }

  if (row.granted === true) {
    throw new Error(
      'BOOT004: refusing to start. crm_app can execute app.compliance_check directly.\n\n' +
        'That is a path to a compliance verdict that writes no audit row and emits no ' +
        'compliance.send_blocked — so refusals stop being counted while every screen ' +
        'still looks correct. Migration 0060 revoked it; something granted it back.\n\n' +
        'The only sanctioned doors are app.compliance_attempt and app.reminder_gate.',
    )
  }
}

/**
 * Throws when the application role can write the event store directly.
 *
 * 🔴 RE-ASSERTION AT BOOT, and this one needs it more than BOOT004 does.
 * Migration 0061's mechanism is one absence: `crm_app` has no EXECUTE on
 * `app.event_emit`, so the only paths into `app.event_log` are
 * `app.stage_move` and `app.compliance_record`, both SECURITY DEFINER, both
 * running as the function owner.
 *
 * WHAT MAKES IT INVISIBLE. Unlike the compliance gate, this revoke has NO
 * SYMPTOM ON ANY SCREEN — there was no production caller before it and there is
 * none after. A `GRANT EXECUTE` in a diff nobody reads restores the ability of
 * any route to write any of the 49 event names with a fabricated payload, and
 * every test, every board and every seller sentence is unchanged. There is
 * nothing to notice. So the deploy not coming up is the only symptom available.
 *
 * IT CATCHES BOTH REGRESSION SHAPES WITH ONE PREDICATE, which is why it asks
 * `has_function_privilege` rather than matching `proacl`:
 *   - a named `GRANT EXECUTE … TO crm_app`, copied back from 0043;
 *   - a `DROP FUNCTION` + `CREATE FUNCTION` to change the signature (the live
 *     pattern in 0060), which resets the ACL to EXECUTE TO PUBLIC — WIDER than
 *     before the revoke. `has_function_privilege` resolves PUBLIC membership,
 *     so the same check refuses it and `proacl` matching would not.
 *
 * `security.harden()` re-asserts table privileges on every deploy and touches
 * no function privilege at all, so nothing else re-establishes this.
 */
export async function assertEventEmitIsDefinerOnly(sql: postgres.Sql): Promise<void> {
  // ⚠️ A SECOND SOURCE OF TRUTH FOR THE PARAMETER LIST, on purpose. A future
  // migration that adds a thirteenth parameter makes `to_regprocedure` return
  // NULL and this throws BOOT005 rather than silently stopping asserting. A
  // boot check that quietly goes vacuous is worse than one that is loud about
  // being stale.
  const signature =
    'app.event_emit(uuid,uuid,app.event_name,text,uuid,text,jsonb,timestamptz,' +
    'app.source_system,uuid,app.retention_class,smallint)'

  const rows = await sql<{ present: boolean; granted: boolean | null }[]>`
    SELECT to_regprocedure(${signature}) IS NOT NULL AS present,
           CASE WHEN to_regprocedure(${signature}) IS NULL
                THEN NULL
                ELSE has_function_privilege('crm_app', to_regprocedure(${signature}), 'EXECUTE')
           END AS granted`

  const row = rows[0]
  if (row === undefined || !row.present) {
    throw new Error(
      'BOOT005: refusing to start. app.event_emit does not exist in this database ' +
        'with the signature the application was built against.\n\n' +
        'Every sale, every refusal and every timeline entry is written through it. ' +
        'Run the migrations — and if a migration changed its parameter list, this ' +
        'assertion is the thing that has to be updated on purpose.',
    )
  }

  if (row.granted === true) {
    throw new Error(
      'BOOT006: refusing to start. crm_app can execute app.event_emit directly.\n\n' +
        'That is a path for any route to write any of the 49 canonical events into ' +
        'app.event_log with a payload of its choosing — an append-only table with no ' +
        'recompute job. Nothing on any screen would look wrong.\n\n' +
        'Migration 0061 revoked it; something granted it back, or a DROP/CREATE reset ' +
        'the ACL to EXECUTE TO PUBLIC. The only writers are app.stage_move and ' +
        'app.compliance_record, both of which reach it as the function owner.',
    )
  }
}
