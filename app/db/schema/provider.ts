import { sql } from 'drizzle-orm'
import { check, jsonb, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { app, bytea, ref } from './_shared'

/**
 * The provider capability registry and its evidence — §7.3 and errata **E9**.
 *
 * Aloware's capability set is UNVERIFIED (ARR-INT-02). The design therefore
 * refuses to model capabilities as functions that exist: they are rows with a
 * verification state, and the type system will not let an unverified capability
 * be called. This file is the data half of that.
 *
 * ⚠️ PRECEDENCE. `05c-closure-register.md` §7.7.6 carries a DDL for
 * `ref.capability_probe` with `raw_payload_id uuid NOT NULL` pointing into
 * `raw_payload_vault`, and a boot assertion comparing the digest against that
 * table. **E9 struck it** — rank 1, and it outranks every other document. The
 * vault purges by partition drop on a 30–90 day window, so one to three months
 * after the Gate-2 spike the probe bodies would be gone, the assertion could not
 * be satisfied by any value, and production would exit non-zero on every start
 * while development and CI stayed green the whole way. What ships instead:
 *
 *   - `response_body bytea NOT NULL` in the probe's own row, on its own clock;
 *   - **no `raw_payload_id`**, so this table depends on no other's retention;
 *   - the digest compared against `sha256(response_body)` IN THE SAME ROW.
 *
 * And the rule that comes with it, which is a constraint on how the spike is
 * RUN and not just on what it stores: **probes are captured against synthetic
 * subjects only, never a real consumer.** This row is never purged, so a real
 * lead's number captured here would acquire a permanent clock — which is
 * exactly the CCPA minimisation the vault's short window exists to provide.
 */

/**
 * One label. A second provider is `ALTER TYPE ... ADD VALUE`, which is a
 * migration and a deploy gate — see 0006 on why that statement is handled
 * carefully. The product integrates with Aloware and nothing else.
 */
export const provider = app.enum('provider', ['aloware'])

/**
 * `unknown` is the default state and the honest one. A capability is never
 * assumed present because the vendor's documentation says so; §7.3's whole
 * construction exists because the corpus never established that Aloware signs
 * webhooks, retries them, or preserves order.
 */
export const capabilityStatus = app.enum('capability_status', ['unknown', 'verified', 'absent'])

/**
 * What breaks if the spike returns `absent`. `mvp_required` is load-bearing:
 * the boot assertion refuses to start production while one of them is
 * unverified, which turns "no dependent UI may be built until the spike proves
 * it" from a process rule a model will not remember into a deploy that will not
 * start.
 */
export const capabilityTier = app.enum('capability_tier', [
  'mvp_required',
  'mvp_optional',
  'probe_only',
])

/**
 * A captured provider exchange. Append-only by trigger — to `crm_app`, to the
 * owner and to a superuser alike — because a probe that can be edited after the
 * fact is a probe that can be edited into agreement with whatever someone
 * wishes were true.
 *
 * ⚠️ WHAT THIS IS NOT, said plainly rather than implied: it is **not
 * unforgeable**. Anyone who can write this table can invent a body and store
 * `sha256()` of their invention alongside it, and the CHECK will pass. What the
 * digest buys is that the row is internally consistent and that fabricating a
 * verification now costs a fabricated *document* instead of the word `'spike'`
 * in a free-text column — which is the specific failure §7.7.6 names. The
 * property that carries real weight is upstream of the hash: `crm_app` holds
 * SELECT and nothing else on this table (the `reference` policy class grants no
 * INSERT to the app role at all), so **no application code path can mint one**.
 * A probe is written by a migration or out of band, and rendered to a human at
 * `/admin/integration-health`.
 */
export const capabilityProbe = ref.table(
  'capability_probe',
  {
    probeId: uuid('probe_id')
      .primaryKey()
      .default(sql`uuidv7()`),

    provider: provider('provider').notNull(),

    /** Free text on purpose: the vocabulary is §7.3's table, not an enum. A
     *  capability probed but not yet registered is still evidence. */
    capability: text('capability').notNull(),

    httpStatus: smallint('http_status').notNull(),

    /** E9: the body itself, in this row, on this table's clock. */
    responseBody: bytea('response_body').notNull(),

    /** E9: compared against sha256(response_body) in the same row. */
    responseDigest: bytea('response_digest').notNull(),

    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),

    /**
     * Which spike run produced this. Same reason `ci_ratchet.set_by_run` is
     * NOT NULL: a measurement with no run behind it is an assertion.
     */
    probeRun: text('probe_run').notNull(),

    /** What was asked. The bearer token travels in a header and is never
     *  stored; the prober strips secret-bearing query parameters before it
     *  writes, because this row outlives every retention window in the system. */
    requestMethod: text('request_method').notNull(),
    requestUrl: text('request_url').notNull(),
  },
  (t) => [
    // E9's property, as an engine refusal at INSERT rather than as a boot
    // check months later. sha256() is immutable, so it is legal in a CHECK.
    check('capability_probe_digest_matches', sql`${t.responseDigest} = sha256(${t.responseBody})`),
    // A `verified` backed by an empty body is the free-text hole reopened —
    // except where HTTP itself defines no body. 204 and 304 are carved out by
    // status and by nothing else: without the carve-out a provider that answers
    // `204 No Content` could not be recorded at all, and a prober that cannot
    // store what it received is a prober under pressure to invent something it
    // can. An empty body under a 200 stays refused, which is the case that
    // would actually be somebody fabricating.
    check(
      'capability_probe_body_present',
      sql`length(${t.responseBody}) > 0 OR ${t.httpStatus} IN (204, 304)`,
    ),
    check('capability_probe_run_present', sql`length(btrim(${t.probeRun})) > 0`),
    check('capability_probe_http_status_range', sql`${t.httpStatus} BETWEEN 100 AND 599`),
  ],
)

