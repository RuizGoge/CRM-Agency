import { getConstructionPlans } from 'pg-boss'
import type postgres from 'postgres'

import {
  CALL_MERGE_POLICY,
  CALL_MERGE_QUEUE,
  DISPATCH_QUEUE,
  MESSAGE_MERGE_POLICY,
  MESSAGE_MERGE_QUEUE,
} from '../app/jobs/queues'

/**
 * Installs pg-boss's schema and this project's queues, as the MIGRATOR.
 *
 * 🔴 IT LIVES IN ITS OWN MODULE SO THAT THE INTEGRATION DATABASE AND THE DEPLOY
 * RUN THE SAME CODE, and that is not tidiness — it closes a hole this file was
 * written to fix. `crm_test` is rebuilt from the migration files on every run,
 * and pg-boss's schema does NOT arrive in a migration: it arrives in the
 * `npm run db:jobs` deploy step. So the test database has never had a job queue
 * at all, and nothing that enqueues could be tested against it. That was
 * invisible while the only queue was a cron tick nothing asserted on.
 *
 * `app.webhook_ingest()` is the change that makes it matter: it inserts into
 * `pgboss.job` inside the same transaction as the vault write, so a test
 * database without the queue cannot exercise the function's main path.
 *
 * The caller owns the connection and the failure policy — the CLI exits
 * non-zero, the test harness throws.
 */

const SCHEMA = 'pgboss'

/** The queues this product has, with the policy each one's behaviour depends on. */
const QUEUES: readonly (readonly [string, string])[] = [
  [DISPATCH_QUEUE, 'standard'],
  [CALL_MERGE_QUEUE, CALL_MERGE_POLICY],
  [MESSAGE_MERGE_QUEUE, MESSAGE_MERGE_POLICY],
]

export async function installJobSchema(
  client: postgres.Sql,
  log: (message: string) => void = () => {},
): Promise<void> {
  const [installed] = await client<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${SCHEMA} AND c.relname = 'version'
    ) AS present`

  if (installed?.present) {
    log(`${SCHEMA}: already installed, leaving it alone.`)
  } else {
    await client.unsafe(getConstructionPlans(SCHEMA))
    log(`${SCHEMA}: schema created, owned by the migrator.`)
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

  // The queues are created HERE, not by the worker. `boss.createQueue` is an
  // ordinary function rather than a definer, so a worker that had to create its
  // own queue would need privileges on the schema it is supposed to only read
  // and write rows in.
  //
  // 🔴 AND `call-merge` MUST EXIST BEFORE THE FIRST WEBHOOK, for a reason that
  // is invisible until it bites. `pgboss.job` is partitioned by LIST(name) with
  // `q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) DEFERRABLE
  // INITIALLY DEFERRED`. Deferred means a missing queue does not fail the
  // INSERT — it fails the **COMMIT**, and by then the vault write and the
  // dedupe insert are in the same doomed transaction. One missing row here
  // would discard every delivery, and Aloware never retries.
  // `app.webhook_ingest()` raises `WI004` rather than relying on this, but a
  // deploy step is where it should have been caught.
  for (const [queue, policy] of QUEUES) {
    await client.unsafe(`
      SELECT ${SCHEMA}.create_queue('${queue}', '{"policy":"${policy}"}'::jsonb)
      WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.queue WHERE name = '${queue}')
    `)

    // Re-read rather than trust the create. `create_queue` is guarded on NOT
    // EXISTS, so a queue that already exists with the WRONG policy is skipped
    // in silence — and the policy is what pg-boss's partial unique indexes key
    // on, so the wrong one means jobs that look enqueued and dedupe by nothing.
    const [live] = await client<{ policy: string }[]>`
      SELECT policy FROM pgboss.queue WHERE name = ${queue}`

    if (live?.policy !== policy) {
      throw new Error(
        `JOBS004: queue "${queue}" has policy "${live?.policy ?? 'none'}", ` +
          `but this deploy expects "${policy}".\n\n` +
          `The policy is a column on every JOB ROW, and pg-boss's partial unique ` +
          `indexes read it from there. A mismatch does not error — it silently ` +
          `disables the de-duplication the queue was chosen for.\n\n` +
          `Changing a live queue's policy is a decision, not a repair: fix it ` +
          `deliberately against the database.`,
      )
    }

    log(`${SCHEMA}: queue "${queue}" ready, policy "${policy}".`)
  }
}
