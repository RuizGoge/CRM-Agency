import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  foreignKey,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { app, bytea } from './_shared'
import { appUser } from './tenant'

/**
 * `app.aloware_number_mapping` — seller ↔ Aloware seat ↔ outbound number.
 *
 * §5 and US-601. **One number, exactly one seller; one live mapping per
 * seller** — and both are partial unique indexes rather than a rollout
 * checklist, because a shared outbound line means two sellers' callbacks land
 * on one number and neither owns the lead that rings back.
 *
 * Gate G2 made this buildable and also made it necessary: the two-legged dial
 * takes `line_id` AND `user_id` **per call**, so per-seller caller ID is real
 * rather than aspirational. Until this table has a row, `POST /api/calls`
 * refuses with `no_number` — which is the honest answer and also the first-run
 * checklist's item 1.
 *
 * 🔴 AND IT CONTRADICTS WHAT THE ACCOUNT ACTUALLY DOES, which is recorded here
 * rather than designed around. The client runs a **58-number Local Presence
 * pool** (line `65123`), and a rotating pool has no stable number-to-seller
 * binding at all. Two things soften it and neither resolves it:
 *
 *   - **Outbound is fine.** The dial carries an explicit `user_id`, so
 *     attribution never has to come from the number.
 *   - **`06-conversations.md` CUT local presence** — *"the regulatory and
 *     carrier-reputation risk is not ours to take"* — a ruling made without
 *     knowing the client already runs it.
 *
 * What stays genuinely open is **inbound**: a callback to a pool number has no
 * owner under `aloware_number_mapping_number_uidx`. This table models the
 * design as signed; the pool is a fact the design has not answered yet.
 */
export const alowareNumberMapping = app.table(
  'aloware_number_mapping',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    /** The seller. `owner_scoped` policy hangs off this column by name. */
    ownerUserId: uuid('owner_user_id').notNull(),

    /**
     * Their seat in Aloware. `120776` on the captured account. This is the
     * value the dial sends as `user_id`, and it is what G2 verified carries
     * per-seller attribution on both calls and SMS — the join that makes the
     * silo buildable on REST rather than on the number.
     */
    alowareUserId: bigint('aloware_user_id', { mode: 'number' }).notNull(),

    /**
     * The line to dial FROM. Aloware calls it a "campaign" in webhook payloads
     * and a `line_id` in the API; `63949` is the Test Line on this account.
     * Stored per mapping because the dial takes it per call.
     */
    alowareLineId: bigint('aloware_line_id', { mode: 'number' }).notNull(),

    /** The E.164 the lead sees. */
    fromNumberE164: text('from_number_e164').notNull(),

    /**
     * When the three-way verification completed (ADR-042).
     *
     * ⚠️ NULLABLE, and a NULL mapping must never dial. The verification flow
     * itself is not built — what exists is the column and the predicate that
     * reads it, so an unverified row is inert rather than absent. A seller
     * presenting a number nobody confirmed they hold is the failure this
     * column names.
     */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),

    /** Soft revocation. Both unique indexes are partial on this being NULL. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    // Composite, like every foreign key in this schema: a cross-tenant
    // reference has to be structurally impossible to write, not merely
    // unlikely. A single-column FK to `app_user.id` would let tenant A's
    // mapping point at tenant B's seller and every CHECK here would pass.
    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'aloware_number_mapping_owner_fk',
    }),
    /**
     * §5's first index. One number belongs to exactly one seller at a time.
     * Partial on `revoked_at` so a number can be reassigned after revocation —
     * which is what happens when a seller leaves.
     */
    uniqueIndex('aloware_number_mapping_number_uidx')
      .on(t.tenantId, t.fromNumberE164)
      .where(sql`${t.revokedAt} IS NULL`),
    /** §5's second. One live mapping per seller — no seller has two numbers. */
    uniqueIndex('aloware_number_mapping_owner_uidx')
      .on(t.tenantId, t.ownerUserId)
      .where(sql`${t.revokedAt} IS NULL`),
    // E.164 or it is not a number we can dial. Checked here because the value
    // arrives from an admin surface and from a seed, and neither is a place a
    // format promise survives.
    check('aloware_number_mapping_e164', sql`${t.fromNumberE164} ~ '^\\+[1-9][0-9]{7,14}$'`),
    // A revoked mapping cannot be revoked before it was created. Cheap, and it
    // catches the backdated row a hand-written correction produces.
    check(
      'aloware_number_mapping_revoked_after_created',
      sql`${t.revokedAt} IS NULL OR ${t.revokedAt} >= ${t.createdAt}`,
    ),
  ],
)

/**
 * `app.raw_payload_vault` — the bytes, exactly as they arrived (ARR-INT-04).
 *
 * The edge stores first and understands later. A body lands here before anything
 * parses it, so a mapping bug is a row we can replay rather than a delivery that
 * is gone — and Gate G2 made that load-bearing in a way it was not before:
 * **Aloware never retries**, so anything the edge fails to keep is lost forever.
 *
 * 🚨 IT IS ALSO A STORE OF BEARER TOKENS TO CALL AUDIO, which is not what the
 * name suggests. `Recording-Saved` carries `direct_recording_url`, and a HEAD
 * with no credentials 302s to a one-hour pre-signed S3 link to the recording.
 * Anyone with read access here, or to a database backup, can pull audio. The
 * 30–90 day purge was adopted for CCPA minimisation; it now also bounds this,
 * which is a reason not to lengthen it.
 */
