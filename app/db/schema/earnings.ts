import { sql } from 'drizzle-orm'
import {
  bigint,
  char,
  check,
  date,
  foreignKey,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { app } from './_shared'
import { appUser, tenant } from './tenant'

/**
 * `projection_repair` is here because of errata **E3**, which outranks the
 * data-model document: it carries `delta_cents = 0` and exists only to render
 * the reason on the affected seller's My Earnings. 05b §678's
 * `CHECK (delta_cents <> 0)` therefore cannot be written literally — see the
 * constraint below, and note that following the older text would have made
 * every projection repair impossible to insert.
 */
export const ledgerEntryType = app.enum('ledger_entry_type', [
  'sale',
  'reversal',
  'value_correction',
  'manual_adjustment',
  'projection_repair',
])

export const periodType = app.enum('period_type', ['day', 'week', 'month', 'all_time'])

/** Descriptive only. No behaviour keys off it — D3: one board, one number. */
export const productType = app.enum('product_type', ['final_expense', 'iul'])

/**
 * The one artifact the product cannot reconstruct.
 *
 * Append-only signed deltas, one writer, exactly once per `source_event_id`,
 * period keys stamped from day one, forward-only with corrections as new
 * reversing rows. There is no recompute job, by design, so losing or
 * corrupting this is total and permanent — which is why the paid Postgres with
 * backups is the single non-negotiable line on the cost ladder.
 *
 * `owner_user_id` is the seller who EARNED the money and is never
 * re-attributed. The leaderboard therefore never joins through
 * `contact.owner_user_id`: transferring a contact moves the record, not the
 * money.
 */
export const earningsLedger = app.table(
  'earnings_ledger',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    ownerUserId: uuid('owner_user_id').notNull(),

    /** The idempotency key. One event credits at most once, forever. */
    sourceEventId: uuid('source_event_id').notNull(),

    /** Null only for admin corrections, which have no triggering event. */
    sourceEventName: text('source_event_name'),

    entryType: ledgerEntryType('entry_type').notNull(),

    /** Signed cents. Never a float, never a JS number — see app/lib/money. */
    deltaCents: bigint('delta_cents', { mode: 'bigint' }).notNull(),

    currency: char('currency', { length: 3 }).notNull().default('USD'),

    opportunityId: uuid('opportunity_id'),
    contactId: uuid('contact_id'),
    stageId: uuid('stage_id'),

    /**
     * The stage's name at the instant of the credit. Renaming a column later
     * must not rewrite history, and a deleted pipeline's stages must stay
     * explicable years afterwards.
     */
    stageNameSnapshot: text('stage_name_snapshot'),
    stageConfigVersion: bigint('stage_config_version', { mode: 'bigint' }),

    productType: productType('product_type'),

    /**
     * Stamped from the tenant's BUSINESS timezone, never the seller's display
     * timezone and never the lead's. Written on day one so that a monthly
     * reset later is a config flip rather than a migration.
     */
    periodDay: date('period_day').notNull(),
    periodWeek: date('period_week').notNull(),
    periodMonth: date('period_month').notNull(),
    businessTzSnapshot: text('business_tz_snapshot').notNull(),

    reason: text('reason'),
    actorUserId: uuid('actor_user_id'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    reversesEntryId: uuid('reverses_entry_id'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),

    // THE correctness mechanism, not a performance index. A double-tap, a
    // retry or a replay hits this and the writer treats the violation as a
    // SUCCESS path. An application-level check-then-insert cannot do this
    // under concurrency: two simultaneous gate submissions both pass a check.
    uniqueIndex('earnings_source_event_uidx').on(t.tenantId, t.sourceEventId),

    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'earnings_owner_fk',
    }),

    // E3 outranks 05b §678 here: a projection_repair is a zero-delta row whose
    // entire job is to carry a reason onto one seller's screen.
    check(
      'earnings_delta_nonzero_unless_repair',
      sql`${t.deltaCents} <> 0 OR ${t.entryType} = 'projection_repair'`,
    ),
    check('earnings_currency_usd', sql`${t.currency} = 'USD'`),
    check('earnings_sale_is_positive', sql`${t.entryType} <> 'sale' OR ${t.deltaCents} > 0`),
    check(
      'earnings_reversal_is_negative',
      sql`${t.entryType} <> 'reversal' OR ${t.deltaCents} < 0`,
    ),

    // The three period keys must agree. A partially-wrong timezone computation
    // cannot produce three mutually incoherent buckets and go unnoticed.
    check(
      'earnings_period_month_coherent',
      sql`${t.periodMonth} = date_trunc('month', ${t.periodDay})::date`,
    ),
    check(
      'earnings_period_week_coherent',
      sql`${t.periodWeek} = date_trunc('week', ${t.periodDay})::date`,
    ),

    // B13: `contact.owner_changed` is one keystroke from `contact.merged` in
    // the registry, and one of them is a public-money mutation. A ledger row
    // sourced from an owner change cannot be committed. Adding a name here is
    // ALTER TABLE — a migration and a deploy gate, not a test edit.
    check(
      'earnings_source_is_a_declared_input',
      sql`${t.entryType} IN ('manual_adjustment', 'projection_repair')
          OR ${t.sourceEventName} IN ('opportunity.won', 'opportunity.value_changed',
                                      'opportunity.reopened', 'contact.merged')`,
    ),

    // Admin corrections are the only rows without a deal behind them. 05b §677
    // marks these NOT NULL, which would make the D8 initial-balance path and
    // E3's repair row impossible to write; this is the same exemption shape
    // E5 already uses for source_event_name.
    check(
      'earnings_deal_context_present',
      sql`${t.entryType} IN ('manual_adjustment', 'projection_repair')
          OR (${t.opportunityId} IS NOT NULL AND ${t.contactId} IS NOT NULL
              AND ${t.stageNameSnapshot} IS NOT NULL AND ${t.stageConfigVersion} IS NOT NULL)`,
    ),
  ],
)

/**
 * The maintained aggregate the 5-second poll reads, so the board never SUMs
 * the ledger and never scans opportunities.
 *
 * Fully rebuildable from `earnings_ledger` by one replay job — and that
 * rebuildability is what makes "a monthly reset is a config flip" true rather
 * than aspirational.
 */
export const leaderboardProjection = app.table(
  'leaderboard_projection',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    periodType: periodType('period_type').notNull(),

    /** The epoch date stands in for `all_time`, so the PK stays uniform. */
    periodKey: date('period_key').notNull(),

    userId: uuid('user_id').notNull(),

    // `sql` rather than a 0n literal: drizzle-kit serialises defaults into the
    // snapshot as JSON, and JSON.stringify throws on a BigInt.
    totalCents: bigint('total_cents', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    entryCount: integer('entry_count').notNull().default(0),

    /**
     * Bumped inside `app.ledger_append`, so the ETag is write-derived.
     *
     * The subtlety that makes this a correctness trap rather than a cache
     * detail: the PUBLIC value is time-dependent, because entries younger than
     * the undo window are excluded. A purely write-derived ETag would answer
     * 304 while the visible number changed as a pending entry aged out. The
     * ETag is therefore hash(max(seq), pending_watermark).
     */
    seq: bigint('seq', { mode: 'bigint' }).notNull(),

    lastEntryRecordedAt: timestamp('last_entry_recorded_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.periodType, t.periodKey, t.userId] }),
    check(
      'leaderboard_all_time_uses_epoch',
      sql`${t.periodType} <> 'all_time' OR ${t.periodKey} = DATE '1970-01-01'`,
    ),
  ],
)
