import postgres from 'postgres'

import { installCapabilities } from '~/modules/communications/capability'

import {
  assertDefinerOwnerIsPolicyBound,
  assertEventEmitIsDefinerOnly,
  assertLedgerAppendIsDefinerOnly,
  assertGateIsRecording,
  assertSafeConnection,
} from './boot-assert'
import { assertRequiredCapabilities, readCapabilities } from './capability-registry'

/**
 * The one connection pool in the process.
 *
 * Nothing outside `app/db/**` may import this file — see the DATA-ACCESS GUARD
 * in `eslint.config.js`. Application code reaches the database through
 * `withTenant` in `~/db`, which is the only construct that guarantees a unit
 * of work opens with session context established.
 */

/**
 * The fallback is the APPLICATION role, not the owner.
 *
 * It used to be `crm:crm`, the superuser string docker compose hands out — and
 * the first thing the boot assertion below did, on its very first run, was
 * refuse to start because of it. That default had been live for eight sprint
 * items: the silo held only because `withTenant` remembered to SET LOCAL ROLE,
 * never because of who was connected.
 *
 * A wrong default in development is not a development problem. It is the
 * configuration everyone copies.
 */
const url =
  process.env['DATABASE_URL'] ?? 'postgresql://crm_app:crm_app_dev_only@localhost:5432/crm_dev'

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

/**
 * Sprint-0 gate G4(a), enforced at boot.
 *
 * Deliberately not awaited: the pool has to be exported synchronously, and a
 * guard that delayed every import would be a guard people route around. The
 * check completes in milliseconds and takes the process down before a request
 * can be served — which is the whole design. A deploy that will not come up is
 * a symptom; a silo that quietly does not apply is not.
 *
 * `process.exit` rather than a thrown promise: an unhandled rejection here
 * would be logged and the server would keep serving, which is the one outcome
 * this must not have.
 */
void assertSafeConnection(pool).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

/**
 * Migration 0060's revoke, re-asserted at every boot.
 *
 * Same shape and the same reasons as the check above — not awaited, and
 * `process.exit` rather than a thrown promise. It is here rather than beside
 * the production-only capability gate because the failure it catches is a
 * `GRANT` in an unread migration diff, and that arrives in development first.
 */
void assertGateIsRecording(pool).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

/**
 * Migration 0061's revoke, re-asserted at every boot.
 *
 * Same shape and same reasons as the two checks above. It matters MORE than
 * either of them for one reason: the thing it guards has no symptom anywhere.
 * A `GRANT` that undoes 0061 leaves every screen, every test and every board
 * identical while re-opening a path for any route to forge any of the 49
 * events, so a deploy that refuses to start is the only notice available.
 */
void assertEventEmitIsDefinerOnly(pool).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

/**
 * Migration 0062's handover, re-asserted at every boot.
 *
 * The one of these four whose failure is NOT a security regression but an
 * outage: a managed relation owned by anyone but `crm_migrator` is a relation
 * no SECURITY DEFINER can write, and the symptom is a close that fails inside
 * the money path rather than anything visible here.
 */
void assertDefinerOwnerIsPolicyBound(pool).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

/**
 * Migration 0063's revoke and its two money bounds, re-asserted at every boot.
 *
 * Like 0061's, this guards something with NO symptom on any screen — nothing
 * about the board, the tests or a seller's day changes if the grant comes back.
 * Unlike 0061's, what it guards is the public money number.
 */
void assertLedgerAppendIsDefinerOnly(pool).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

/**
 * §3's boot assertion, enforced at boot — the second half of the capability
 * gate, and the half that has been unbuildable until migration 0032 gave the
 * process a way to know which environment it is in.
 *
 * The type gate (`alowareCapability`) makes an unverified capability
 * uncallable; this makes an unverified `mvp_required` capability unSERVEABLE.
 * They fail at different times on purpose: one at compile, one at boot, and
 * neither is a rule anybody has to remember.
 *
 * Same shape as the check above and for the same reasons: not awaited, because
 * the pool has to be exported synchronously and a guard that delayed every
 * import is a guard people route around; `process.exit` rather than a thrown
 * promise, because an unhandled rejection here would be logged while the server
 * kept serving — the one outcome this must not have.
 *
 * ⚠️ IT IS SILENT OUTSIDE PRODUCTION, which is the whole point and also its
 * weakness: development and CI never exercise the refusal. `capability-boot.test.ts`
 * is what covers it, by calling the same predicate with production asserted.
 */
void assertRequiredCapabilities(pool).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

/**
 * The capability registry, read once and memoised for the life of the process.
 *
 * WHY A PROMISE AND NOT A FIRE-AND-FORGET. The two assertions above can be
 * fired and forgotten because their failure mode is `process.exit(1)` and
 * nothing downstream needs their result. This one HAS a result, and a request
 * arriving during the read would find the registry uninstalled and get
 * `CAP101`. So callers await it, and the await is free after the first.
 *
 * Capability status changes only by migration, so caching it for the process
 * lifetime is not a staleness risk: a migration is a deploy, and a deploy is a
 * new process.
 *
 * It lives HERE rather than beside its own functions because it needs the pool,
 * and `capability-registry.ts` refuses to import it — see the note at the top
 * of that file for the cycle this avoids.
 */
let capabilitiesReady: Promise<void> | undefined

export function ensureCapabilities(): Promise<void> {
  capabilitiesReady ??= readCapabilities(pool).then(installCapabilities)
  return capabilitiesReady
}

/** Closes the pool. Process shutdown only. */
export async function closePool(): Promise<void> {
  await pool.end()
}
