import { sql } from 'drizzle-orm'
import {
  char,
  check,
  foreignKey,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { app, ref } from './_shared'
import { appUser, tenant } from './tenant'

/**
 * The gate's decision vocabulary — D-SEC-4, in order.
 *
 * ORDER IS PART OF THE MEANING, not presentation. `blocked_suppressed` is
 * evaluated before the clock, so a STOP is refused at 2pm on a Tuesday for the
 * same reason it is refused at midnight; and the two clock verdicts come last
 * among the blocks because they are the only two break-glass can release.
 */
export const gateVerdict = app.enum('gate_verdict', [
  'allow',
  'blocked_sms_disabled',
  'blocked_suppressed',
  'blocked_timezone_unknown',
  'blocked_calling_window',
  'blocked_recording_unverified',
])

/**
 * A SINGLE-VALUE ENUM, and that single value is the whole safety argument.
 *
 * The schema literally cannot express an override of suppression, of STOP, of
 * DNC or of `sms_enabled`: there is no label for it. Adding one is `ALTER TYPE`
 * — a migration, a diff, a decision somebody makes on purpose — rather than a
 * boolean somebody passes. §SEC-11 puts it plainly: the schema is what makes
 * "not overridable by any role" true, not the code.
 */
export const overrideScope = app.enum('override_scope', ['timezone_and_window'])

export const overrideEndReason = app.enum('override_end_reason', ['manual', 'auto_expired'])

/**
 * Break-glass: the only sanctioned bypass, admin-only, reason-required, and
 * self-expiring at sixty minutes.
 *
 * WHY IT EXISTS AT ALL. The calling-window gate is a HARD block whose input is
 * a dataset. A stale or wrong timezone table is therefore not a data-quality
 * issue — it is fifty sellers unable to work, with no way out. This table is
 * that way out, and its existence is precisely what lets the rest of the design
 * afford to fail closed everywhere else.
 *
 * EXPIRY NEEDS NO JOB. `expires_at` is generated from `started_at`, so it is
 * computed on every read and cannot drift, be missed by a worker outage, or be
 * extended by anyone. An override that outlives its window because a scheduler
 * was down is the failure this shape removes.
 */
export const breakGlassOverride = app.table(
  'break_glass_override',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    startedByUserId: uuid('started_by_user_id').notNull(),

    /** At least ten characters, by CHECK. "test" is not a reason an auditor accepts. */
    reason: text('reason').notNull(),

    scope: overrideScope('scope').notNull().default('timezone_and_window'),

    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedByUserId: uuid('ended_by_user_id'),
    endReason: overrideEndReason('end_reason'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),

    foreignKey({
      columns: [t.tenantId, t.startedByUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'override_started_by_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.endedByUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'override_ended_by_fk',
    }),

    check('override_reason_is_real', sql`length(btrim(${t.reason})) >= 10`),

    // Belt and braces over the single-value enum. If a second label is ever
    // added by ALTER TYPE, this CHECK still has to be dropped in the same
    // migration — two deliberate acts instead of one.
    check('override_scope_is_the_only_one', sql`${t.scope} = 'timezone_and_window'`),

    // At most one live override per tenant. clock_timestamp() cannot appear in
    // an index predicate — it is not immutable — so "live" here means "not yet
    // ended", and the engage path closes any expired row first. That two-step
    // is deterministic; a time-dependent index would not be.
    uniqueIndex('override_one_live_per_tenant')
      .on(t.tenantId)
      .where(sql`${t.endedAt} IS NULL`),
  ],
)

/**
 * The all-party-consent recording states, in DATA rather than in an `if` chain.
 *
 * §SEC-10 is explicit that this belongs in a relation so changing it is a
 * seeded row and not a code change. The gate consults it only while
 * `system_constant['recording_guard']` is tripped, which is what makes the
 * enforcement proportionate: a dial to Ohio proceeds, a dial to California does
 * not, and nobody stops the floor over an unverified provider setting.
 */
export const stateRecordingRegime = ref.table(
  'state_recording_regime',
  {
    stateCode: char('state_code', { length: 2 }).primaryKey(),
    /** `all_party` is the only value that gates anything today. */
    regime: text('regime').notNull(),
  },
  (t) => [
    check('recording_regime_known', sql`${t.regime} IN ('all_party', 'one_party')`),
    check('recording_regime_state_is_alpha', sql`${t.stateCode} ~ '^[A-Z]{2}$'`),
  ],
)
