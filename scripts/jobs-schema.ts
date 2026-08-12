import type postgres from 'postgres'

import { jobSchemaPlans } from '../app/jobs/boss'
import { QUEUE_SPECS, type QueueSpec } from '../app/jobs/queues'

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

/** What `pgboss.queue` calls each field of a `QueueSpec`. */
const COLUMNS: readonly (readonly [keyof QueueSpec, string])[] = [
  ['policy', 'policy'],
  ['retryLimit', 'retry_limit'],
  ['retryDelay', 'retry_delay'],
  ['retryBackoff', 'retry_backoff'],
  ['expireInSeconds', 'expire_seconds'],
  ['retentionSeconds', 'retention_seconds'],
  ['deleteAfterSeconds', 'deletion_seconds'],
  ['deadLetter', 'dead_letter'],
]

/**
 * The DEAD-LETTER QUEUE MUST EXIST BEFORE THE QUEUES THAT NAME IT.
 *
 * `pgboss.queue.dead_letter` is a foreign key to `pgboss.queue(name)`, so
 * creating `call-merge` with `deadLetter: 'dead-letter'` before that row exists
 * fails the insert. Sorted rather than hand-ordered so that adding a queue does
 * not require remembering this.
 */
function inDependencyOrder(specs: readonly QueueSpec[]): readonly QueueSpec[] {
  return [...specs].sort((a, b) => Number(a.deadLetter !== null) - Number(b.deadLetter !== null))
}

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
    await client.unsafe(jobSchemaPlans(SCHEMA))
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

  // 🔴 AND THE SAME FOR crm_migrator, WHICH 0062 MADE NECESSARY. `pgboss` is
  // classified `exempt`, so the ownership handover deliberately does not reach
  // it — but `app.webhook_ingest` is a SECURITY DEFINER that inserts into
  // `pgboss.job`, and after 0062 it runs as `crm_migrator` rather than as a
  // superuser. Without these grants every inbound Aloware webhook raises
  // `permission denied for table job` and calls stop reaching sellers.
  //
  // 0062 carries the same block for the case where pgboss ALREADY exists. This
  // one is the other half rather than a duplicate: on a fresh database
  // `db:jobs` runs AFTER the migrations, so when 0062 executes there is no
  // pgboss schema to grant on and its own block is skipped.
  await client.unsafe(`
    GRANT USAGE ON SCHEMA ${SCHEMA} TO crm_migrator;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO crm_migrator;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO crm_migrator;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} TO crm_migrator;
    ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA}
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_migrator;
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
  for (const spec of inDependencyOrder(QUEUE_SPECS)) {
    const options = JSON.stringify({
      policy: spec.policy,
      retryLimit: spec.retryLimit,
      retryDelay: spec.retryDelay,
      retryBackoff: spec.retryBackoff,
      expireInSeconds: spec.expireInSeconds,
      retentionSeconds: spec.retentionSeconds,
      deleteAfterSeconds: spec.deleteAfterSeconds,
      ...(spec.deadLetter === null ? {} : { deadLetter: spec.deadLetter }),
    })

    // `unsafe` with an inlined literal, and it is the safe form here: a bound
    // parameter arrives as a JSON *string* rather than an object, so
    // `options->>'policy'` reads NULL and `create_queue` fails on a NOT NULL —
    // which is what the first version of this did. Every value interpolated
    // below is ours, from `QUEUE_SPECS`, and none of it is reachable from a
    // request.
    await client.unsafe(`
      SELECT ${SCHEMA}.create_queue('${spec.name}', '${options}'::jsonb)
       WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.queue WHERE name = '${spec.name}')`)

    // 🔴 RE-READ AND RECONCILE EVERY FIELD, not just the policy.
    //
    // `create_queue` is guarded on NOT EXISTS, so a queue that already exists
    // with the wrong settings is skipped in silence. That used to be checked
    // for `policy` alone, and Gate 8 found what the other columns were doing
    // meanwhile: `dead_letter` was NULL on all three queues and
    // `retry_delay`/`retry_backoff` were 0/false — three retries in the same
    // millisecond, and nowhere for the fourth failure to go.
    //
    // Reconciled with an UPDATE rather than thrown on, because these are
    // OPERATIONAL settings rather than identity: changing a policy re-keys
    // pg-boss's partial unique indexes and stays a refusal, while raising a
    // retry limit is exactly the kind of thing a deploy should just apply.
    const [live] = await client<Record<string, unknown>[]>`
      SELECT policy, retry_limit, retry_delay, retry_backoff,
             expire_seconds, retention_seconds, deletion_seconds, dead_letter
        FROM pgboss.queue WHERE name = ${spec.name}`

    if (live === undefined) {
      throw new Error(`JOBS005: queue "${spec.name}" does not exist after create_queue`)
    }

    if (live['policy'] !== spec.policy) {
      throw new Error(
        `JOBS004: queue "${spec.name}" has policy "${String(live['policy'])}", ` +
          `but this deploy expects "${spec.policy}".\n\n` +
          `The policy is a column on every JOB ROW, and pg-boss's partial unique ` +
          `indexes read it from there. A mismatch does not error — it silently ` +
          `disables the de-duplication the queue was chosen for.\n\n` +
          `Changing a live queue's policy is a decision, not a repair: fix it ` +
          `deliberately against the database.`,
      )
    }

    const drifted = COLUMNS.filter(([key, column]) => {
      if (key === 'policy') return false
      // Compared as strings on purpose: the driver hands `retry_limit` back as
      // a number and `retry_backoff` as a boolean, while `dead_letter` is a
      // nullable text. One coercion beats three type-aware branches, and a
      // spurious mismatch costs an idempotent UPDATE rather than a wrong answer.
      const want = String(spec[key] ?? '')
      const got = live[column]
      return (
        want !==
        (got === null || got === undefined ? '' : JSON.stringify(got).replace(/^"|"$/g, ''))
      )
    })

    if (drifted.length > 0) {
      await client`
        UPDATE pgboss.queue
           SET retry_limit       = ${spec.retryLimit},
               retry_delay       = ${spec.retryDelay},
               retry_backoff     = ${spec.retryBackoff},
               expire_seconds    = ${spec.expireInSeconds},
               retention_seconds = ${spec.retentionSeconds},
               deletion_seconds  = ${spec.deleteAfterSeconds},
               dead_letter       = ${spec.deadLetter},
               updated_on        = now()
         WHERE name = ${spec.name}`

      log(
        `${SCHEMA}: queue "${spec.name}" reconciled — ${drifted
          .map(([, column]) => column)
          .join(', ')}.`,
      )
    }

    log(
      `${SCHEMA}: queue "${spec.name}" ready, policy "${spec.policy}", ` +
        `retries ${spec.retryLimit}${spec.retryBackoff ? ' with backoff' : ''}, ` +
        `dead letter ${spec.deadLetter ?? 'none'}.`,
    )
  }
}
