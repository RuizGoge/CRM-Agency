import { foreignKey, integer, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'

import { app } from './_shared'
import { appUser, tenant } from './tenant'

/**
 * The two reads that are allowed to cross the silo.
 *
 * Both answer a question about a phone number rather than about a record, and
 * that is exactly what makes them dangerous: a cross-silo lookup is a PRIVACY
 * ORACLE. Ask it once and you learn one fact; ask it sixty thousand times and
 * you have enumerated the agency's entire book, one number at a time, without
 * ever reading a row you were not entitled to.
 *
 * Quick-add makes the attack cheap — a seller can mint a contact for any number
 * they like and then ask about it — so "you may only ask about your own
 * contacts" is a speed bump and not a boundary. The boundary is the meter.
 */
export const lookupKind = app.enum('lookup_kind', ['suppression_check', 'recent_contact'])

/**
 * Rate-limits the cross-silo oracles at 60 per minute per user per kind.
 *
 * INCREMENTED INSIDE THE SAME SECURITY DEFINER FUNCTION THAT PERFORMS THE
 * LOOKUP, in the same statement. That is the whole design: the meter cannot be
 * bypassed by calling the lookup a different way because there IS no different
 * way — `crm_app` holds no privilege on the underlying tables, so the definer
 * is the only door and the meter is welded to it.
 *
 * A meter enforced by the caller is a meter that the next caller forgets.
 *
 * ⚠️ 05b also specifies daily partitioning with a 30-day drop. Not built here:
 * at fifty sellers the table gains at most ~72k rows a day in the worst case
 * that never happens, and a partition scheme is operational machinery that
 * should arrive with a measurement rather than ahead of one. The cleanup is a
 * one-line DELETE until it isn't.
 */
export const tenantLookupMeter = app.table(
  'tenant_lookup_meter',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    userId: uuid('user_id').notNull(),

    /** Truncated to the minute by the appender, never by a call site. */
    minuteBucket: timestamp('minute_bucket', { withTimezone: true }).notNull(),

    lookupKind: lookupKind('lookup_kind').notNull(),

    lookupCount: integer('lookup_count').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId, t.minuteBucket, t.lookupKind] }),
    foreignKey({
      columns: [t.tenantId, t.userId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'lookup_meter_user_fk',
    }),
  ],
)

/** Named so the cap is one number in one place rather than a literal in a function body. */
export const LOOKUP_CAP_PER_MINUTE = 60
