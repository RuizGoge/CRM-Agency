import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { contact } from './contacts'
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
 * The two states a call has, and there are exactly two.
 *
 * 🔴 `connected` IS ABSENT AND ITS ABSENCE IS MEASURED. §6.1 specified a live
 * `connected · {timer}` row on the call banner. Gate G2 recorded **70.4 seconds
 * of total webhook silence** across a call with 63 seconds of conversation:
 * between `OutboundPhoneCall` and `OutboundPhoneCall-DispositionCompleted` the
 * provider emits nothing at all. The entire live portion of a call has **no
 * source**, so the state was struck by Jorge's decision rather than built
 * against nothing. The banner keeps the two states the provider actually
 * reports. The channel thins; it does not fall over.
 */
export const CALL_STATES = ['initiated', 'completed'] as const
export type CallState = (typeof CALL_STATES)[number]

/**
 * The ordinal each state carries, and the pair is CHECKed against itself.
 *
 * Gapped rather than 1/2 so a state discovered later can land between two
 * without renumbering rows that already exist — renumbering is what would make
 * the monotonic trigger compare a new scale against an old one.
 */
export const CALL_STATE_ORDINAL: Readonly<Record<CallState, number>> = {
  initiated: 10,
  completed: 90,
}

/**
 * `app.call` — one row per provider communication, merged and never inserted
 * twice (ARR-INT-06).
 *
 * `UNIQUE (tenant_id, aloware_call_id)` is §4.4's second rung. Every webhook
 * about one call lands on the same row: the disposition, the recording, the
 * transcript and the AI summary arrive as four separate deliveries, minutes
 * apart and in no guaranteed order.
 *
 * 🔴 THERE IS NO `disposition_canonical`, AND THAT IS US-604 ENFORCED BY
 * ABSENCE. The provider's own disposition is kept as `disposition_raw` and is
 * **enrichment only** — the semantic outcome comes from our wrap-up sheet.
 * G2 is why this is not a matter of taste: the captured call carries
 * `call_disposition_id = 31227`, which is **"No Answer"**, on a call with
 * **63 seconds of talk time**, and nobody set it by hand. A column here called
 * `disposition_canonical` would invite exactly one line of code mapping that
 * lie into the seller's book.
 *
 * ⚠️ `owner_user_id` IS NULLABLE AND NULL MEANS QUARANTINED. §5 gives owner
 * resolution four outcomes and only one of them writes to a book. A call we
 * cannot attribute is stored with a NULL owner, which under the `owner_scoped_read`
 * policy is visible to **nobody** — never guessed into somebody's book, never
 * dropped. That is the failure the Local Presence pool makes real: a callback to
 * one of 58 rotating numbers has no owner under
 * `aloware_number_mapping_number_uidx`.
 */
