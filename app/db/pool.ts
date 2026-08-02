import postgres from 'postgres'

/**
 * The one connection pool in the process.
 *
 * Nothing outside `app/db/**` may import this file — see the DATA-ACCESS GUARD
 * in `eslint.config.js`. Application code reaches the database through
 * `withTenant` in `~/db`, which is the only construct that guarantees a unit
 * of work opens with session context established.
 */

const url = process.env['DATABASE_URL'] ?? 'postgresql://crm:crm@localhost:5432/crm_dev'

/**
 * Provisional. The real ceiling is a fact about the managed instance and is
 * still unmeasured — Sprint-0 gate G1(a) owns it, and G1(d) requires this to
 * be pinned against the measured number with 2x headroom for a rolling
 * redeploy. Until then this is deliberately small rather than optimistic.
 */
const poolMax = Number.parseInt(process.env['DB_POOL_MAX'] ?? '8', 10)

export const pool = postgres(url, {
  max: poolMax,
  // Prepared statements do not survive a transaction-mode pooler: PgBouncer
  // hands the next transaction a different server connection, which has never
  // seen the prepared name. This must stay false in every environment,
  // including local, so that development trains the production configuration.
  prepare: false,
  onnotice: () => {},
})

/** Closes the pool. Process shutdown only. */
export async function closePool(): Promise<void> {
  await pool.end()
}
