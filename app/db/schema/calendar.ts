import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { app } from './_shared'
import { contact } from './contacts'
import { opportunity } from './pipeline'
import { actorType } from './pipeline'
import { appUser, tenant } from './tenant'

export const activityType = app.enum('activity_type', [
  'call',
  'sms',
  'email',
  'task',
  'appointment_link',
])

export const meetingType = app.enum('meeting_type', ['phone', 'video', 'in_person'])
export const meetingCreatedVia = app.enum('meeting_created_via', [
  'wrap_up',
  'manual',
  'quick_schedule',
  'reschedule',
])
export const meetingOutcome = app.enum('meeting_outcome', [
  'held',
  'no_show',
  'canceled_by_lead',
  'rescheduled',
  'sold',
])

export const scheduledKind = app.enum('scheduled_kind', [
  'meeting_reminder',
  'cold_sweep',
  'activity_escalation',
  'celebration_broadcast',
  'retention_purge',
  'reconciliation_backfill',
  'aloware_health_probe',
])

export const jobStatus = app.enum('job_status', [
  'pending',
  'fired',
  'skipped',
  'canceled',
  'dropped_late',
])

/**
 * The ONE activity object: every unit of work.
 *
 * A separate tasks table is forbidden by the boundary ruling. `app.task` is a
 * security_invoker view over this table where type='task', so the name exists
 * for callers without a second object — and, more importantly, without a
 * second source of truth for `last_activity_at`.
 */
export const activity = app.table(
  'activity',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    ownerUserId: uuid('owner_user_id').notNull(),

    contactId: uuid('contact_id'),
    opportunityId: uuid('opportunity_id'),

    type: activityType('type').notNull(),
    title: text('title').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    priority: smallint('priority').notNull().default(0),

    createdBy: actorType('created_by').notNull(),
    sourceEventId: uuid('source_event_id'),

    /** Lets a seller ask "why is this on my list today" and get a real answer. */
    sourceEventName: text('source_event_name'),

    linkedMeetingId: uuid('linked_meeting_id'),

    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedByUserId: uuid('completed_by_user_id'),
    outcome: text('outcome'),
    autoCompleted: boolean('auto_completed').notNull().default(false),
    escalationLevel: smallint('escalation_level').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** A cancelled task is not a deleted one, and My Day must explain which. */
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'activity_owner_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contact.tenantId, contact.id],
      name: 'activity_contact_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.opportunityId],
      foreignColumns: [opportunity.tenantId, opportunity.id],
      name: 'activity_opportunity_fk',
    }),

    check(
      'activity_has_a_subject',
      sql`${t.contactId} IS NOT NULL OR ${t.opportunityId} IS NOT NULL`,
    ),
    // A scheduled callback has a hard due time by construction. Without this a
    // task can exist that My Day has no way to place.
    check('activity_task_has_due_at', sql`${t.type} <> 'task' OR ${t.dueAt} IS NOT NULL`),
    // Anything a machine put on a seller's list must be able to say why.
    check(
      'activity_machine_work_is_explainable',
      sql`${t.createdBy} = 'human' OR ${t.sourceEventName} IS NOT NULL`,
    ),

    // My Day's "due now" and "today" — the largest section of the highest
    // frequency screen. Partial on open work, so the index stays the size of
    // one seller's open list rather than their history.
    index('activity_my_day_idx')
      .on(t.tenantId, t.ownerUserId, t.dueAt)
      .where(sql`${t.completedAt} IS NULL AND ${t.canceledAt} IS NULL`),
  ],
)

/**
 * The phone appointment.
 *
 * `contact_timezone` is a SNAPSHOT and never a join to the contact. A later
 * contact edit must not retroactively move a past meeting's local time — or,
 * far worse, retroactively change whether a reminder that already fired was
 * legal to send.
 */