export const call = app.table(
  'call',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    /**
     * Aloware's communication id. Text, not bigint: G2 established the same id
     * space carries SMS, and `idOf` in the extractor already refuses to let an
     * id larger than 2^53 round through JSON into a number.
     */
    alowareCallId: text('aloware_call_id').notNull(),

    /** The seller. NULL is quarantine — see the note above. */
    ownerUserId: uuid('owner_user_id'),

    /** The lead, when a phone matched inside the owner's book. */
    contactId: uuid('contact_id'),

    direction: text('direction'),

    state: text('state').notNull(),
    /** Monotonic by trigger. A late `initiated` can never regress a `completed`. */
    stateOrdinal: smallint('state_ordinal').notNull(),

    // --- corrective fields: newer provider state wins, by the provider's clock
    /** The provider's disposition, verbatim. Enrichment, never the outcome. */
    dispositionRaw: text('disposition_raw'),
    talkTimeSeconds: integer('talk_time_seconds'),
    waitTimeSeconds: integer('wait_time_seconds'),

    // --- additive fields: COALESCE(new, old), so a late arrival cannot erase
    /**
     * 🚨 A BEARER TOKEN, not a link. G2 measured that a HEAD with no credentials
     * of any kind 302s to a one-hour pre-signed S3 URL of the recording. Anyone
     * with read access to this column, or to a backup, can pull the audio.
     */
    recordingUrl: text('recording_url'),
    transcriptUrl: text('transcript_url'),
    aiSummaryText: text('ai_summary_text'),

    /** The provider's own creation clock, not ours. */
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }),
    /**
     * The newest provider timestamp merged into this row. Corrective fields are
     * guarded by THIS rather than by arrival order — §4.5's whole out-of-order
     * tolerance rests on it, because the queue serializes deliveries but cannot
     * reorder what the provider sent late.
     */
    providerLastEventAt: timestamp('provider_last_event_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'call_owner_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contact.tenantId, contact.id],
      name: 'call_contact_fk',
    }),
    /** §4.4 rung 2. Merge, never insert. */
    uniqueIndex('call_aloware_id_uidx').on(t.tenantId, t.alowareCallId),
    /**
     * What the day strip counts. Dials, contacts and appointments-set are the
     * only numbers that move before a seller's first sale.
     */
    index('call_owner_recent_idx').on(t.tenantId, t.ownerUserId, t.providerCreatedAt),
    check(
      'call_direction',
      sql`${t.direction} IS NULL OR ${t.direction} IN ('inbound', 'outbound')`,
    ),
    /**
     * 🎯 THE STATE AND ITS ORDINAL CANNOT DISAGREE. Without this the ordinal is
     * a second source of truth for the same fact, and the monotonic trigger
     * reads the ordinal while every screen reads the state — so a row could sort
     * as `completed` and render as `initiated` with nothing anywhere failing.
     */
    check(
      'call_state_ordinal_agree',
      sql`(${t.state} = 'initiated' AND ${t.stateOrdinal} = 10)
          OR (${t.state} = 'completed' AND ${t.stateOrdinal} = 90)`,
    ),
    check(
      'call_durations_non_negative',
      sql`(${t.talkTimeSeconds} IS NULL OR ${t.talkTimeSeconds} >= 0)
          AND (${t.waitTimeSeconds} IS NULL OR ${t.waitTimeSeconds} >= 0)`,
    ),
  ],
)

/**
 * The two states a message has, and there are exactly two because exactly two
 * are measured.
 *
 * §4.3 maps the SMS webhooks onto `message.received` and
 * `message.delivery_failed`, and the capture contains one SMS delivery:
 * `OutboundSMS-DispositionInvalid` (`current_status2: 19`,
 * `disposition_status2: 7` — the message was never delivered).
 *
 * ⚠️ `sent` AND `delivered` ARE ABSENT ON PURPOSE. No webhook in the capture
 * reports a successful send, so a `delivered` state would be a value nothing
 * can ever write — and a state machine with an unreachable terminal is how a
 * screen ends up showing "Sending…" for ever. They arrive when a successful
 * send is observed against the real account, not before.
 */
export const MESSAGE_STATES = ['received', 'failed'] as const
export type MessageState = (typeof MESSAGE_STATES)[number]

/**
 * `app.message` — §4.4's third rung, keyed on `provider_message_id`.
 *
 * 🔴 THAT KEY LIVES IN THE SAME ID SPACE AS `aloware_call_id`, WHICH §4.4
 * ASSUMED WERE TWO SPACES. G2 established that Aloware's `body.id` is a
 * *communication* id: a call and an SMS are the same kind of object with the
 * same id sequence. The ladder still works — two tables, two unique indexes —
 * but a reader who assumes an id can only be one of the two will write a join
 * that silently matches nothing.
 *
 * ⚠️ `body_text` IS THE COMPLIANCE SURFACE, not just content. Residual risk R5
 * is that a STOP keyword arriving base64-encoded, or outside the first 320 raw
 * bytes, misses the opt-out lane — and this column is where that sniff will
 * have to read from. Nothing here implements it: STOP belongs to the consent
 * module, and a half-implemented opt-out is worse than an absent one because it
 * looks handled.
 */
