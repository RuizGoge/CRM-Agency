import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  foreignKey,
  integer,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { app } from './_shared'
import { contact } from './contacts'
import { productType } from './earnings'
import { appUser, tenant } from './tenant'

/**
 * The only thing the two gates bind to. Never the stage NAME — renaming a
 * column is semantically inert, and a gate bound to a name is evaded by
 * typing over it.
 */
export const stageType = app.enum('stage_type', ['open', 'earning', 'lost'])

export const premiumMode = app.enum('premium_mode', ['monthly', 'annual'])

export const opportunityCreatedFrom = app.enum('opportunity_created_from', [
  'lead_intake',
  'manual',
  'inbound_call',
  'import',
  'cross_sell',
])

export const actorType = app.enum('actor_type', [
  'human',
  'system',
  'automation',
  'import',
  'webhook',
  'scheduler',
])

export const movedVia = app.enum('moved_via', [
  'kanban_drag',
  'move_sheet',
  'keyboard',
  'wrap_up',
  'command_palette',
  'api',
  'automation',
])

/** A seller's own board. One per seller in the MVP. */
export const pipeline = app.table(
  'pipeline',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    ownerUserId: uuid('owner_user_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'pipeline_owner_fk',
    }),
    // Exactly one live board per seller today. Lifting that later is dropping
    // one index, not a migration.
    uniqueIndex('pipeline_one_per_owner_uidx')
      .on(t.tenantId, t.ownerUserId)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
)

/**
 * The per-seller stage set.
 *
 * `stage_type` is immutable by trigger, and that one trigger deletes an entire
 * class of catastrophe. If a stage's type can never flip, then a per-seller
 * board tweak can never move money on a PUBLIC leaderboard, and the corpus's
 * contradiction between "recompute on stage-flag change" and "no recompute job
 * exists" resolves in favour of the latter with no ambiguity left over.
 *
 * A seller who wants a different type creates a new stage and moves cards —
 * which is a normal, gated move that credits or reverses exactly once.
 */
export const stage = app.table(
  'stage',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    pipelineId: uuid('pipeline_id').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    name: text('name').notNull(),
    stageType: stageType('stage_type').notNull(),
    sortOrder: smallint('sort_order').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    foreignKey({
      columns: [t.tenantId, t.pipelineId],
      foreignColumns: [pipeline.tenantId, pipeline.id],
      name: 'stage_pipeline_fk',
    }),
    // Redundant on its own. It exists to be the TARGET of opportunity's
    // composite FK, which is what makes a denormalised current_stage_type
    // provably identical to the stage's real type — no trigger, no join.
    //
    // A CONSTRAINT rather than an index, deliberately: Drizzle emits table
    // constraints inline with CREATE TABLE and indexes afterwards, so as an
    // index this would be created AFTER the foreign key that depends on it,
    // and the migration would not apply.
    unique('stage_id_type_uq').on(t.tenantId, t.id, t.stageType),
    check('stage_sort_order_non_negative', sql`${t.sortOrder} >= 0`),
  ],
)

/** Typified loss reasons. Reporting keys on `code`, never on the label. */
export const lostReason = app.table(
  'lost_reason',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    code: text('code').notNull(),
    label: text('label').notNull(),
    sortOrder: smallint('sort_order').notNull(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex('lost_reason_code_uidx').on(t.tenantId, t.code),
  ],
)

/**
 * The sale process, decoupled from the contact so one person can carry a Final
 * Expense policy and, forty-five days later, an independent IUL opportunity
 * with its own card, premium and close date on one unbroken timeline.
 *
 * THE TWO GATES LIVE HERE, AS CHECK CONSTRAINTS. A raw API call, a CSV import,
 * an automation, or a route written next year that skips the service layer
 * cannot produce the row at all — not "is rejected by middleware", cannot
 * exist.
 */
