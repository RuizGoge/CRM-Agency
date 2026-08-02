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

async function main(): Promise<void> {
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
