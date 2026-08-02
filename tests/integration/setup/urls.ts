/**
 * Connection targets for the integration suite.
 *
 * The suite never runs against the development database. `crm_test` is dropped
 * and rebuilt on every run, so a test that leaves state behind cannot make the
 * next run pass for the wrong reason.
 */
const DEV_URL = process.env['DATABASE_URL'] ?? 'postgresql://crm:crm@localhost:5432/crm_dev'

export const TEST_DB = 'crm_test'

const base = new URL(DEV_URL)

/** Maintenance connection, used only to drop and create the test database. */
export const ADMIN_URL = ((): string => {
  const u = new URL(base)
  u.pathname = '/postgres'
  return u.toString()
})()

export const TEST_URL = ((): string => {
  const u = new URL(base)
  u.pathname = `/${TEST_DB}`
  return u.toString()
})()
