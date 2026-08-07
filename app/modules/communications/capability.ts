/**
 * The compile-time half of §3's capability gate.
 *
 * Aloware's capability set is a VARIABLE, not a constant (ARR-INT-02). So a
 * capability is never modelled as a function that exists — it is a row with a
 * verification state, and the type system refuses to let an unverified one be
 * called.
 *
 * ⚠️ THIS FILE IS THE GATE. `05-architecture.md` §3 specified it, Sprint-0 Gate
 * G2 unblocked it, and until now nobody had written it: migration 0030 promoted
 * `two_legged_call` to `verified` in the DATABASE while `alowareCapability` did
 * not exist in the TREE. A row that says `verified` with no type reading it is a
 * lock with no door.
 *
 * WHAT THIS FILE DECIDES AND WHAT IT DOES NOT. It decides whether a capability
 * can be CALLED — at compile time, because only the `verified` variant has
 * `.call`. Whether the process may SERVE is the other half of §3, and it lives
 * in `bootRefusal` at the bottom of this file plus its wiring in `pool.ts`. The
 * two fail at different moments on purpose: one at typecheck, one at boot.
 *
 * (This paragraph used to end *"and `system_constant` does not exist yet"*.
 * Migration 0032 built it, and the boot half is wired. A comment describing a
 * hole that has been filled is how the next reader concludes the gate is still
 * missing and builds a second one.)
 */

/**
 * The capability vocabulary of §3's table. A closed union rather than `string`,
 * because `alowareCapability('two_leged_call')` must not compile — a typo would
 * otherwise read as an unverified capability and silently disable a feature,
 * which is the failure this whole construction exists to prevent.
 *
 * These names are the primary key of `ref.provider_capability`. A name added
 * here without its registry row is caught by `capability-registry.test.ts`, and
 * a row added there without a name here is caught by the same test — the two
 * directions are different defects and both are real.
 */
export type CapabilityName =
  | 'two_legged_call'
  | 'webhook_subscription'
  | 'sms_send'
  | 'call_list'
  | 'contact_lookup'
  | 'sequence_enroll'
  | 'sequence_disenroll'
  | 'recording_announcement_on_two_legged'

/** §3's three states. `unknown` is the default and the honest one. */
export type CapabilityStatus = 'unknown' | 'verified' | 'absent'

/**
 * A capability, as the caller sees it.
 *
 * **Only the `verified` variant carries `call`.** A caller that forgets to
 * handle the other two does not compile, because `.call` is not present on the
 * union. There is deliberately no `callOrThrow()`, no `assertVerified()` and no
 * default branch: each of those is a way to turn a compile error into a runtime
 * one, and a runtime one here means a seller taps Call and nothing happens.
 *
 * `absent` and `unknown` are kept distinct even though neither can dial. They
 * mean different things to `/admin/integration-health` — `absent` is "the
 * provider answered and said no", `unknown` is "we have not established it" —
 * and collapsing them is how a transport failure gets recorded as a verdict.
 */
export type Capability<TCall> =
  | { readonly status: 'verified'; readonly call: TCall }
  | { readonly status: 'unknown' }
  | { readonly status: 'absent' }

/**
 * What each capability's `call` member is, once verified.
 *
 * `never` means "verified, and still not callable from here" — the capability
 * is real but this module ships no implementation of it. `recording_announcement_on_two_legged`
 * is the clearest case: it is `probe_only`, it exists to be OBSERVED, and there
 * is nothing to invoke. Typing it `never` makes calling it impossible rather
 * than merely unimplemented.
 *
 * ⚠️ Every member is `never` today, including `two_legged_call`. The dial is
 * P3's work and it must arrive with a `RequestScoped` token in its signature
 * (P3.1 mechanism 1), so widening this type is the change that admits it — and
 * it is a change somebody has to make on purpose.
 */
export interface CapabilityCall {
  two_legged_call: never
  webhook_subscription: never
  sms_send: never
  call_list: never
  contact_lookup: never
  sequence_enroll: never
  sequence_disenroll: never
  recording_announcement_on_two_legged: never
}

/** One row of `ref.provider_capability`, as read at boot. */
export interface CapabilityRow {
  readonly capability: CapabilityName
  readonly status: CapabilityStatus
  readonly tier: 'mvp_required' | 'mvp_optional' | 'probe_only'
}

/**
 * The boot snapshot.
 *
 * Read ONCE, at boot, never per request. Capability status changes only by
 * migration, so a request that re-read it would be paying a round trip for a
 * value that cannot have moved since the process started.
 *
 * ⚠️ THIS LOOKS LIKE THE THING P3.1 FORBIDS AND IS NOT, so the distinction is
 * written here rather than left to be rediscovered. P3.1 mechanism 4 bans
 * module-level mutable state in the adapter layer, on the reasoning that an
 * in-memory circuit breaker diverges between the folded and split topologies.
 * That reasoning is about state that CHANGES WHILE THE PROCESS RUNS. This does
 * not: it is a deploy-time constant, it is identical in every process reading
 * the same database, and a migration that changes it is a deploy. The breaker
 * stays in `app.integration_health`, which is a row, exactly as ruled.
 */
let snapshot: ReadonlyMap<CapabilityName, CapabilityRow> | undefined

