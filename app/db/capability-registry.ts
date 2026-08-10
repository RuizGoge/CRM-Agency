import type postgres from 'postgres'

import { bootRefusal } from '~/modules/communications/capability'
import type {
  CapabilityName,
  CapabilityRow,
  CapabilityStatus,
} from '~/modules/communications/capability'

/**
 * ⚠️ THIS FILE DELIBERATELY DOES NOT IMPORT THE POOL, and every function here
 * takes its `sql` instead. `pool.ts` fires the boot assertion below as an
 * import-time side effect, so a pool import here would be a cycle —
 * `pool → capability-registry → pool` — and the process would be running a
 * partially-initialised module during its own boot check. ESM would probably
 * survive it on hoisted function declarations; "probably" is not a property to
 * hang a boot gate on. The memoised `ensureCapabilities` that DOES need the
 * pool lives in `pool.ts` for the same reason.
 */

/**
 * Reads `ref.provider_capability` at boot — §3's capability registry.
 *
 * WHY THIS IS IN `app/db/**` AND NOT IN THE COMMUNICATIONS MODULE. It was
 * written there first and the DATA-ACCESS GUARD refused it: only this directory
 * may import the driver. That refusal is correct rather than inconvenient —
 * reading a table is transport, and a domain module that knows what
 * `postgres.Sql` is has already absorbed the data layer. So the gate's TYPES
 * live in the module, where a capability's name and status are domain
 * vocabulary, and the READ lives here. The import above is type-only, so this
 * direction adds no runtime edge in either direction.
 *
 * WHY IT TAKES THE RAW DRIVER RATHER THAN A `Tx`. Same reason
 * `readConnectionPosture` does: at boot there is no tenant and no user, and
 * `withTenant` demands both. This runs before any request can be served.
 *
 * WHY IT IS SAFE TO READ WITHOUT SESSION CONTEXT, which is the question the
 * guard exists to make somebody ask. `ref.provider_capability` carries no
 * `tenant_id` — a provider's capability set is a property of the integration,
 * not of a tenant — and it is classified `reference`, so `harden()` grants
 * `crm_app` SELECT and nothing else. There is no silo to escape here and no
 * write this function could perform if it tried.
 */
export async function readCapabilities(sql: postgres.Sql): Promise<readonly CapabilityRow[]> {
  const rows = await sql<{ capability: string; status: string; tier: string }[]>`
    SELECT capability, status::text AS status, tier::text AS tier
      FROM ref.provider_capability
     WHERE provider = 'aloware'`

  // The casts are the boundary between an untyped row and the closed unions the
  // gate is built on, and they are the one place a drifted name could enter as
  // a lie. `capability-gate.test.ts` asserts the registry and `CapabilityName`
  // agree IN BOTH DIRECTIONS against the real database, which is what makes
  // these casts safe rather than hopeful.
  return [...rows].map((r) => ({
    capability: r.capability as CapabilityName,
    status: r.status as CapabilityStatus,
    tier: r.tier as CapabilityRow['tier'],
  }))
}

/** The three values `system_constant['environment']` may hold — see the CHECK. */
export type Environment = 'production' | 'development' | 'test'

/**
 * Which environment this DATABASE says it is.
 *
 * ⚠️ A MISSING ROW READS AS `production`, matching migration 0032's own default
 * and for the same reason: an unclassified database is the state a real
 * production database is in on the day it is created, and treating that as
 * development would leave every gate keyed on it silent exactly there. If the
 * table itself is missing — a database migrated only as far as 0031 — that is
 * also production, because a process cannot establish it is somewhere safe.
 */
export async function readEnvironment(sql: postgres.Sql): Promise<Environment> {
  const rows = await sql<{ value: string }[]>`
    SELECT value FROM ref.system_constant WHERE key = 'environment' LIMIT 1`
  const value = rows[0]?.value
  return value === 'development' || value === 'test' ? value : 'production'
}

/**
 * §3's boot assertion, wired.
 *
 * Throws rather than exiting, the same shape as `assertSafeConnection`: the
 * caller decides whether to take the process down or fail a test, so the same
 * function serves both and the test exercises the real predicate.
 */
export async function assertRequiredCapabilities(sql: postgres.Sql): Promise<void> {
  const [environment, rows] = await Promise.all([readEnvironment(sql), readCapabilities(sql)])
  const refusal = bootRefusal(environment === 'production', rows)
  if (refusal !== null) throw new Error(refusal)
}
