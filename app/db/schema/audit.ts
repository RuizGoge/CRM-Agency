import { sql } from 'drizzle-orm'
import { foreignKey, inet, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { app } from './_shared'
import { gateVerdict } from './compliance'
import { actorType } from './pipeline'
import { appUser, tenant } from './tenant'

/**
 * The audit log. MVP item 7, and the third append-only table.
 *
 * **"The timeline is for the seller, the audit log is for the lawyer."** The
 * timeline carries one entry per verdict per contact per 60-second window; this
 * carries one row per ATTEMPT, unbucketed, because the question it answers is
 * not "what happened to this lead" but "what was true at 14:07 on a Tuesday
 * nineteen months ago, and who did it".
 *
 * APPEND-ONLY BY TRIGGER **AND** BY REVOKED PRIVILEGE, which is the ranking the
 * constitution sets. `append_only_tenant_admin` gets both from `harden()` for
 * free: `WITH CHECK (false)`, no INSERT/UPDATE/DELETE grant to `crm_app` at
 * all, and `security.refuse_mutation()` as a statement trigger that covers
 * TRUNCATE. The only way a row arrives is `app.audit_write()`.
 *
 * ⚠️ TENANT-ADMIN READ, NOT OWNER READ. A seller cannot read this at all — not
 * even rows about themselves. `book.viewed` records that a supervisor read
 * somebody's book, and a seller who could query it would learn which colleague
 * is being looked at. The log is evidence about the agency, so it is readable
 * by whoever answers for the agency.
 *
 * ⚠️ DECLARED HERE UNPARTITIONED, CREATED PARTITIONED. Drizzle has no
 * vocabulary for `PARTITION BY RANGE`, so migration 0053 replaces the generated
 * `CREATE TABLE` with the partitioned form — monthly, same as `event_log`. The
 * column list is identical; the divergence is the storage clause alone. The
 * per-partition dedupe index is created inside `app.ensure_audit_partitions()`
 * through `format()`, so it is not declared here and does not need to be: a
 * partition is storage for a declared parent.
 */
export const auditLog = app.table(
  'audit_log',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    /** The partition key. Monthly ranges. */
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    /**
     * NULLABLE, and the null is the honest value rather than a gap: a scheduler
     * tick, a provider webhook and a migration have no user behind them.
     * Writing a service account here would make "who did this" unanswerable
     * exactly where it matters.
     *
     * Never a parameter of `app.audit_write` — it comes from
     * `app.current_user_id()`, because a caller that can declare who acted is a
     * caller that can declare somebody else acted.
     */
    actorUserId: uuid('actor_user_id'),
    actorType: actorType('actor_type').notNull(),

    /** Closed vocabulary, enforced by a CHECK against `app.audit_action_list()`. */
    action: text('action').notNull(),

    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id'),

    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),

    /**
     * The compliance half. A verdict row carries the verdict AND the inputs it
     * was computed from, because "the gate said no" is not a defence eighteen
     * months later — "the gate said no, and here is the zip, the zone set, the
     * local time and the suppression state it read" is.
     */
    verdict: gateVerdict('verdict'),
    verdictInputSnapshot: jsonb('verdict_input_snapshot'),
    overrideId: uuid('override_id'),

    correlationId: uuid('correlation_id'),
    sourceIp: inet('source_ip'),
    userAgent: text('user_agent'),

    /**
     * Five-minute bucket, and only the read-ish actions use it. `book.viewed`
     * unbucketed would write a row per keystroke of a supervisor scrolling.
     * Every WRITE action leaves this NULL and is therefore never deduplicated —
     * N dials under break-glass are N rows, which US-9.13 requires by name.
     */
    dedupeBucket: timestamp('dedupe_bucket', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.occurredAt, t.id] }),

    // Composite, like every foreign key in this schema: a cross-tenant
    // reference is structurally impossible to write rather than discouraged.
    foreignKey({
      columns: [t.tenantId, t.actorUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'audit_log_actor_fk',
    }),
  ],
)
