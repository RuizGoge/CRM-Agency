import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { installDdlGuard } from '../../../scripts/ddl-guard'
import { installJobSchema } from '../../../scripts/jobs-schema'

import { ADMIN_URL, APP_ROLE_PASSWORD, OWNER_URL, TEST_DB } from './urls'

/**
 * Builds the integration database from zero, once per run.
 *
 * This suite deliberately does NOT skip when no database is reachable. A test
 * that skips itself is how a gate quietly becomes a comment: it stays green on
 * every machine that cannot run it, including CI on the day the service block
 * is dropped from the workflow. If the database is missing, this throws and
 * the build goes red.
 */
export async function setup(): Promise<void> {
  let admin: postgres.Sql

  try {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
    await admin`SELECT 1`
  } catch (cause) {
    throw new Error(
      `Integration tests need PostgreSQL at ${ADMIN_URL.replace(/:[^:@]*@/, ':***@')}.\n` +
        `Start it with:  npm run db:up\n` +
        `These tests do not skip: the silo is the product's central guarantee, ` +
        `and a suite that skips itself proves nothing.`,
      { cause },
    )
  }

  try {
    // Rebuilt every run. Isolation between runs matters more here than speed:
    // harden() mutates grants and policies cluster-wide for the database it
    // runs in, and a leftover artefact from a previous run could mask a defect.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`)
  } finally {
    await admin.end()
  }

  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} })
  try {
    // The same migration files the production deploy runs. Nothing about the
    // schema under test is constructed by the test itself.
    await migrate(drizzle(sql), { migrationsFolder: 'app/db/migrations' })

    // The migration grants crm_app LOGIN and no password, on purpose. This is
    // the out-of-band step, and here it is a dev-only literal; production sets
    // it in the provider's console.
    await sql.unsafe(`ALTER ROLE crm_app WITH PASSWORD '${APP_ROLE_PASSWORD}'`)

    // 🔴 THE TEST DATABASE DECLARES ITSELF, and it has to.
    //
    // Migration 0032 classifies an unclassified database as `production` on
    // purpose — a real production database is unclassified on the day it is
    // created, and defaulting the other way leaves every gate keyed on it
    // silent exactly there. It derives `development` from the presence of a
    // demo tenant, and `crm_test` is built from migrations with no seed, so it
    // holds none and would classify as production.
    //
    // The symptom would not have been a failing assertion. `pool.ts` fires the
    // capability boot gate as an import-time side effect and its failure mode
    // is `process.exit(1)`, so the FIRST test file importing anything under
    // `~/db` would have taken the runner down with it — `call_list` is still
    // unverified. A harness that cannot say what it is gets treated as the
    // dangerous case, which is the design working rather than failing.
    await sql`
      INSERT INTO ref.system_constant (key, value, reason)
      VALUES ('environment', 'test',
              'Set by tests/integration/setup/global-setup.ts. crm_test is built from migrations with no seed, so it holds no demo tenant and 0032 would otherwise classify it production.')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason`

    // 🔴 pg-boss, AND ITS ABSENCE WAS A HOLE NOBODY COULD SEE.
    //
    // The deploy is `npm run db:migrate && npm run db:jobs` — the job schema
    // does NOT arrive in a migration, so a database built from migration files
    // alone has no `pgboss.queue` and no `pgboss.job`. This harness has been
    // building exactly that. It never showed, because the only queue was a cron
    // tick and nothing asserted on it.
    //
    // `app.webhook_ingest()` is what makes it matter: §4.2 ruling 1 puts the
    // enqueue in the SAME TRANSACTION as the vault write, so without the queue
    // the function's main path cannot run here at all. The install is imported
    // from the deploy script rather than reimplemented, so the two cannot
    // drift — a second copy would be a test harness asserting against a schema
    // production does not have.
    // 🔴 THE GRADE IS A PROPERTY OF WHOEVER DEPLOYED, so the harness records its
    // own rather than inheriting a number from somewhere else. `npm run db:migrate`
    // does this for the development database over MIGRATION_DATABASE_URL; this
    // connection is OWNER_URL, which is `crm`, so the honest answer here is
    // degraded — and property-b.test.ts pins exactly that. If somebody ever
    // points the harness at an isolated role, the pin goes red and says so.
    await sql`
      INSERT INTO ref.system_constant (key, value, reason)
      SELECT 'property_b_grade', g.grade,
             'Observed by tests/integration/setup/global-setup.ts, whose role is '
             || current_user || '. ' || g.reason
             || ' The E1b guard IS armed here, so a protected change spends an '
             || 'authorisation; what keeps this degraded is the ROLE, not the guard.'
        FROM security.property_b_grade(current_user) g
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, reason = EXCLUDED.reason`

    await installJobSchema(sql)

    // 🔴 ARMED LAST, AND THE SUITE RUNS ARMED. Everything above issues DDL the
    // guard would otherwise have to be authorised for — 75 migrations' worth of
    // policies, plus pg-boss's schema — so arming before them would mean minting
    // authorisations to build a test database, which teaches the harness to mint
    // them freely. Arming here means every test after this point runs against the
    // same protection production has, and `ddl-guard.test.ts` exercises it.
    //
    // ⚠️ This connection is `crm`, a superuser, which is the only reason the
    // harness CAN arm it. That is the honest shape of an out-of-band step: the
    // thing that installs the guard is not the thing the guard limits.
    await installDdlGuard(sql)
  } finally {
    await sql.end()
  }
}

export async function teardown(): Promise<void> {
  // The database is left in place on purpose: when an assertion fails, being
  // able to open the exact state that failed is worth more than tidiness.
}
