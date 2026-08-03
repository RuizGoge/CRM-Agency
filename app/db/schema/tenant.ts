import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { app, citext, earningsDisposition, userRole } from './_shared'
import { user as authUser } from './auth'

/**
 * Tenancy root, and the only home for tenant-wide configuration.
 *
 * Flags are typed columns, never a jsonb blob: a typo in a jsonb key is
 * invisible at runtime, a missing column is a compile error.
 */
export const tenant = app.table(
  'tenant',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),

    /**
     * Generated mirror of `id`, so the catalog gate "every table has a
     * tenant_id column" has zero special cases. Costs one stored uuid per
     * tenant row and removes an entire class of exception from the gate.
     */
    tenantId: uuid('tenant_id').generatedAlwaysAs(sql`id`),

    name: text('name').notNull(),

    /** Stamps every `period_key` and NOTHING else. Not display, not calling window. */
    businessTz: text('business_tz').notNull(),

    currency: char('currency', { length: 3 }).notNull().default('USD'),

    /** The configuration the product actually launches in — see G13 §11. */
    smsEnabled: boolean('sms_enabled').notNull().default(false),
    reminderKillSwitch: boolean('reminder_kill_switch').notNull().default(false),

    /**
     * THE ONLY DECAY THRESHOLD. Ruling R1.7 (`04-ux-flows.md` Part I, rank 1):
     * "One threshold: cold_threshold_days, default 7, configurable. There is
     * no separate 'rot' threshold."
     *
     * This table used to carry a SECOND decay threshold beside it, with a
     * CHECK ordering the two — the pre-R6 two-tier design, encoded exactly.
     * Migration 0025 drops it and records why; the name is deliberately not
     * repeated here, because `tests/integration/one-decay-threshold.test.ts`
     * enforces R2-6 by grep and a live schema file is exactly where a banned
     * concept would come back first. `04b` §1 gives the consequence that makes
     * this more than tidying: deleting the 14-day red tier frees red on the
     * card face to mean one thing only, which is "you may not contact this
     * person".
     */
    coldThresholdDays: smallint('cold_threshold_days').notNull().default(7),

    customFieldsEnabled: boolean('custom_fields_enabled').notNull().default(false),
    tagsEnabled: boolean('tags_enabled').notNull().default(false),

    isDemo: boolean('is_demo').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    /** A tenant is never deleted: every ledger, consent and audit row anchors to it. */
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => [
    // Multi-tenant-ready column, pinned to one value today.
    check('tenant_currency_usd', sql`${t.currency} = 'USD'`),
    // At most one demo tenant, ever, across all tenants. Known to become a
    // blocker at tenant #2 (§9.6 item 3); correct and load-bearing today.
    uniqueIndex('tenant_single_demo_uidx')
      .on(t.isDemo)
      .where(sql`${t.isDemo}`),
  ],
)

/**
 * The 50 sellers plus supervisors and admins.
 *
 * Named `app_user` because USER is a reserved word and quoting it forever is a
 * bug farm.
 */
export const appUser = app.table(
  'app_user',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    /**
     * The login identity behind this membership, or NULL for a seat that has
     * no credentials yet (a seeded demo seller, or one invited but not
     * activated).
     *
     * Unique, because in the MVP one login is one person in one tenant. The
     * eventual model is one login to N memberships; lifting that is dropping
     * this index, not a redesign. No cascade on purpose: `earnings_ledger`
     * and `audit_log` anchor to app_user, so deleting a login must be blocked
     * rather than allowed to orphan the all-time board.
     */
    authUserId: text('auth_user_id')
      .unique()
      .references(() => authUser.id),

    email: citext('email').notNull(),
    fullName: text('full_name').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),

    role: userRole('role').notNull(),

    /** Formats every human-facing timestamp and nothing else. */
    displayTz: text('display_tz').notNull().default('America/New_York'),

    earningsDisposition: earningsDisposition('earnings_disposition')
      .notNull()
      .default('keep_in_history'),

    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    // Composite PK with tenant_id leading — a cross-tenant reference is
    // structurally impossible to write.
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex('app_user_email_uidx').on(t.tenantId, t.email),
    // Redundant on purpose: lets any future table carry an FK-guaranteed
    // denormalised role copy without a second source of truth.
    uniqueIndex('app_user_id_role_uidx').on(t.tenantId, t.id, t.role),
  ],
)