/**
 * ⚠️ THE REGISTRY READ IS NOT IN THIS FILE, and that placement was decided by a
 * build gate rather than by taste. It first lived here and the DATA-ACCESS
 * GUARD in `eslint.config.js` refused it by name: only `app/db/**` may import
 * the driver. The guard is right — reading a table is transport, and a domain
 * module that knows what `postgres.Sql` is has already let the data layer leak
 * into it. The reader is `readCapabilities` in `~/db/capability-registry`; the
 * types it returns are declared here, because a capability's name, status and
 * tier are domain vocabulary and not a row shape.
 *
 * The guard offers a versioned one-file exception, with a written reason, and
 * it was deliberately NOT taken. An exception here would have bought nothing
 * except keeping two paragraphs in the same file.
 */

/**
 * Installs the boot snapshot. Called once, from the composition root.
 *
 * Refuses to run twice. A second call would mean either a double boot or a
 * test reaching for a back door, and both are worth failing loudly: a registry
 * that can be re-pointed at runtime is a registry that can be re-pointed to
 * `verified`.
 */
export function installCapabilities(rows: readonly CapabilityRow[]): void {
  if (snapshot !== undefined) {
    throw new Error('CAP100: the capability registry is already installed')
  }
  snapshot = new Map(rows.map((r) => [r.capability, r]))
}

/** Test seam. Not exported from the module's public entry point. */
export function resetCapabilitiesForTest(): void {
  snapshot = undefined
}

/**
 * The gate.
 *
 * ⚠️ THROWS when the registry has not been installed, and that is deliberate
 * rather than defensive. The tempting alternative — returning `{status:
 * 'unknown'}` — fails closed in the narrow sense (there is still no `.call`)
 * and fails OPEN in the sense that matters: a wiring bug would be
 * indistinguishable from a capability the spike never proved, so the product
 * would quietly have no dialer and the admin page would blame Aloware for it.
 *
 * A capability with no registry row is `unknown`, which is different: that is a
 * name we know about and a row nobody seeded, and `unknown` is the correct and
 * honest reading of it.
 */
export function alowareCapability<N extends CapabilityName>(
  name: N,
): Capability<CapabilityCall[N]> {
  if (snapshot === undefined) {
    throw new Error(
      `CAP101: alowareCapability('${name}') was called before the registry was installed. ` +
        `The composition root must call installCapabilities() during boot.`,
    )
  }

  const row = snapshot.get(name)
  if (row === undefined || row.status === 'unknown') return { status: 'unknown' }
  if (row.status === 'absent') return { status: 'absent' }

  // The `call` member is `never` for every capability today, so there is
  // nothing to hand back yet. P3 replaces this with the dial adapter, and the
  // type is what forces that to be a deliberate edit rather than a drift.
  return { status: 'verified', call: undefined as CapabilityCall[N] }
}

/**
 * The rows that would refuse a production boot, or an empty list.
 *
 * Pure, and separate from the process-exit decision for the same reason
 * `unsafeReasons` is: the same function then serves the boot path and the test,
 * and a test that cannot reach the real predicate is a test of a copy of it.
 *
 * ⚠️ TWO capabilities block today, not one. `webhook_subscription` is
 * `mvp_required` and cannot be promoted with `ref.capability_probe` as designed
 * — it models an OUTBOUND request and a webhook is INBOUND (see migration 0030's
 * header). `call_list` is `mvp_required` and Gate G2 found it neither documented
 * nor discoverable, while §3's own "if absent" cell for that row describes a
 * compensating control and the MVP shipping anyway. Those two texts cannot both
 * be true, and this function reports the tier as written rather than as wished.
 */
export function unverifiedRequiredCapabilities(
  rows: readonly CapabilityRow[],
): readonly CapabilityRow[] {
  return rows.filter((r) => r.tier === 'mvp_required' && r.status !== 'verified')
}

/**
 * §3's boot assertion, as a pure decision: the message a production process
 * should die with, or `null`.
 *
 * Separate from the process-exit for the same reason `unsafeReasons` is next
 * door: the same function then serves the boot path and the test, and a test
 * that cannot reach the real predicate is a test of a copy of it.
 *
 * ⚠️ `isProduction` IS A BOOLEAN AND NOT AN ENVIRONMENT NAME, deliberately. This
 * module has no business knowing that `development` and `test` are the other two
 * — that vocabulary belongs to `ref.system_constant`, and a second copy of it
 * here is a second place it could drift.
 *
 * What this converts is ARR-INT-01 and ARR-MVP-31 — *"no dependent UI may be
 * built until the spike proves it"* — from a process rule a model will not
 * remember into a deploy that will not start.
 */
export function bootRefusal(isProduction: boolean, rows: readonly CapabilityRow[]): string | null {
  if (!isProduction) return null

  const blocking = unverifiedRequiredCapabilities(rows)
  if (blocking.length === 0) return null

  const named = blocking.map((r) => `${r.capability} (${r.status})`).join(', ')
  return (
    `CAP200: refusing to start. ${blocking.length} mvp_required capabilit` +
    `${blocking.length === 1 ? 'y is' : 'ies are'} not verified: ${named}.\n\n` +
    `A capability is verified by a captured exchange — an outbound probe in ` +
    `ref.capability_probe or an inbound delivery in ref.capability_delivery — ` +
    `cited by a migration. Serving traffic without one means shipping a feature ` +
    `whose provider support was never established.`
  )
}