/**
 * A captured provider DELIVERY — the inbound counterpart of `capability_probe`.
 *
 * 🔴 WHY THIS TABLE EXISTS AT ALL. Gate G2 captured 20 real webhook deliveries,
 * which is stronger evidence than any probe, and `webhook_subscription` still
 * could not be promoted: `capability_probe` models an OUTBOUND request and its
 * response, and a webhook is INBOUND. Shoehorning one into the other means
 * `request_url` holding OUR url, `response_body` holding THEIR request, and
 * `http_status` holding what WE answered — three columns each saying the
 * opposite of their name. Migration 0030 recorded that hole rather than papering
 * over it by inventing a probe that never happened; this is the shape that was
 * missing.
 *
 * The guarantees are deliberately identical to the probe's: `reference` class so
 * `crm_app` holds SELECT and nothing else, `immutable` so the refusal binds the
 * owner and a superuser too, and a digest CHECK so the row is internally
 * consistent at INSERT rather than at a boot check months later.
 *
 * ⚠️ AND ONE GUARANTEE THAT IS DELIBERATELY NOT COPIED: there is no 2xx
 * requirement. On the outbound side a 2xx is the provider saying the endpoint
 * exists. On the inbound side OUR response status says nothing about their
 * ability to deliver — G2 proved that directly by answering `500` to six real
 * deliveries, all of which had already been delivered. Requiring 2xx here would
 * be outbound reasoning copied across a boundary where it does not hold, and it
 * would have refused exactly the evidence that answered assertion (c).
 */