export const meeting = app.table(
  'meeting',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    ownerUserId: uuid('owner_user_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    opportunityId: uuid('opportunity_id').notNull(),

    startsAtUtc: timestamp('starts_at_utc', { withTimezone: true }).notNull(),
    durationMinutes: smallint('duration_minutes').notNull().default(30),

    /** Snapshot. Validated against pg_timezone_names by trigger. */
    contactTimezone: text('contact_timezone').notNull(),

    meetingType: meetingType('meeting_type').notNull().default('phone'),
    createdVia: meetingCreatedVia('created_via').notNull(),

    outcome: meetingOutcome('outcome'),
    outcomeAt: timestamp('outcome_at', { withTimezone: true }),

    rescheduledFromMeetingId: uuid('rescheduled_from_meeting_id'),
    originatingNoShowMeetingId: uuid('originating_no_show_meeting_id'),

    reminderConsentCaptured: boolean('reminder_consent_captured').notNull().default(false),

    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'meeting_owner_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contact.tenantId, contact.id],
      name: 'meeting_contact_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.opportunityId],
      foreignColumns: [opportunity.tenantId, opportunity.id],
      name: 'meeting_opportunity_fk',
    }),

    // The duplicate guard two-click Quick Schedule requires, as an index
    // rather than a client-side check that a double tap outruns.
    uniqueIndex('meeting_no_duplicate_uidx')
      .on(t.tenantId, t.ownerUserId, t.startsAtUtc, t.contactId)
      .where(sql`${t.canceledAt} IS NULL`),

    index('meeting_today_idx')
      .on(t.tenantId, t.ownerUserId, t.startsAtUtc)
      .where(sql`${t.canceledAt} IS NULL`),
  ],
)

/**
 * Domain-level scheduling intent, distinct from pg-boss's own job table —
 * which is not wrapped or duplicated here.
 *
 * This is where episode-scoped idempotency and auditable terminal states live.
 * A SKIPPED job is a first-class terminal state, not an error, and that is
 * precisely what lets the SMS-dark rehearsal pass with no path erroring.
 */
export const scheduledJob = app.table(
  'scheduled_job',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    kind: scheduledKind('kind').notNull(),

    /**
     * The episode key. `meeting_id || ':t_minus_60m'` for a reminder,
     * `opportunity_id || ':' || ordinal` for a cold episode,
     * `activity_id || ':' || level` for an escalation.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    ownerUserId: uuid('owner_user_id'),

    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    status: jobStatus('status').notNull().default('pending'),

    /** 'skipped: sms_disabled', 'skipped: suppressed', 'dropped: 15m late'. */
    terminalReason: text('terminal_reason'),
    bossJobId: text('boss_job_id'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    /**
     * THE LEASE. Added by migration 0020 and never declared here, which is why
     * the snapshot chain had to be reconciled: a column the database has and
     * the schema file does not is a column `drizzle-kit generate` would offer
     * to add a second time.
     *
     * `FOR UPDATE SKIP LOCKED` alone is not enough. The row lock ends when the
     * claim's transaction commits, so the next dispatcher tick — milliseconds
     * later, before the work is resolved — picks the same job up again. This
     * column is what survives the transaction, and the lease it grants is
     * deliberately shorter than the fifteen minutes after which a reminder is
     * dropped as too late.
     */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),

    /** A real domain state, not a soft delete: a reschedule cancels a reminder. */
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),

    // ONE partial unique index carries every episode-scoped idempotency
    // requirement in the product. A reschedule cancels the old row and inserts
    // a new one, so exactly one live job per (subject, kind) exists at any
    // instant and a second enqueue is impossible rather than merely unlikely.
    uniqueIndex('scheduled_job_episode_uidx')
      .on(t.tenantId, t.kind, t.idempotencyKey)
      .where(sql`${t.canceledAt} IS NULL`),

    // The dispatcher. Cross-tenant by design — one of the four enumerated
    // system paths — so it is deliberately NOT led by tenant_id.
    index('scheduled_job_due_idx')
      .on(t.fireAt)
      .where(sql`${t.status} = 'pending'`),
  ],
)
