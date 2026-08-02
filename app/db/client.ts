import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

/**
 * The database access layer.
 *
 * There is exactly one way to reach the database from application code, and it
 * is `withTenant`. The pool below is module-private and never exported: an
 * ESLint rule fails the build if anything outside `app/db/**` imports this
 * file, and `app/db/index.ts` re-exports only the two entry points.
 *
 * The reason is not tidiness. Every unit of work must be a transaction whose
 * FIRST statement establishes session context, because that invariant is the
 * only thing that makes a transaction-mode pooler safe. A query issued outside
 * that envelope runs with no context — which, thanks to the policies, returns
 * zero rows rather than another seller's book, but silently returning nothing
 * is its own bug. Making the pool unreachable removes the choice.
 */

const url = process.env['DATABASE_URL'] ?? 'postgresql://crm:crm@localhost:5432/crm_dev'

/**
 * Provisional. The real ceiling is a fact about the managed instance and is
 * still unmeasured — Sprint-0 gate G1(a) owns it, and G1(d) requires this to
 * be pinned against the measured number with 2x headroom for a rolling
 * redeploy. Until then this is deliberately small rather than optimistic.
 */
const poolMax = Number.parseInt(process.env['DB_POOL_MAX'] ?? '8', 10)

const pool = postgres(url, {
  max: poolMax,
  // Prepared statements do not survive a transaction-mode pooler: PgBouncer
  // hands the next transaction a different server connection, which has never
  // seen the prepared name. This must stay false in every environment,
  // including local, so that development trains the production configuration.
  prepare: false,
  onnotice: () => {},
})

const db = drizzle(pool)

export type ScopeMode = 'owner' | 'tenant_read' | 'tenant_admin' | 'system'

/** Who is acting. Note the absence of a scope: the caller cannot choose one. */
export interface SessionIdentity {
  readonly tenantId: string
  readonly userId: string
}

/** The transaction handle a unit of work receives. Never a pool. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Runs `fn` inside one transaction, with session context established by the
 * engine before `fn` can issue a single statement.
 *
 * `app.begin_request` reads `app_user.role` and derives the scope itself. That
 * is why `SessionIdentity` has no `scopeMode` field — there is no argument for
 * it, in this signature or in the SQL one, so no route can grant itself
 * tenant-wide read by passing the wrong literal.
 *
 * It also raises `CTX001` if context is already set, which is what a leaked
 * pooled connection looks like from inside the database.
 */
export async function withTenant<T>(
  identity: SessionIdentity,
  fn: (tx: Tx, scope: ScopeMode) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ scope: ScopeMode }>(
      sql`SELECT app.begin_request(${identity.tenantId}::uuid, ${identity.userId}::uuid) AS scope`,
    )
    const scope = rows[0]?.scope
    if (scope === undefined) {
      throw new Error('app.begin_request returned no scope')
    }
    return fn(tx, scope)
  })
}

/**
 * The system scope, for the four enumerated cross-tenant paths: the outbox
 * relay, scheduled-job dispatch, intake token resolution and the purge job.
 *
 * Kept separate from `withTenant` on purpose. A request has no way to reach
 * this, because reaching it means importing a different function by a
 * different name — which is greppable, reviewable, and countable.
 */
export async function withSystemWork<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT app.begin_system_work(${tenantId}::uuid)`)
    return fn(tx)
  })
}

/** Closes the pool. Process shutdown only. */
export async function closePool(): Promise<void> {
  await pool.end()
}
