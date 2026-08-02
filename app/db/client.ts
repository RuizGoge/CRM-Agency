import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'

import { pool } from './pool'

/**
 * The database access layer.
 *
 * There is exactly one way to reach the database from application code, and it
 * is `withTenant`. The pool lives in `./pool` and an ESLint rule fails the
 * build if anything outside `app/db/**` imports either file; `app/db/index.ts`
 * re-exports only the two entry points.
 *
 * The reason is not tidiness. Every unit of work must be a transaction whose
 * FIRST statement establishes session context, because that invariant is the
 * only thing that makes a transaction-mode pooler safe. A query issued outside
 * that envelope runs with no context — which, thanks to the policies, returns
 * zero rows rather than another seller's book, but a surface that silently
 * renders nothing is its own defect. Making the pool unreachable removes the
 * choice.
 */

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
 * Drops to the unprivileged role for the rest of the transaction, reverted at
 * COMMIT or ROLLBACK along with everything else `SET LOCAL`.
 *
 * Without this the silo depends on WHICH USER `DATABASE_URL` names, because a
 * superuser — or any role that owns the schema — bypasses row level security
 * entirely, FORCE included. The string `docker compose` hands out by default
 * is exactly such a user, so the development environment trains the broken
 * configuration with perfect fidelity, and the failure has no symptom: every
 * page renders, with every seller's rows.
 *
 * Found by the §7.7.1 canary fixture, which saw one seller's bytes in
 * another's search response the first time it ran.
 *
 * This is defence in depth, not the primary control — G4(a) still owes a boot
 * assertion that refuses to start when the connection user owns the schema.
 */
const dropPrivilege = sql`SET LOCAL ROLE crm_app`

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

    await tx.execute(dropPrivilege)
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
    await tx.execute(dropPrivilege)
    return fn(tx)
  })
}
