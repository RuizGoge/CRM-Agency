import { sql } from 'drizzle-orm'

import { ensureCapabilities, withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { alowareCapability } from '~/modules/communications/capability'

/**
 * `POST /api/calls` — the dial.
 *
 * P3.1 rules that the outbound two-legged dial runs INSIDE the seller's own
 * request, never behind the outbox relay or a job: with the POST on another
 * process the browser already holds its `200`, so an Aloware failure is
 * discovered by something that renders nothing, and ARR-INT-03, ARR-MVP-26 and
 * ARR-INT-09 are all violated at once.
 *
 * 🔴 THE PROVIDER GIVES US THREE OUTCOMES AND THE DESIGN ONLY HAD TWO. Gate G2
 * measured a third, and it is the reason this file distinguishes `no_agent`
 * from `degraded`:
 *
 *   202  in 882–1737 ms  the call exists; webhooks will follow
 *   422  in ~2187 ms     "we can not find any available inbox users" — NO CALL
 *                        IS CREATED and no webhook is ever emitted
 *   5xx / timeout        unknown; the call may or may not exist
 *
 * Two consequences fall out of the 422 and both land on already-signed rulings:
 *
 * 1. **It must not open the circuit breaker.** `app.integration_health_record`
 *    opens at 3 consecutive failures inside 60 s (P3.4). A seller whose softphone
 *    is closed, tapping Call three times, would otherwise show all fifty sellers
 *    a tenant-wide outage banner for a problem in one seller's app. A 422 is the
 *    provider healthy and answering; it is a seller-availability fact.
 *
 * 2. **The `call` row must not be left immortal.** P3.2 commits the row and
 *    `call.initiated` BEFORE the dial. That was right when the only failure was a
 *    timeout, where the call MIGHT exist. On a 422 it definitely does not, so
 *    nothing will ever arrive to close it — it would sit `initiated` forever,
 *    count as an attempt and corrupt `last_activity_at`, the 7-day cold rule and
 *    the decay rail. ARR-EVT-18 is not reversed; the row is closed by a
 *    compensating write in the same request.
 *
 * ⚠️ THE PROVIDER CALL IS DELIBERATELY NOT WIRED IN THIS BUILD, and the endpoint
 * says so in its result rather than pretending. Two independent reasons:
 * `aloware_number_mapping` does not exist, so no seller has a number to present;
 * and every two-legged dial is billable against an account already in arrears —
 * the owner's instruction is that nothing here touches Aloware. What ships is the
 * whole decision path up to the socket, so the surface, its states and its copy
 * are real and testable today.
 */

export type DialOutcome =
  /** The provider accepted. Not "answered" — the 202 is establishment. */
  | { readonly status: 'dispatched'; readonly alowareCallId: string }
  /** 422. No agent available, no call created, ~2 s. Not an integration failure. */
  | { readonly status: 'no_agent' }
  /** 5xx or the 10 s ceiling. The breaker counts these and only these. */
  | { readonly status: 'degraded'; readonly reason: 'timeout' | 'provider_error' }
  /** We refused before reaching the provider. Each reason has its own sentence. */
  | {
      readonly status: 'blocked'
      readonly reason: 'no_capability' | 'no_number' | 'no_phone' | 'not_found' | 'no_credentials'
    }
  /**
   * THE COMPLIANCE GATE SAID NO, and it is a separate variant rather than more
   * strings in the one above because these six are not operational problems the
   * seller can fix by configuring something — they are the product refusing on
   * legal grounds, and the seller must be told which one and why.
   *
   * `verdict` is the enum the gate returned; `eventVerdict` is the ratified
   * vocabulary string the gate itself produced. Both come from the gate's own
   * columns — reconstructing either in TypeScript would be a second table of
   * truth that can drift from the one in the database.
   */
  | {
      readonly status: 'refused'
      readonly verdict: GateVerdict
      readonly eventVerdict: string | null
      readonly zones: readonly string[]
    }

/** The six the chain can return. `allow` is the seventh and is not a refusal. */
export type GateVerdict =
  | 'blocked_sms_disabled'
  | 'blocked_suppressed'
  | 'blocked_timezone_unknown'
  | 'blocked_calling_window'
  | 'blocked_recording_unverified'

export async function dialFor(
  identity: SessionIdentity,
  input: { contactId: string },
): Promise<DialOutcome> {
  // §3's gate. Only the `verified` variant has `.call`, so an unverified
  // capability cannot be dialled — not by policy, by type.
  await ensureCapabilities()
  const capability = alowareCapability('two_legged_call')
  if (capability.status !== 'verified') {
    return { status: 'blocked', reason: 'no_capability' }
  }

  const target = await withTenant(identity, async (tx) => {
    // Owner-scoped, and RLS scopes it a second time. A contact in another
    // seller's book is indistinguishable from one that does not exist — never a
    // 403, which would confirm the record is real.
    const rows = await tx.execute<{ phone_e164: string | null }>(sql`
      SELECT p.phone_e164
        FROM app.contact c
        LEFT JOIN app.contact_phone p
               ON p.tenant_id = c.tenant_id AND p.contact_id = c.id
       WHERE c.tenant_id = app.current_tenant()
         AND c.id = ${input.contactId}::uuid
       ORDER BY p.is_primary DESC NULLS LAST
       LIMIT 1`)
    return rows[0]
  })

  if (target === undefined) return { status: 'blocked', reason: 'not_found' }
  if (target.phone_e164 === null) return { status: 'blocked', reason: 'no_phone' }

  // ==========================================================================
  // 🔴 THE ONE OUTBOUND COMPLIANCE GATE. MVP item 11, and until this line it
  // had ZERO production callers.
  // ==========================================================================
  // `app.compliance_check` has been complete since 0038 — five verdicts in a
  // fixed order, break-glass releasing exactly two of them, its own ownership
  // predicate because a definer has no RLS — and nothing in `app/` called it.
  // A gate nobody consults is a document, and this is the surface it exists to
  // stand in front of.
  //
  // BEFORE THE NUMBER MAPPING, and the order is the point. If a seller has no
  // verified caller ID AND the lead is on a STOP, "set up your Aloware number"
  // is the wrong sentence: it tells them to fix a setting so they can make a
  // call they must never make. The legally binding refusal wins.
  //
  // THE VERDICT AND THE AUDIT ROW COMMIT TOGETHER. US-9.13 requires one audit
  // row per ATTEMPT, unbucketed — N dials under break-glass are N rows. Two
  // statements in one transaction means a crash cannot leave a dial that
  // happened with no record of the verdict that let it through.
  const gate = await withTenant(identity, async (tx) => {
    const rows = await tx.execute<{
      verdict: 'allow' | GateVerdict
      event_verdict: string | null
      override_id: string | null
      zones: string[] | null
    }>(sql`
      SELECT verdict::text AS verdict, event_verdict, override_id, zones
        FROM app.compliance_check(${input.contactId}::uuid, 'call'::app.channel)`)

    const row = rows[0]
    if (row === undefined) return undefined

    // The snapshot is what makes the row a defence rather than an assertion:
    // "the gate said no" is not an answer eighteen months later, and "the gate
    // said no, and these were the zones it resolved and the override it saw"
    // is. Written for ALLOW as well as for refusals — a permitted dial under
    // break-glass is exactly the row somebody will ask about.
    await tx.execute(sql`
      SELECT app.audit_write(
        'compliance.gate_checked', 'contact', ${input.contactId}::uuid,
        NULL, NULL, NULL,
        ${row.verdict}::app.gate_verdict,
        ${JSON.stringify({
          channel: 'call',
          event_verdict: row.event_verdict,
          zones: row.zones ?? [],
        })}::jsonb,
        ${row.override_id}::uuid, NULL, 'human'::app.actor_type, 0)`)

    return row
  })

  // Fails CLOSED. A gate that returned nothing is a gate that did not answer,
  // and the correct reading of no answer is refusal — the same direction the
  // chain itself takes for an unresolvable timezone.
  if (gate === undefined) {
    return {
      status: 'refused',
      verdict: 'blocked_timezone_unknown',
      eventVerdict: 'unknown_timezone',
      zones: [],
    }
  }

  if (gate.verdict !== 'allow') {
    return {
      status: 'refused',
      verdict: gate.verdict,
      eventVerdict: gate.event_verdict,
      zones: gate.zones ?? [],
    }
  }

  const mapping = await withTenant(identity, async (tx) => {
    // ⚠️ THE OWNER PREDICATE HERE IS LOAD-BEARING, unlike everywhere else in
    // this codebase. `aloware_number_mapping` is classified `tenant_scoped_read`
    // rather than `owner_scoped` — that is what buys it a SELECT-only grant, and
    // the cost is that RLS scopes reads to the TENANT. Every other query in this
    // tree can treat its owner clause as a second layer because the policy
    // already applied one. This one cannot: drop the clause and a seller dials
    // presenting a colleague's caller ID.
    //
    // `verified_at IS NOT NULL` is the other half. ADR-042's three-way
    // verification is not built, so the column is the only thing standing
    // between a seeded row and a number nobody confirmed this seller holds.
    const rows = await tx.execute<{
      aloware_user_id: string
      aloware_line_id: string
      from_number_e164: string
    }>(sql`
      SELECT aloware_user_id::text, aloware_line_id::text, from_number_e164
        FROM app.aloware_number_mapping
       WHERE tenant_id = app.current_tenant()
         AND owner_user_id = app.current_user_id()
         AND revoked_at IS NULL
         AND verified_at IS NOT NULL
       LIMIT 1`)
    return rows[0]
  })

  // The first-run checklist's item 1, as a sentence the seller can act on.
  if (mapping === undefined) return { status: 'blocked', reason: 'no_number' }

  // 🔴 WHERE THE DIAL WOULD GO, and the last thing standing in front of it.
  //
  // Everything the provider needs is now resolved: Gate G2 established that the
  // two-legged endpoint takes `line_id` AND `user_id` per call, so this seller's
  // own caller ID is reachable rather than aspirational.
  //
  // Two things are missing and BOTH resolve to the same answer today, so this
  // is one return rather than a check whose branches are identical:
  //
  //   1. `ALOWARE_API_TOKEN` is not in the environment.
  //   2. The dial adapter is not written. `CapabilityCall` types every member
  //      `never`, so `capability.call` cannot be invoked — the adapter has to
  //      arrive carrying the `RequestScoped` token P3.1 requires, and widening
  //      that type is the change that admits it.
  //
  // Every two-legged dial is billable, so (2) is a change somebody makes on
  // purpose rather than one that happens because a token appeared.
  return { status: 'blocked', reason: 'no_credentials' }
}

export async function action({ request }: { request: Request }): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }

  const identity = await requireIdentity(request)
  const form = await request.formData()
  const contactId = form.get('contactId')

  if (typeof contactId !== 'string' || contactId.length === 0) {
    return Response.json({ status: 'blocked', reason: 'not_found' } satisfies DialOutcome, {
      status: 400,
      headers: { 'cache-control': 'private, no-store' },
    })
  }

  const outcome = await dialFor(identity, { contactId })

  // Always 200 with a typed outcome, never a status code the client has to
  // interpret. The seller-visible difference between "no agent" and "provider
  // down" is a sentence, and a sentence is data — a 4xx/5xx would make the
  // browser's own error handling the thing that decides what they read.
  return Response.json(outcome, {
    status: 200,
    headers: { 'cache-control': 'private, no-store' },
  })
}
