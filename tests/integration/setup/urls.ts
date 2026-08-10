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

/**
 * The test database, named per git worktree.
 *
 * A GIT WORKTREE ISOLATES FILES AND NOT THE DATABASE, and until this function
 * existed the name was the constant `crm_test` for every checkout on the
 * machine. Two worktrees running vitest at once therefore shared one database
 * while each one's `globalSetup` dropped and rebuilt it — so the second run
 * wiped the first run's schema mid-flight.
 *
 * OBSERVED, not theorised: two sessions (`crm-strategy-discussion-b1fc64` and
 * `virtualizacion-tablero-304005`) produced `duplicate key value violates
 * unique constraint "tenant_pkey"`, `write CONNECTION_CLOSED` and hook
 * timeouts, across a DIFFERENT set of files on every run, while each suite
 * passed alone. A red build that names a different victim each time is the
 * signature, and it costs an hour before anyone suspects the harness rather
 * than the change.
 *
 * The rebuild-every-run behaviour below is right and stays: a test that leaves
 * state behind must not make the next run pass for the wrong reason. It is only
 * unsafe when two runs share the target, which is what this removes.
 *
 * Blast radius is deliberately small: a plain checkout and CI both fall through
 * to `crm_test` and behave exactly as before. Only a path under
 * `.claude/worktrees/` gets a suffix.
 */
function testDatabaseName(): string {
  const marker = '/.claude/worktrees/'
  const cwd = process.cwd().replaceAll('\\', '/')
  const at = cwd.indexOf(marker)
  if (at === -1) return 'crm_test'

  const worktree = cwd.slice(at + marker.length).split('/')[0] ?? ''
  const slug = worktree
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .slice(0, 40)
  return slug === '' ? 'crm_test' : `crm_test_${slug}`
}

export const TEST_DB = testDatabaseName()

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