export const message = app.table(
  'message',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    /** Aloware's communication id — see the note above about the shared space. */
    providerMessageId: text('provider_message_id').notNull(),

    /** NULL is quarantine, exactly as on `call`. Written to no book, never guessed. */
    ownerUserId: uuid('owner_user_id'),
    contactId: uuid('contact_id'),

    direction: text('direction'),
    state: text('state').notNull(),

    /** What the lead or the seller actually wrote. */
    bodyText: text('body_text'),
    /** Why a delivery failed, in the provider's words. */
    failureReason: text('failure_reason'),

    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }),
    providerLastEventAt: timestamp('provider_last_event_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'message_owner_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contact.tenantId, contact.id],
      name: 'message_contact_fk',
    }),
    /** §4.4 rung 3. Merge, never insert. */
    uniqueIndex('message_provider_id_uidx').on(t.tenantId, t.providerMessageId),
    index('message_owner_recent_idx').on(t.tenantId, t.ownerUserId, t.providerCreatedAt),
    check(
      'message_direction',
      sql`${t.direction} IS NULL OR ${t.direction} IN ('inbound', 'outbound')`,
    ),
    check('message_state', sql`${t.state} IN ('received', 'failed')`),
  ],
)

/**
 * `app.webhook_endpoint` — the credential Aloware presents, and the ONLY thing
 * that produces a tenant at the ingest edge.
 *
 * §4.1: *"Both resolve the tenant **from the token**, never from a phone number
 * and never from a header."* A delivery arrives with no session, no cookie and
 * no user — `app.current_tenant()` is NULL for the entire request — so the
 * tenant has to come from somewhere, and every other candidate is a guess. The
 * number is the worst of them: a number that is not in the identity map has no
 * tenant at all, so inference would be a guess on the hot path of every single
 * inbound event.
 *
 * 🔴 THE TOKEN INDEX IS GLOBAL, NOT COMPOSITE, AND THAT IS THE ONE PLACE IN
 * THIS SCHEMA WHERE THAT IS CORRECT. Every other unique index in this database
 * leads with `tenant_id` because a cross-tenant reference must be impossible to
 * write. Here the token is what *produces* the tenant, so scoping its
 * uniqueness by tenant would permit two tenants to hold the same secret and
 * make resolution ambiguous — the failure being that a delivery lands in the
 * wrong agency's book with nothing anywhere reading as broken. The primary key
 * still leads with `tenant_id`; this is an additional index, and it is unique
 * across the whole table on purpose.
 *
 * The plaintext token is never stored. `token_sha256` is a digest and the
 * lookup hashes what it was given, so a database backup, a `SELECT` by a future
 * support surface, or a leaked dump yields nothing that can be replayed at the
 * edge.
 *
 * `definer_only`: `crm_app` reads zero rows. The only reader is
 * `app.webhook_ingest()`.
 */
export const webhookEndpoint = app.table(
  'webhook_endpoint',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    /** Which provider may present this token. Copied onto every row it writes. */
    provider: text('provider').notNull(),

    /** `sha256(token)`. The token itself exists only in Aloware's config and in the URL. */
    tokenSha256: bytea('token_sha256').notNull(),

    /**
     * What an admin sees instead of the secret. Without it, revoking the right
     * endpoint means comparing digests, which nobody does correctly under
     * pressure.
     */
    label: text('label').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    /**
     * Soft revocation, and the resolution predicate reads it. Rotating a token
     * is: insert the new row, reconfigure Aloware, then set this. A hard DELETE
     * would take the vault rows' provenance with it.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex('webhook_endpoint_token_uidx').on(t.tokenSha256),
    // 32 bytes or it is not a sha256. A short digest here is a token space small
    // enough to guess, on the one credential that has no second factor.
    check('webhook_endpoint_token_digest_len', sql`length(${t.tokenSha256}) = 32`),
    check('webhook_endpoint_label_present', sql`length(btrim(${t.label})) > 0`),
    check(
      'webhook_endpoint_revoked_after_created',
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
