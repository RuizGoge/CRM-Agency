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

/**
 * Throws when the definer owner is not the role the policies name.
 *
 * 🔴 THE PREMISE EVERY SECURITY DEFINER IN THIS TREE RESTS ON. Before migration
 * 0062 it was: `crm_migrator` was NOLOGIN and owned nothing, migrations ran as a
 * SUPERUSER, and all ~41 definer bodies executed as a role matching NEITHER
 * `p_app` (TO crm_app) NOR `p_sys` (TO crm_migrator) on tables with FORCE ROW
 * LEVEL SECURITY. They worked only because the owner bypassed RLS, and the 66
 * `p_sys` policies had never executed once.
 *
 * That was invisible in development, where the owner IS a superuser, and fatal
 * on a managed provider whose owner role is not — `app.stage_move` would raise
 * `new row violates row-level security policy` at the FIRST CLOSE, after a
 * green deploy, inside the money path.
 *
 * WHAT THIS CHECKS, and it is deliberately narrow:
 *   - every managed relation with RLS is owned by `crm_migrator`, so a table
 *     added by a migration that skipped `harden()` refuses the boot by name
 *     rather than failing at runtime inside a definer;
 *   - `crm_app` is not a member of `crm_migrator`. That grant is INERT today
 *     and was inert before 0062; afterwards it is one `SET ROLE` from every row
 *     in every tenant. `crm_app` is NOINHERIT, so the leak is not automatic —
 *     which is worse rather than better, because `pg_has_role(…, 'USAGE')`
 *     stays false while `'MEMBER'` is true. Both questions are asked.
 *
 * ⚠️ IT DOES NOT CHECK THAT THE OWNER IS BOUNDED. `p_sys` is `USING (true)`,
 * so `crm_migrator` reads every row in every tenant. What 0062 bought is
 * determinism and a non-superuser definer, not scoping — do not read this
 * assertion as more than that.
 *
 * 📌 The rest of that sentence used to read "and as `crm_migrator` you can drop
 * it, disable FORCE, or grant `crm_app` anything." Two of those three stopped
 * being true on 2026-08-14: `assertDdlGuardIsArmed` below covers the E1b guard,
 * which makes dropping a policy and switching off FORCE cost an authorisation
 * the deploy role cannot create. Granting `crm_app` privileges is still ungated.
 */
export async function assertDefinerOwnerIsPolicyBound(sql: postgres.Sql): Promise<void> {
  const rows = await sql<{ foreign_rls: number; app_is_member: boolean }[]>`
    SELECT (SELECT count(*)::int
              FROM pg_class c
             WHERE c.relkind IN ('r', 'p')
               AND c.relrowsecurity
               AND pg_get_userbyid(c.relowner) <> 'crm_migrator') AS foreign_rls,
           pg_has_role('crm_app', 'crm_migrator', 'MEMBER') AS app_is_member`

  const row = rows[0]
  if (row === undefined) {
    throw new Error('BOOT007: refusing to start. The definer-owner check returned nothing.')
  }

  if (row.app_is_member) {
    throw new Error(
      'BOOT007: refusing to start. crm_app is a member of crm_migrator.\n\n' +
        'One SET ROLE reaches every p_sys policy, and p_sys is USING (true) on every ' +
        'managed relation — so the application role would be one statement away from ' +
        'every row in every tenant. crm_app is NOINHERIT, so nothing would look wrong ' +
        'until somebody used it.\n\nREVOKE crm_migrator FROM crm_app.',
    )
  }

  if (row.foreign_rls > 0) {
    throw new Error(
      `BOOT008: refusing to start. ${row.foreign_rls} relation(s) with row level ` +
        'security are not owned by crm_migrator.\n\n' +
        'Every SECURITY DEFINER in this tree runs as that role, and p_sys is the only ' +
        'policy that admits it. A relation owned by anyone else is one a definer cannot ' +
        'write — which surfaces as a failed close inside the money path, not here.\n\n' +
        'Migration 0062 handed ownership over and security.managed_relations() re-takes ' +
        'it on every harden(). Something created a relation outside that path.',
    )
  }
}

/**
 * Throws when the application role can write the public money board.
 *
 * 🔴 WHAT 0063 FOUND. `crm_app` held EXECUTE on `app.ledger_append`, a SECURITY
 * DEFINER whose body validates TENANCY AND NOTHING ELSE — no ownership check on
 * `p_owner_user_id`, no bound on `p_delta_cents`, and `p_source_event_id` has no
 * foreign key to anything. Reproduced as an ordinary seller session: one call
 * appended 99,999,999,999.99 TO ANOTHER SELLER'S NAME, citing an event that
 * does not exist and a deal that does not exist. A direct INSERT in the same
 * session was refused. The table door held; the function door was open.
 *
 * The ledger is append-only with NO recompute job by design, so a forged row
 * has no remediation path. That is why this is prevention rather than
 * detection.
 *
 * THREE QUESTIONS, AND THE THIRD IS THE ONE THAT IS EASY TO MISS:
 *   - is the function still ungranted;
 *   - is there still exactly ONE overload (a later
 *     `ledger_append(…, p_note text DEFAULT NULL)` granted to `crm_app` leaves
 *     a signature-pinned check perfectly green);
 *   - are both money CHECKs still present AND VALIDATED. `ADD CONSTRAINT …
 *     NOT VALID` still enforces on new rows, so only `convalidated` catches a
 *     constraint that was re-added without scanning what is already there.
 */
