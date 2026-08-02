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

    coldThresholdDays: smallint('cold_threshold_days').notNull().default(14),
    rottingThresholdDays: smallint('rotting_threshold_days').notNull().default(7),

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
    check('tenant_rotting_before_cold', sql`${t.rottingThresholdDays} < ${t.coldThresholdDays}`),
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
