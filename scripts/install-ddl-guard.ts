import postgres from 'postgres'

import { handOverDeployBookkeeping, installDdlGuard, GUARD_EVENT_TRIGGERS } from './ddl-guard'

/**
 * Arms the E1b guard, as the OWNER, out of band.
 *
 *   npm run db:guard
 *
 * 🔴 THIS IS NOT PART OF THE DEPLOY, AND MUST NOT BECOME PART OF IT. The deploy
 * runs as `crm_migrator`; this needs superuser. If a deploy could arm the guard
 * it could also disarm it, and the property would be theatre. Run it by hand
 * after `db:migrate`, from a credential the deploy does not hold — locally that
 * is `crm`, in production it is the provider's SQL console.
 *
 * Idempotent: every object is CREATE OR REPLACE, every trigger is dropped and
 * recreated. Run it again after any change to `ddl-guard.sql`.
 */

const URL_ =
  process.env['OWNER_DATABASE_URL'] ??
  process.env['DEV_DATABASE_URL'] ??
  'postgresql://crm:crm@localhost:5432/crm_dev'

const client = postgres(URL_, { max: 1, onnotice: () => {} })

/**
 * REFUSES under a credential that cannot arm the guard, rather than failing
 * halfway through.
 *
 * Without this the first `CREATE EVENT TRIGGER` raises `permission denied to
 * create event trigger`, after three functions have already been created — a
 * database with the machinery and none of the teeth, which reads as installed
 * to anything that only checks for the functions.
 */
async function refuseWithoutSuperuser(): Promise<void> {
  const [row] = await client<{ role: string; super_: boolean }[]>`
    SELECT current_user AS role,
           (SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user) AS super_`

  if (row?.super_ === true) return

  console.error(
    `\nGUARD001: ${row?.role ?? 'this role'} cannot create an event trigger.` +
      `\n\nArming the E1b guard requires superuser, and that is deliberate: the` +
      `\ndeploy role must not be able to install — or uninstall — the thing that` +
      `\nlimits it. Point OWNER_DATABASE_URL at the owner, not at the deploy` +
      `\ncredential in MIGRATION_DATABASE_URL.` +
      `\n\n⚠️ If the managed provider grants no superuser at all, this cannot be` +
      `\narmed in production. That is residual risk R2 and it is still unmeasured` +
      `\n— do not paper over it; record what the provider answered.\n`,
  )
  await client.end()
  process.exit(1)
}

async function main(): Promise<void> {
  await refuseWithoutSuperuser()

  // First, because a database whose deploy cannot record a migration has no use
  // for a guard on what its migrations may do.
  await handOverDeployBookkeeping(client)
  await installDdlGuard(client)

  const armed = await client<{ evtname: string; evtenabled: string }[]>`
    SELECT evtname, evtenabled FROM pg_event_trigger
     WHERE evtname = ANY(${client.array([...GUARD_EVENT_TRIGGERS])})
     ORDER BY evtname`

  const disabled = armed.filter((t) => t.evtenabled === 'D').map((t) => t.evtname)
  if (armed.length !== GUARD_EVENT_TRIGGERS.length || disabled.length > 0) {
    throw new Error(
      `GUARD002: the guard did not arm. Expected ${GUARD_EVENT_TRIGGERS.length} enabled ` +
        `event triggers, found ${armed.length - disabled.length}.`,
    )
  }

  console.log(
    `🔒 E1b guard armed: ${armed.map((t) => t.evtname).join(', ')} + t_authz_guard_registry.\n` +
      `   A protected change now spends an authorisation this database's deploy role\n` +
      `   cannot create. Mint one with:  npm run db:authorize -- "why"\n` +
      `📒 drizzle bookkeeping belongs to crm_migrator, so the isolated credential can\n` +
      `   actually record a deploy. See scripts/deploy-credential.sql.`,
  )
}

main()
  .then(() => client.end())
  .catch(async (err: unknown) => {
    console.error(err)
    await client.end()
    process.exit(1)
  })
