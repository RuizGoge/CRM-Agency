import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { app } from './_shared'
import { gateVerdict } from './compliance'
import { contact } from './contacts'
import { appUser } from './tenant'

/** The nine things a seller's history is made of. */
export const timelineKind = app.enum('timeline_kind', [
  'call',
  'message',
  'note',
  'meeting',
  'stage_move',
  'consent',
  'send_blocked',
  'lead_created',
  'repost',
])

/**
 * The unified per-lead timeline. MVP item 20.
 *
 * A DERIVED PROJECTION, never written directly — and that is a fact about
 * privileges rather than a rule in a document: `crm_app` holds nothing on this
 * table at all (`definer_only`), so the only way a row appears is
 * `app.timeline_upsert()`, called by the projector in
 * `app/modules/events/relay.ts`.
 *
 * **"The timeline is for the seller, the audit log is for the lawyer."** One
 * entry per verdict per contact per 60-second window here; one row per ATTEMPT
 * in `audit_log`. Both are built from the same events and neither is a view of
 * the other.
 *
 * NOT PARTITIONED and with no soft delete, both read off 05b: it is fully
 * rebuildable from `event_log` by the replay job, and "a corrupt projection is
 * repaired by rebuilding, never by patching".
 */
export const timelineEntry = app.table(
  'timeline_entry',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    contactId: uuid('contact_id').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),

    /**
     * When the thing HAPPENED, never when the projector ran. A replay stamping
     * `clock_timestamp()` would reorder a seller's entire history into the
     * order we happened to rebuild it in — which is the one thing a history
     * must not do.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

    kind: timelineKind('kind').notNull(),

    /**
     * The natural key of the underlying thing. Two events sharing a ref land in
     * ONE entry, which is what lets a late recording webhook merge into the
     * call it describes instead of adding a second line.
     */
    refType: text('ref_type').notNull(),
    refId: uuid('ref_id').notNull(),

    renderPayload: jsonb('render_payload').notNull(),

    /** Only `send_blocked` uses these two. Everything else dedupes on the ref. */
    dedupeBucket: timestamp('dedupe_bucket', { withTimezone: true }),
    verdict: gateVerdict('verdict'),

    /**
     * 🔴 A REAL COLUMN THAT `crm_app` MUST NEVER READ. §10.8 adds it so the
     * timeline can say WHO without leaking who: the seller sees "you",
     * "system" or "previous owner", never a colleague's name.
     *
     * It is why the policy class is `definer_only` rather than the
     * `owner_scoped` 05b first specified — `harden()` grants SELECT at TABLE
     * level, which confers privilege on every column, and it can restrict
     * columns only on UPDATE. The one class that grants no SELECT is the only
     * one that keeps this promise.
     */
    actorUserId: uuid('actor_user_id'),

    /**
     * Provenance, NOT NULL: every row names the event it was built from.
     *
     * No foreign key, and that is deliberate. `event_log` is partitioned by
     * month with a three-column primary key, and PostgreSQL refuses to detach a
     * referenced partition while referencing rows exist — the FK would turn the
     * thirteen-month archive into an error. `earnings_ledger.source_event_id`
     * is the precedent: provenance declared, not referential.
     */
    builtFromEventId: uuid('built_from_event_id').notNull(),
    builtAt: timestamp('built_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),

    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contact.tenantId, contact.id],
      name: 'timeline_entry_contact_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'timeline_entry_owner_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.actorUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'timeline_entry_actor_fk',
    }),

    /** The read: keyset over (occurred_at, id), never OFFSET. */
    index('timeline_contact_idx').on(t.tenantId, t.contactId, t.occurredAt, t.id),

    /** The upsert key — what makes a replay produce zero new rows. */
    uniqueIndex('timeline_ref_uidx').on(t.tenantId, t.refType, t.refId),

    /** The 60-second window, and only for the one kind that has one. */
    uniqueIndex('timeline_blocked_uidx')
      .on(t.tenantId, t.contactId, t.verdict, t.dedupeBucket)
      .where(sql`${t.kind} = 'send_blocked'`),

    /**
     * NULLS ARE DISTINCT IN A UNIQUE INDEX. A `send_blocked` row with a NULL
     * verdict conflicts with nothing, so the window silently stops
     * deduplicating and the timeline fills with one entry per attempt — looking
     * correct right up until somebody counts.
     */
    check(
      'timeline_blocked_needs_verdict',
      sql`${t.kind} <> 'send_blocked' OR (${t.verdict} IS NOT NULL AND ${t.dedupeBucket} IS NOT NULL)`,
    ),

    /** Identity must not hide in the JSON either. §10.8 lists the keys. */
    check(
      'timeline_no_actor_in_payload',
      sql`NOT (${t.renderPayload} ?| ARRAY['actor_name','actor_display_name','actor_initials','actor_avatar_url','actor_user_id'])`,
    ),
  ],
)