export const opportunity = app.table(
  'opportunity',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    ownerUserId: uuid('owner_user_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    pipelineId: uuid('pipeline_id').notNull(),
    stageId: uuid('stage_id').notNull(),

    /** Denormalised, and provably equal to the stage's type by composite FK. */
    currentStageType: stageType('current_stage_type').notNull(),

    premiumMonthlyCents: bigint('premium_monthly_cents', { mode: 'bigint' }),
    premiumAnnualCents: bigint('premium_annual_cents', { mode: 'bigint' }),
    premiumMode: premiumMode('premium_mode'),

    productType: productType('product_type'),
    carrier: text('carrier'),
    policyNumber: text('policy_number'),
    draftDate: date('draft_date'),

    lostReasonId: uuid('lost_reason_id'),
    lostReasonNote: text('lost_reason_note'),

    parentOpportunityId: uuid('parent_opportunity_id'),
    createdFrom: opportunityCreatedFrom('created_from').notNull(),

    stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),

    /**
     * The HUMAN half of the touch engine, and the reason it is a second column.
     *
     * `last_activity_at` moves on any touch, automated ones included. If the
     * cold rule keyed on that, a sequence texting a dead lead every four days
     * would keep it looking warm forever — automation would MASK abandonment,
     * which is the exact opposite of what the going-cold signal exists to
     * surface. Cold keys on this column; the board's freshness rail does not.
     */
    lastHumanTouchAt: timestamp('last_human_touch_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    firstTouchLatencySeconds: integer('first_touch_latency_seconds'),

    /** NULL -> value exactly once, enforced by trigger. Confetti fires once. */
    celebratedAt: timestamp('celebrated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),

    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'opportunity_owner_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contact.tenantId, contact.id],
      name: 'opportunity_contact_fk',
    }),
    // The mechanism: current_stage_type cannot disagree with the stage it
    // points at, because the pair is the foreign key.
    foreignKey({
      columns: [t.tenantId, t.stageId, t.currentStageType],
      foreignColumns: [stage.tenantId, stage.id, stage.stageType],
      name: 'opportunity_stage_type_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.lostReasonId],
      foreignColumns: [lostReason.tenantId, lostReason.id],
      name: 'opportunity_lost_reason_fk',
    }),

    // ---- THE WIN GATE ----
    check(
      'opportunity_win_gate',
      sql`${t.currentStageType} <> 'earning' OR ${t.premiumAnnualCents} IS NOT NULL`,
    ),
    // ---- THE LOSS GATE ----
    check(
      'opportunity_loss_gate',
      sql`${t.currentStageType} <> 'lost' OR ${t.lostReasonId} IS NOT NULL`,
    ),

    // Exact annualisation as a database invariant. A float bug anywhere on the
    // premium path produces a constraint violation and the seller reads the
    // specified failure copy, instead of a silently wrong public number.
    check(
      'opportunity_annualization_exact',
      sql`${t.premiumMonthlyCents} IS NULL
          OR ${t.premiumAnnualCents} = ${t.premiumMonthlyCents} * 12`,
    ),
    // $1 to $100,000 a year. Catches the 12x error in the other direction and
    // the misplaced-decimal paste.
    check(
      'opportunity_premium_in_range',
      sql`${t.premiumAnnualCents} IS NULL
          OR ${t.premiumAnnualCents} BETWEEN 100 AND 10000000`,
    ),
    // The durable form of "no preselected default": there is no premium
    // without an explicit Monthly-or-Annual choice by a human.
    check(
      'opportunity_premium_mode_declared',
      sql`(${t.premiumMode} IS NULL) = (${t.premiumAnnualCents} IS NULL)`,
    ),
  ],
)

/**
 * Every stage move, append-only.
 *
 * Three non-negotiables live here rather than in a service: the gate's
 * evidence, the sendBeacon idempotency key, and the human-only rule for
 * anything that credits money.
 */
export const stageTransition = app.table(
  'stage_transition',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),
    opportunityId: uuid('opportunity_id').notNull(),

    /** Denormalised for exactly one reason: the owner predicate in the policy. */
    ownerUserId: uuid('owner_user_id').notNull(),

    fromStageId: uuid('from_stage_id'),
    fromStageNameSnapshot: text('from_stage_name_snapshot'),
    fromStageType: stageType('from_stage_type'),

    toStageId: uuid('to_stage_id').notNull(),
    toStageType: stageType('to_stage_type').notNull(),
    toStageNameSnapshot: text('to_stage_name_snapshot').notNull(),

    actorUserId: uuid('actor_user_id'),
    actorType: actorType('actor_type').notNull(),
    movedVia: movedVia('moved_via').notNull(),

    /** sendBeacon on tab close can legitimately deliver the same move twice. */
    clientMoveKey: uuid('client_move_key'),

    stageConfigVersion: bigint('stage_config_version', { mode: 'bigint' }).notNull(),
    daysInPreviousStage: integer('days_in_previous_stage'),

    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),

    // The double delivery becomes a success path, not a duplicate move — and
    // therefore never a double credit.
    uniqueIndex('stage_transition_move_uidx')
      .on(t.tenantId, t.clientMoveKey)
      .where(sql`${t.clientMoveKey} IS NOT NULL`),

    // HUMAN-ONLY EARNING TRANSITIONS. A CSV import, a webhook, a reminder job,
    // a merge or an API token physically cannot write a row that credits
    // money. The service layer's only job is the friendly error.
    check(
      'stage_transition_earning_is_human',
      sql`${t.toStageType} <> 'earning' OR ${t.actorType} = 'human'`,
    ),
  ],
)
