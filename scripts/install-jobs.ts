import { getConstructionPlans } from 'pg-boss'
import postgres from 'postgres'

import { DISPATCH_QUEUE } from '../app/jobs/queues'

/**
 * Installs pg-boss's schema, as the MIGRATOR, at deploy time.
 *
 * pg-boss will build and migrate its own schema on `start()` if you let it.
 * This project does not: a library issuing DDL against production under the
 * application's credential is exactly the change nobody would see. The worker
 * runs with `migrate: false` and `crm_app` holds no CREATE on the schema, so
 * the running process CANNOT alter what it runs on even by accident.
 *
 * The cost is honest and stated: upgrading pg-boss is a deploy step, not a
 * restart. Run this again after the upgrade and it will apply what the new
 * version needs.
 *
 *   npm run db:migrate && npm run db:jobs
 *
 * Idempotent — it checks for pg-boss's own version table first, because the
 * construction plan is not written to be run twice.
 */

const URL_ =
  process.env['MIGRATION_DATABASE_URL'] ??
  process.env['DEV_DATABASE_URL'] ??
  'postgresql://crm:crm@localhost:5432/crm_dev'

const SCHEMA = 'pgboss'

const client = postgres(URL_, { max: 1, onnotice: () => {} })

/**
 * REFUSES to run before migration 0020 — and this is a recovered trap, not a
 * hypothetical.
 *
 * Run in the wrong order, this script BRICKS THE DATABASE. `security.harden()`
 * fails closed on any schema with no `security.schema_policy` row, migration
 * 0020 is the migration that classifies `pgboss` as exempt, and several
 * migrations call `harden()`. So installing pg-boss into a database whose
 * migrations have not reached 0020 leaves every remaining migration raising
 * `HR001: relation pgboss.version has no security.table_registry row` — for
 * ever. There is no forward fix and there are no down migrations. The only
 * recovery is `npm run db:reset`, which is a new database.
 *
 * Found by doing it: one chained command ran `db:jobs` after a `db:migrate`
 * that had raced the container's startup, and the next migrate attempt could
 * never succeed. The runbook already said migrate first; a runbook is
 * documentation, and this is the mechanism.
 */
async function refuseIfMigrationsAreBehind(): Promise<void> {
  // Two steps, because the registry itself arrives in migration 0000: on a
  // brand-new database the first query would raise instead of refusing, and a
  // guard that crashes teaches nobody which command to run.
  const [registry] = await client<{ present: boolean }[]>`
    SELECT to_regclass('security.schema_policy') IS NOT NULL AS present`

  if (registry?.present) {
    const [ready] = await client<{ classified: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM security.schema_policy WHERE schema_name = ${SCHEMA}
      ) AS classified`

    if (ready?.classified) return
  }

  console.error(
    `\nJOBS003: migrations have not reached 0020, which classifies the "${SCHEMA}"` +
      `\nschema as exempt from security.harden().` +
      `\n\nInstalling pg-boss now would leave every remaining migration raising` +
      `\nHR001 for ever — harden() fails closed on an unclassified schema, and this` +
      `\nproject has no down migrations. The database would need to be recreated.` +
      `\n\nRun the migrations first:` +
      `\n\n  npm run db:migrate && npm run db:jobs\n`,
  )
  await client.end()
  process.exit(1)
}

async function main(): Promise<void> {
  await refuseIfMigrationsAreBehind()

  const [installed] = await client<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${SCHEMA} AND c.relname = 'version'
    ) AS present`

  if (installed?.present) {
    console.log(`${SCHEMA}: already installed, leaving it alone.`)
  } else {
    await client.unsafe(getConstructionPlans(SCHEMA))
    console.log(`${SCHEMA}: schema created, owned by the migrator.`)
  }

  // DML and EXECUTE, never CREATE. Re-applied on every run rather than only on
  // first install: a grant that exists because someone ran a command once is
  // the kind of thing that quietly stops being true.
  await client.unsafe(`
    GRANT USAGE ON SCHEMA ${SCHEMA} TO crm_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO crm_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO crm_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} TO crm_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA}
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
  `)

  // The queue is created HERE, not by the worker. `boss.createQueue` is an
  // ordinary function rather than a definer, so a worker that had to create its
  // own queue would need privileges on the schema it is supposed to only read
  // and write rows in.
  await client.unsafe(`
    SELECT ${SCHEMA}.create_queue('${DISPATCH_QUEUE}', '{"policy":"standard"}'::jsonb)
    WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.queue WHERE name = '${DISPATCH_QUEUE}')
  `)

  console.log(`${SCHEMA}: queue "${DISPATCH_QUEUE}" ready; crm_app has DML and no CREATE.`)
}

main()
  .then(() => client.end())
  .catch(async (err: unknown) => {
    console.error(err)
    await client.end()
    process.exit(1)
  })