export const capabilityDelivery = ref.table(
  'capability_delivery',
  {
    deliveryId: uuid('delivery_id')
      .primaryKey()
      .default(sql`uuidv7()`),

    provider: provider('provider').notNull(),

    /** Free text, same as the probe: the vocabulary is §7.3's table, not an enum. */
    capability: text('capability').notNull(),

    /** When the delivery ARRIVED. Not when somebody wrote the migration. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),

    requestMethod: text('request_method').notNull(),

    /**
     * The path only. Never the origin: the Gate-2 receiver sat behind an
     * ephemeral `trycloudflare` hostname, and a permanent row naming a
     * recyclable public hostname is a durable pointer at somebody else's
     * server.
     */
    requestPath: text('request_path').notNull(),

    /**
     * Every header, verbatim and in order, as a flat array of alternating
     * name/value strings so duplicates survive. A normalised object would have
     * destroyed the evidence for assertion (b) — that Aloware sends six headers
     * and none of them is a signature, a timestamp or a nonce.
     */
    requestHeaders: jsonb('request_headers').notNull(),

    /** The bytes exactly as they arrived. */
    requestBody: bytea('request_body').notNull(),
    requestDigest: bytea('request_digest').notNull(),

    /** What we answered. Recorded as a fact, never as a precondition — see above. */
    responseStatus: smallint('response_status').notNull(),

    probeRun: text('probe_run').notNull(),

    /**
     * The outbound action that CAUSED this delivery, when there was one.
     *
     * Nullable because the strongest available evidence for
     * `webhook_subscription` has no cause: it is the provider's own
     * `Save and Test Webhook`, triggered from the panel. When a cause does
     * exist the pair is a closed loop — we did X, they told us about X — which
     * is what ARR-EVT-25's correlation question is really asking.
     */
    causedByProbeId: uuid('caused_by_probe_id').references(() => capabilityProbe.probeId),
  },
  (t) => [
    check('capability_delivery_digest_matches', sql`${t.requestDigest} = sha256(${t.requestBody})`),
    // No 204/304 carve-out, unlike the probe. HTTP defines those as bodiless
    // RESPONSES; a delivery with no body is not evidence that a provider can
    // deliver anything.
    check('capability_delivery_body_present', sql`length(${t.requestBody}) > 0`),
    check('capability_delivery_run_present', sql`length(btrim(${t.probeRun})) > 0`),
    check(
      'capability_delivery_response_status_range',
      sql`${t.responseStatus} BETWEEN 100 AND 599`,
    ),
    // Aloware's webhook form offers `None | Basic | Bearer`, so a subscription
    // configured with either of the latter echoes a STATIC CREDENTIAL back to us
    // in a header — and this row outlives every retention window in the system.
    // A comment saying "remember to redact" is documentation; this is a refusal.
    // Crude on purpose: a substring test over the serialised headers is legal in
    // a CHECK, where a subquery is not.
    check(
      'capability_delivery_headers_redacted',
      sql`lower(${t.requestHeaders}::text) NOT LIKE '%"authorization"%'
          AND lower(${t.requestHeaders}::text) NOT LIKE '%"cookie"%'`,
    ),
  ],
)

/**
 * The registry §7.3 specifies. `crm_app` can read it and cannot write it, so a
 * capability is promoted by a migration or by the owner's console — never by
 * the running application.
 */
export const providerCapability = ref.table(
  'provider_capability',
  {
    provider: provider('provider').notNull(),
    capability: text('capability').notNull(),
    status: capabilityStatus('status').notNull().default('unknown'),
    tier: capabilityTier('tier').notNull(),

    verifiedAt: timestamp('verified_at', { withTimezone: true }),

    /**
     * E9/§7.7.6: the free-text `evidence_ref` is gone. A migration seeding
     * `evidence_ref = 'spike'` satisfied the old CHECK; a foreign key to a
     * captured exchange does not.
     */
    evidenceProbeId: uuid('evidence_probe_id').references(() => capabilityProbe.probeId),

    /**
     * The inbound half. A capability is evidenced by an outbound exchange we
     * made or by an inbound delivery we received, never by both and never by
     * neither — see `capability_verified_needs_evidence` below.
     */
    evidenceDeliveryId: uuid('evidence_delivery_id').references(
      () => capabilityDelivery.deliveryId,
    ),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.capability] }),
    /**
     * Was `capability_verified_needs_probe`, which could only ever be satisfied
     * by an outbound probe — the constraint that made `webhook_subscription`
     * unpromotable no matter how much evidence existed.
     *
     * `num_nonnulls(...) = 1` rather than a pair of OR'd clauses, because
     * "exactly one" is the property: a row pointing at BOTH a probe and a
     * delivery claims two different things proved the same capability, and the
     * one somebody would later read is whichever the query happened to join.
     */
    check(
      'capability_verified_needs_evidence',
      sql`${t.status} <> 'verified'
          OR (num_nonnulls(${t.evidenceProbeId}, ${t.evidenceDeliveryId}) = 1
              AND ${t.verifiedAt} IS NOT NULL)`,
    ),
    // An unverified row carries no evidence at all. Without this, a capability
    // downgraded to `absent` keeps a dangling pointer at the exchange that used
    // to prove it, which reads on the health screen as evidence for a claim
    // nobody is making any more.
    check(
      'capability_unverified_has_no_evidence',
      sql`${t.status} = 'verified'
          OR num_nonnulls(${t.evidenceProbeId}, ${t.evidenceDeliveryId}) = 0`,
    ),
    // A capability downgraded from `verified` must not keep its timestamp. A
    // stale `verified_at` under `absent` reads, on the health screen, as a
    // capability that used to work — which is a different claim from the truth.
    check(
      'capability_unverified_has_no_timestamp',
      sql`${t.status} = 'verified' OR ${t.verifiedAt} IS NULL`,
    ),
  ],
)
