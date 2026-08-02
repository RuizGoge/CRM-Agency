import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { ADMIN_URL, TEST_DB, TEST_URL } from './urls'

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

  const sql = postgres(TEST_URL, { max: 1, onnotice: () => {} })
  try {
    // The same migration files the production deploy runs. Nothing about the
    // schema under test is constructed by the test itself.
    await migrate(drizzle(sql), { migrationsFolder: 'app/db/migrations' })
  } finally {
    await sql.end()
  }
}

export async function teardown(): Promise<void> {
  // The database is left in place on purpose: when an assertion fails, being
  // able to open the exact state that failed is worth more than tidiness.
}
