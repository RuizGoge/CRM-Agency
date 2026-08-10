import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

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
  } finally {
    await sql.end()
  }
}

export async function teardown(): Promise<void> {
  // The database is left in place on purpose: when an assertion fails, being
  // able to open the exact state that failed is worth more than tidiness.
}