export async function assertLedgerAppendIsDefinerOnly(sql: postgres.Sql): Promise<void> {
  const rows = await sql<
    { overloads: number; granted: boolean | null; bounds: number; validated: number }[]
  >`
    SELECT (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'app' AND p.proname = 'ledger_append') AS overloads,
           (SELECT bool_or(has_function_privilege('crm_app', p.oid, 'EXECUTE'))
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'app' AND p.proname = 'ledger_append') AS granted,
           (SELECT count(*)::int FROM pg_constraint
             WHERE conname IN ('earnings_delta_in_range',
                               'leaderboard_total_within_ledger_reach')) AS bounds,
           (SELECT count(*)::int FROM pg_constraint
             WHERE conname IN ('earnings_delta_in_range',
                               'leaderboard_total_within_ledger_reach')
               AND convalidated) AS validated`

  const row = rows[0]
  if (row === undefined || row.overloads === 0) {
    throw new Error(
      'BOOT009: refusing to start. app.ledger_append does not exist.\n\n' +
        'It is the only write path to earnings_ledger and to the public leaderboard. ' +
        'Run the migrations.',
    )
  }

  if (row.overloads > 1) {
    throw new Error(
      `BOOT010: refusing to start. app.ledger_append has ${row.overloads} overloads.\n\n` +
        'A second signature is a second door, and a privilege check pinned to the first ' +
        'one stays green while the new one is granted to crm_app. If the overload is ' +
        'deliberate, this assertion has to be widened on purpose.',
    )
  }

  if (row.granted === true) {
    throw new Error(
      'BOOT011: refusing to start. crm_app can execute app.ledger_append directly.\n\n' +
        'Its body checks tenancy and nothing else: one statement writes arbitrary money ' +
        "to any seller's name on the public Earnings board, sourced from an event that " +
        'need not exist. The ledger is append-only with no recompute job, so there is no ' +
        'way back.\n\nMigration 0063 revoked it; something granted it back, or a ' +
        'DROP/CREATE reset the ACL to EXECUTE TO PUBLIC.',
    )
  }

  if (row.bounds < 2 || row.validated < 2) {
    throw new Error(
      `BOOT012: refusing to start. ${row.bounds}/2 money bounds present, ` +
        `${row.validated}/2 validated.\n\n` +
        'earnings_delta_in_range caps one ledger entry; ' +
        'leaderboard_total_within_ledger_reach ties the public number to arithmetic the ' +
        'ledger could actually have produced. They bind the owner and the provider SQL ' +
        'console, which a revoked grant cannot reach.\n\n' +
        'A constraint re-added NOT VALID still enforces on new rows, which is why this ' +
        'reads convalidated rather than existence.',
    )
  }
}

/**
 * Throws when the application role can write a seller's Activity region.
 *
 * 🔴 WHAT 0064 CLOSED, AND WHY IT IS THE MOST IMPORTANT OF THE FOUR. The
 * timeline is the one surface in this list the constitution calls a symptom on
 * a seller's screen. `app.timeline_upsert` was granted to `crm_app` and took
 * the contact, the owner, the ACTOR, the instant, the kind, the ref, the
 * payload and the provenance as caller parameters, with no ownership predicate
 * anywhere in its body. So a route could write onto a colleague's history with
 * `actor_user_id` set to that colleague — and `app.timeline_read` renders
 * `timeline.actor.you` for exactly that, so her own history said "You" about
 * something she never did.
 *
 * The replacement takes an EVENT ID and reads every other field off
 * `app.event_log`. There is nothing left to forge, which is why it needs no
 * ownership predicate — and it could not have had one: the only caller is the
 * relay under `withSystemWork`, where `current_user_id()` is NULL, so a
 * predicate would have refused every production projection while passing every
 * test in the tree.
 *
 * THREE QUESTIONS. The third is the one a signature-pinned check misses:
 * `CREATE OR REPLACE app.timeline_project(p_event_id uuid, p_owner_override
 * uuid DEFAULT NULL)` leaves the one-argument form resolvable, so the boot
 * comes up clean over a door that has grown a way to lie to it.
 */
