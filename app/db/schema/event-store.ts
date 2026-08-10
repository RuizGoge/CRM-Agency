import { sql } from 'drizzle-orm'
import {
  bigint,
  date,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { app } from './_shared'
import { eventConsumer, eventName, outboxStatus, retentionClass } from './events'
import { tenant } from './tenant'

/** The five ways an event can enter the system. Part of the mandatory envelope. */
export const sourceSystem = app.enum('source_system', [
  'app',
  'aloware',
  'vendor_post',
  'scheduler',
  'import',
])

/**
 * The event store: the system of record for replay.
 *
 * NOT the queue, not pg-boss, not a broker's retention window. An all-time
 * leaderboard has to be rebuildable from scratch as one job, and a board that
 * can only be rebuilt from something with a retention window is a board that
 * becomes unauditable the moment the window passes.
 *
 * ⚠️ DECLARED HERE UNPARTITIONED, CREATED PARTITIONED. Drizzle has no
 * vocabulary for `PARTITION BY RANGE`, so migration 0043 replaces the generated
 * `CREATE TABLE` with the partitioned form. The column list is what Drizzle
 * needs a picture of and it is identical; the divergence is the storage clause
 * alone. `snapshot-chain.test.ts` compares migrations against schema FILES, so
 * this stays honest — and it was taught what a partition is rather than being
 * exempted.
 *
 * IMMUTABLE BY ENGINE. The only writer is `app.event_emit()`, which writes the
 * event row and its outbox fan-out rows in the SAME transaction: a consumer can
 * never be lost by a process dying between the two.
 */
export const eventLog = app.table(
  'event_log',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    /** The partition key. Monthly ranges. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

    eventId: uuid('event_id').notNull(),

    /**
     * NOT NULL, and it is the silo rule reaching the event store: an unowned
     * event is invisible to everyone. An inbound call from an unknown number
     * therefore goes to the intake quarantine, which is deliberately NOT an
     * event table, rather than being emitted with a null owner.
     */
    ownerUserId: uuid('owner_user_id').notNull(),

    /** Null for system, scheduler and provider-driven events. */
    actorUserId: uuid('actor_user_id'),

    /**
     * Both halves of the envelope's clock, as real columns. `occurred_at_ms` is
     * when it happened in the world; `recorded_at_ms` is when we learned it. A
     * webhook forty seconds late still threads correctly because the two are
     * not the same number.
     */
    occurredAtMs: bigint('occurred_at_ms', { mode: 'bigint' }).notNull(),
    recordedAtMs: bigint('recorded_at_ms', { mode: 'bigint' }).notNull(),

    schemaVersion: smallint('schema_version').notNull(),
    sourceSystem: sourceSystem('source_system').notNull(),

    /** Ties a whole story together across modules. */
    correlationId: uuid('correlation_id').notNull(),

    eventName: eventName('event_name').notNull(),

    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),

    /**
     * The natural key for external redelivery — `aloware_call_id`,
     * `vendor_lead_id`, `provider_message_id`. Aloware WILL deliver twice, and
     * uuid identity does not help when the second delivery mints a new one.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    payload: jsonb('payload').notNull(),

    /** Monotonic across the store; what a replay cursor advances on. */
    seq: bigint('seq', { mode: 'bigint' })
      .notNull()
      .default(sql`nextval('app.event_seq')`),

    retentionClass: retentionClass('retention_class').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.occurredAt, t.eventId] }),

    /**
     * The natural-key dedupe lookup `app.event_emit` opens with.
     *
     * Uncovered until 0054, because until 0054 nothing called the function. It
     * now runs inside the CLOSE GATE's transaction, three times per stage move,
     * against an API p95 budget of 300 ms and a store that only grows — a
     * sequential scan across every monthly partition is fine today and is a
     * problem the first month nobody is watching.
     *
     * On the parent, so PostgreSQL attaches a matching index to every
     * partition, including ones `ensure_event_partitions` creates later.
     */
    index('event_log_natural_key_idx').on(t.tenantId, t.eventName, t.idempotencyKey),
  ],
)

/**
 * Durable at-least-once fan-out: one row per (event, consumer), written in the
 * SAME transaction as the event.
 *
 * THE DIVISION OF LABOUR WITH PG-BOSS IS TOTAL: the outbox owns fan-out, pg-boss
 * owns scheduling. A consumer cannot be lost by a process dying mid-dispatch,
 * because the row that says "this consumer still owes this event" was committed
 * with the event itself.
 *
 * ⚠️ Same partitioning note as `event_log`, by day rather than by month.
 */
export const eventOutbox = app.table(
  'event_outbox',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    /** The partition key. Daily ranges, dropped after fourteen days. */
    createdDay: date('created_day').notNull(),

    eventId: uuid('event_id').notNull(),
    consumerName: text('consumer_name').notNull(),
    eventName: eventName('event_name').notNull(),

    status: outboxStatus('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),

    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),

    /** Set when the row was produced by a replay rather than by live traffic. */
    replayOfRunId: uuid('replay_of_run_id'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.createdDay, t.eventId, t.consumerName] }),

    // A fan-out row for a consumer that does not exist cannot be written. This
    // is what makes the catalog's `consumers` column a constraint rather than a
    // comment — and it is why event_consumer is seeded by migration.
    foreignKey({
      columns: [t.consumerName, t.eventName],
      foreignColumns: [eventConsumer.consumerName, eventConsumer.eventName],
      name: 'outbox_consumer_fk',
    }),
  ],
)