export const rawPayloadVault = app.table(
  'raw_payload_vault',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    provider: text('provider').notNull(),

    /** Raw bytes. Never decoded, re-encoded or normalised — see the digest. */
    body: bytea('body').notNull(),

    /**
     * `sha256(body)`, and the reason it is a column rather than a computation is
     * §4.4: with no delivery id and no event id anywhere in Aloware's envelope,
     * this digest IS `provider_event_id`. The no-signature finding then promotes
     * the unique index built on it from an idempotency convenience to **the only
     * replay defence that exists**.
     */
    bodySha256: bytea('body_sha256').notNull(),

    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    /**
     * When this row becomes purgeable. §4.6 specifies purge by PARTITION DROP;
     * this table is not partitioned yet, so the column is the honest interim —
     * it records the intent and lets a purge job be written, and converting to
     * declarative partitioning later is a migration rather than a redesign.
     */
    purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    // Same property as `capability_probe`, same reason: the row is internally
    // consistent at INSERT rather than at a check nobody runs.
    check('raw_payload_vault_digest_matches', sql`${t.bodySha256} = sha256(${t.body})`),
    check('raw_payload_vault_body_present', sql`length(${t.body}) > 0`),
    check('raw_payload_vault_purge_after_receipt', sql`${t.purgeAfter} > ${t.receivedAt}`),
  ],
)

/**
 * `app.inbound_webhook_event` — one row per delivery, and the transport rung of
 * §4.4's idempotency ladder.
 *
 * `UNIQUE (tenant_id, provider, provider_event_id)` is what lets a replay storm
 * land without touching the domain: the second delivery of the same bytes is a
 * constraint violation answered `204` in under a millisecond.
 *
 * 🔴 AND IT IS A SECURITY CONTROL, NOT ONLY A PERFORMANCE ONE. Aloware's webhook
 * form offers `None · Basic · Bearer` and no HMAC, so nothing in a delivery
 * proves freshness and a captured request replays forever. This index is the
 * only thing standing between that request and unlimited replay.
 */
export const inboundWebhookEvent = app.table(
  'inbound_webhook_event',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    provider: text('provider').notNull(),

    /**
     * Hex `sha256` of the raw body. **Built rather than received:** the envelope
     * is `{ body, event }` and carries no `event_id`, no `delivery_id` and no
     * `webhook_id`, in headers or body. G2 went looking and found none.
     *
     * ⚠️ Its one weakness, observed rather than theorised: two genuinely distinct
     * deliveries with byte-identical bodies collide. The provider's own
     * `{"test_payload":true}` arrived twice, seven hours apart, with the same
     * digest. Harmless there — real call bodies carry `id`, `created_at` and
     * `updated_at` — but it is why this is the honest key and not a perfect one.
     */
    providerEventId: text('provider_event_id').notNull(),

    /** The bytes this row describes. Retained by reference, never copied. */
    rawPayloadId: uuid('raw_payload_id').notNull(),

    /** Filled by the shallow extractor. NULL when the body did not parse. */
    providerEvent: text('provider_event'),
    alowareCallId: text('aloware_call_id'),

    /**
     * `'parsed'` or `'unparsed'`. The row is stored either way — a parser that
     * refused would turn a mapping bug into permanent data loss.
     */
    parseStatus: text('parse_status').notNull(),

    /**
     * 🔴 NULLABLE, AND THE NAME IS NOW WRONG ON PURPOSE. §4.2 ruling 3 made it
     * nullable because the spike had not established whether Aloware signs, and
     * a `NOT NULL` column would force us to record a lie. **The spike answered:
     * there is no signature.** With `Bearer` configured this records CREDENTIAL
     * validity, which is a strictly weaker claim than the column name suggests —
     * it proves the caller holds a static secret, never that the body is
     * untampered and never that the request is fresh. Renaming it is a migration
     * nobody has decided on; until then this comment is what stops a future
     * reader from over-trusting a payload.
     */
    signatureValid: boolean('signature_valid'),

    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.rawPayloadId],
      foreignColumns: [rawPayloadVault.tenantId, rawPayloadVault.id],
      name: 'inbound_webhook_event_payload_fk',
    }),
    uniqueIndex('inbound_webhook_event_transport_uidx').on(
      t.tenantId,
      t.provider,
      t.providerEventId,
    ),
    check('inbound_webhook_event_parse_status', sql`${t.parseStatus} IN ('parsed', 'unparsed')`),
    // 64 hex characters or it is not a sha256, and a truncated key would collide
    // across unrelated deliveries — which on this index means silently dropping
    // a real event as a duplicate.
    check('inbound_webhook_event_digest_shape', sql`${t.providerEventId} ~ '^[0-9a-f]{64}$'`),
  ],
)