export async function assertTimelineWriterIsDefinerOnly(sql: postgres.Sql): Promise<void> {
  const rows = await sql<
    { upsert_granted: boolean | null; door_granted: boolean | null; door_args: number | null }[]
  >`
    SELECT (SELECT bool_or(has_function_privilege('crm_app', p.oid, 'EXECUTE'))
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'app' AND p.proname = 'timeline_upsert') AS upsert_granted,
           (SELECT bool_or(has_function_privilege('crm_app', p.oid, 'EXECUTE'))
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'app' AND p.proname = 'timeline_project') AS door_granted,
           (SELECT max(p.pronargs)::int
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'app' AND p.proname = 'timeline_project') AS door_args`

  const row = rows[0]
  if (row === undefined || row.door_granted !== true) {
    throw new Error(
      'BOOT013: refusing to start. app.timeline_project is missing or unreachable by ' +
        'crm_app.\n\nIt is the only way an event becomes a line in a seller history. ' +
        'Without it the Activity region silently stops growing — no error, no empty ' +
        'state, just a history that stops. Run the migrations.',
    )
  }

  if (row.upsert_granted === true) {
    throw new Error(
      'BOOT014: refusing to start. crm_app can execute app.timeline_upsert directly.\n\n' +
        "That is a path for any route to write onto a colleague's Activity region with a " +
        'caller-named owner, a caller-named actor and invented provenance — and the read ' +
        'renders a caller-named actor as "You", so the forgery appears in the victim\'s ' +
        'own history as her own action.\n\nMigration 0064 revoked it; something granted ' +
        'it back, or a DROP/CREATE reset the ACL to EXECUTE TO PUBLIC.',
    )
  }

  if (row.door_args !== 1) {
    throw new Error(
      `BOOT015: refusing to start. app.timeline_project takes ${String(row.door_args)} ` +
        'arguments, not 1.\n\n' +
        'The door is safe because it takes an event id and nothing else — every other ' +
        'field is read off the event row. A second parameter, even an optional one, is a ' +
        'field a caller can supply again, and it leaves the one-argument signature ' +
        'resolvable so a privilege check notices nothing.',
    )
  }
}

/**
 * E1b's guard, re-asserted at every boot — property (c) over property (b).
 *
 * 🔴 THIS IS THE ONE THAT GUARDS A THING NO MIGRATION CAN RESTORE. The guard is
 * installed OUT OF BAND by the owner, because `CREATE EVENT TRIGGER` needs
 * superuser and the deploy no longer is one. That is what makes it (b) — and it
 * is also what makes it forgettable: nothing in `npm run db:migrate`, in
 * `verify`, or in any diff will notice a database that was migrated and never
 * armed. A restored-from-backup database, a new region, a provider migration:
 * every one of those arrives unarmed and works perfectly.
 *
 * What it costs to miss is the whole point of the exercise. Unarmed, one
 * statement from the deploy role removes seller isolation:
 *
 *     DROP POLICY p_app ON app.contact;
 *
 * and every screen keeps rendering, with every seller's leads.
 *
 * ⚠️ IT IS UNCONDITIONAL, INCLUDING IN DEVELOPMENT, AND THAT IS A DECISION
 * (2026-08-14). A gate that only arms in production is a gate whose first firing
 * is a production incident. The cost is that a fresh clone must run
 * `npm run db:guard` once after migrating; the refusal below says so by name.
 */
export async function assertDdlGuardIsArmed(
  // A transaction is accepted as well as the pool, and only for the test that
  // exercises the REFUSING arm: event trigger DDL is transactional, so the guard
  // can be disabled and rolled back rather than left off for whatever runs next.
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<void> {
  const rows = await sql<{ armed: number; disabled: number; registry: number }[]>`
    SELECT (SELECT count(*)::int FROM pg_event_trigger
             WHERE evtname IN ('authz_guard_policy', 'authz_guard_alter', 'authz_guard_drop')
               AND evtenabled <> 'D') AS armed,
           (SELECT count(*)::int FROM pg_event_trigger
             WHERE evtname IN ('authz_guard_policy', 'authz_guard_alter', 'authz_guard_drop')
               AND evtenabled = 'D') AS disabled,
           (SELECT count(*)::int FROM pg_trigger
             WHERE tgname = 't_authz_guard_registry' AND NOT tgisinternal
               AND tgenabled <> 'D') AS registry`

  const row = rows[0]
  if (row === undefined) {
    throw new Error('BOOT016: refusing to start. The E1b guard check returned nothing.')
  }

  // Disabled is reported apart from absent on purpose. Absent is "nobody ran
  // db:guard"; disabled is "somebody with superuser turned it off", and those
  // are different conversations.
  if (row.disabled > 0) {
    throw new Error(
      `BOOT016: refusing to start. ${String(row.disabled)} of the E1b event triggers ` +
        'are DISABLED.\n\n' +
        'ALTER EVENT TRIGGER ... DISABLE needs superuser, so this was not the deploy. ' +
        'Somebody turned off the thing that stops a policy being dropped. Re-enable it ' +
        'or re-run `npm run db:guard`.',
    )
  }

  if (row.armed < 3 || row.registry < 1) {
    throw new Error(
      `BOOT016: refusing to start. The E1b DDL guard is not armed ` +
        `(${String(row.armed)}/3 event triggers, ${String(row.registry)}/1 registry trigger).\n\n` +
        'Without it the deploy role can DROP a policy, switch off FORCE row level ' +
        'security, or drop a registered table in one statement — and every screen ' +
        'keeps working while it does. This database was migrated but never armed.\n\n' +
        'Run it once, as the OWNER and not as the deploy credential:\n\n' +
        '  npm run db:guard\n',
    )
  }
}
