/**
 * Connection targets for the integration suite.
 *
 * THREE of them, and the split is the point rather than plumbing:
 *
 *   ADMIN_URL — the owner. Drops and creates the test database, and runs the
 *               migrations. Nothing under test uses it.
 *   OWNER_URL — the owner again, pointed at crm_test. Test fixtures use it to
 *               seed rows that RLS would otherwise forbid; it is the migrator,
 *               so it passes through the p_sys policy.
 *   APP_URL   — crm_app. This is what `withTenant` connects as, which means
 *               the suite exercises the real privilege set instead of a
 *               superuser pretending to be scoped.
 *
 * The suite never runs against the development database, and `crm_test` is
 * rebuilt on every run so a test that leaves state behind cannot make the next
 * run pass for the wrong reason.
 */
const DEV_URL =
  process.env['DEV_DATABASE_URL'] ??
  process.env['MIGRATION_DATABASE_URL'] ??
  'postgresql://crm:crm@localhost:5432/crm_dev'

export const TEST_DB = 'crm_test'

/**
 * The dev and CI password for `crm_app`. Set out of band by the setup path,
 * never in a migration: a credential written into a migration is a credential
 * in the repository, in the image, and in every clone. Production sets its own
 * in the provider's console.
 */
export const APP_ROLE_PASSWORD = 'crm_app_dev_only'

const base = new URL(DEV_URL)

function withPath(db: string): string {
  const u = new URL(base)
  u.pathname = `/${db}`
  return u.toString()
}

/** Maintenance connection, used only to drop and create the test database. */
export const ADMIN_URL = withPath('postgres')

/** The owner, on the test database. Fixtures and assertions about the catalog. */
export const OWNER_URL = withPath(TEST_DB)

/** Kept for callers that predate the split. Same thing as OWNER_URL. */
export const TEST_URL = OWNER_URL

/** The application role. What `withTenant` connects as, exactly as in production. */
export const APP_URL = ((): string => {
  const u = new URL(base)
  u.pathname = `/${TEST_DB}`
  u.username = 'crm_app'
  u.password = APP_ROLE_PASSWORD
  return u.toString()
})()
