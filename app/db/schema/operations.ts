import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { rawPayloadVault } from './communications'
import { app } from './_shared'

/**
 * The two operational surfaces §4.6 requires — and it requires them to be
 * SURFACES rather than logs.
 *
 * *"The counter is a product surface, not a log. `/admin/integration-health`
 * renders live rows."* All five ARR-mandated health signals are materialised as
 * rows here rather than reconstructed from log lines, because a log is
 * something nobody reads until after the thing it warned about has happened.
 */

/** The three origins §4.6 collapses into one table. */
export const DEAD_LETTER_ORIGINS = ['inbound_webhook', 'outbox_delivery', 'job'] as const

/**
 * `app.dead_letter` — nothing is ever discarded (ARR-INT-07).
 *
 * A signature-invalid webhook, an outbox delivery that exhausted its backoff
 * and a pg-boss job that died `max_attempts` times all land here. ONE table,
 * because three would be three places to forget to look.
 *
 * `UNIQUE (tenant_id, origin, subject_type, subject_id)` means a subject
 * dead-letters ONCE and a second failure increments `attempt_count` instead of
 * generating noise — a retry storm produces a count, never a thousand rows an
 * admin has to page through to find the one that matters.
 */
export const deadLetter = app.table(
  'dead_letter',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    origin: text('origin').notNull(),
    /** What kind of thing failed — `inbound_webhook_event`, `scheduled_job`, … */
    subjectType: text('subject_type').notNull(),
    /** Its id, as text: the subjects live in different tables with different key types. */
    subjectId: text('subject_id').notNull(),

    /**
     * 🔴 THE BODY IS HELD BY REFERENCE AND NEVER COPIED (ARR-PRV-02). Copying it
     * would make the DLQ a second PII store with its own retention clock, and
     * the whole point of one clock is that a deletion request has one place to
     * reach.
     *
     * ⚠️ NULLABLE, AND `ON DELETE SET NULL`, WHICH IS RESIDUAL RISK **R13** MADE
     * CONCRETE RATHER THAN CLOSED. §4.6 purges the vault by partition drop while
     * this FK points into it. Row-level deletion now blanks the pointer — the
     * DLQ degrades to "this failed, the body is gone", which is the right way
     * round when the alternative is a compliance purge that a queue row can
     * block. Partition DROP is still refused by an incoming FK, so R13 stays
     * open and stays declared; the vault is not partitioned yet and no purge job
     * exists, so nothing here is live.
     */
    rawPayloadId: uuid('raw_payload_id'),

    /** Why, in words an admin can act on. Never a stack trace. */
    reason: text('reason').notNull(),

    attemptCount: integer('attempt_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** Set by an admin once the underlying problem is dealt with. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.rawPayloadId],
      foreignColumns: [rawPayloadVault.tenantId, rawPayloadVault.id],
      name: 'dead_letter_payload_fk',
    }).onDelete('set null'),
    uniqueIndex('dead_letter_subject_uidx').on(t.tenantId, t.origin, t.subjectType, t.subjectId),
    check('dead_letter_origin', sql`${t.origin} IN ('inbound_webhook', 'outbox_delivery', 'job')`),
    check('dead_letter_attempts_positive', sql`${t.attemptCount} >= 1`),
    check('dead_letter_reason_present', sql`length(btrim(${t.reason})) > 0`),
  ],
)

/**
 * The alert kinds. Closed here rather than free text, because §4.6 names the
 * five signals it mandates and an invented sixth is a row nobody's screen
 * renders.
 */
export const ADMIN_ALERT_KINDS = [
  /** §5: a call arrived on a number the identity map does not know. */
  'unmapped_number',
  /** §5: the mapping exists and nobody finished verifying it. */
  'mapping_unverified',
  /** A provider disposition we have no mapping for. */
  'unmapped_disposition',
  /** The ingest edge shed load. */
  'ingest_throttled',
  /**
   * 🔴 THE COMPENSATING CONTROL FOR A MISSING `call_list`. Aloware exposes no
   * documented call-listing endpoint, so there is no way to reconcile what we
   * received against what actually happened — and Aloware never retries, so a
   * dropped delivery is invisible. This row is what makes that hole VISIBLE
   * instead of theoretical, and it is the one kind that can never be
   * acknowledged away.
   */
  'reconciliation_unavailable',

  /**
   * The event loop of a FOLDED process is saturated: `perf_hooks`
   * `monitorEventLoopDelay` p99 over 200 ms sustained for 60 s (§2444).
   *
   * Added by 0055 because Gate 6 could not close without it: §2548 requires the
   * folded leg to assert that this row "actually fires", and it was not a legal
   * value — the CHECK enumerated five literals and this was not one, so it
   * could not be written even by hand.
   *
   * The ONLY kind whose subject is the PROCESS rather than a record, which is
   * why it is written by `app.process_alert_raise` — fanned out one row per
   * tenant, because every agency the process serves is degraded at once.
   */
  'folded_topology_saturated',
] as const

/**
 * `app.admin_alert` — the health signals, as rows.
 *
 * `UNIQUE (tenant_id, kind, subject_key)` with `occurrence_count`: the tenth
 * call from an unrecognised number updates a counter rather than adding a
 * tenth row. §5's copy reads *"1 call from a number we do not recognize.
 * Nothing was written to a seller's book."* — a sentence with a number in it,
 * which only works if the number is maintained.
 */
export const adminAlert = app.table(
  'admin_alert',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    kind: text('kind').notNull(),
    /**
     * What the alert is ABOUT — the unrecognised number, the capability name.
     * Empty string for a tenant-wide alert that has no subject, rather than
     * NULL, because a NULL here would make the unique index stop de-duplicating
     * exactly the rows that repeat most.
     */
    subjectKey: text('subject_key').notNull().default(''),

    /** One sentence, rendered to a human. */
    detail: text('detail').notNull(),

    occurrenceCount: integer('occurrence_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex('admin_alert_subject_uidx').on(t.tenantId, t.kind, t.subjectKey),
    check(
      'admin_alert_kind',
      sql`${t.kind} IN ('unmapped_number', 'mapping_unverified', 'unmapped_disposition',
                        'ingest_throttled', 'reconciliation_unavailable',
                        'folded_topology_saturated')`,
    ),
    check('admin_alert_occurrences_positive', sql`${t.occurrenceCount} >= 1`),
    check('admin_alert_detail_present', sql`length(btrim(${t.detail})) > 0`),
    /**
     * 🎯 THE RECONCILIATION GAP CANNOT BE ACKNOWLEDGED AWAY, and it is a CHECK
     * rather than a rule in a handler because that is the difference between a
     * control and a note. The `call_list` fallback described in the capability
     * register only holds if the compensating control is PERMANENT and
     * unacknowledgeable — an admin who could tick this off would restore
     * exactly the silent hole it exists to advertise.
     */
    check(
      'admin_alert_reconciliation_not_acknowledgeable',
      sql`${t.acknowledgedAt} IS NULL OR ${t.kind} <> 'reconciliation_unavailable'`,
    ),
  ],
)
