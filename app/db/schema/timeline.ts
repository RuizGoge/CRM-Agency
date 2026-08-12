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

import { app, ref } from './_shared'
import { gateVerdict } from './compliance'
import { eventConsumer, eventName } from './events'
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

    /**
     * 🔴 WHEN THE EVENT BEHIND THIS ROW HAPPENED — the field that makes the
     * merge a function of the SET of events rather than of their delivery
     * order.
     *
     * Distinct from `occurredAt`, which is `least()` over every event that
     * merged here and is what the seller's history is ordered by. This one is
     * the instant of the event named by `builtFromEventId`, and the pair
     * (this, that) is the total order the upsert compares on — which is what
     * makes re-projecting an older event a no-op instead of a rewrite.
     */
    builtFromOccurredAt: timestamp('built_from_occurred_at', { withTimezone: true }).notNull(),
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

/**
 * WHICH EVENTS BECOME A LINE IN A SELLER'S HISTORY, and of what kind.
 *
 * 🔴 THE MAP MOVED OUT OF TYPESCRIPT IN 0064, and not for tidiness: the
 * projector is now a SECURITY DEFINER (`app.timeline_project`) that reads every
 * field off the event row, so it has to know the map, and a second copy in
 * `relay.ts` would be exactly the drift `app.gate_verdict_of` was created to
 * avoid one migration earlier.
 *
 * 🔴 THE FOREIGN KEY IS THE POINT, NOT THE TABLE. `app.event_consumer` holds one
 * row per (consumer, event) subscription and `event_emit` fans out only to rows
 * that exist there — so a projection rule for an event `contacts` never receives
 * is dead configuration, and with this key it is UNWRITABLE rather than merely
 * wrong.
 *
 * ⚠️ IT CAUGHT ONE ON THE WAY IN. `consent.updated` was in the TypeScript map
 * and `contacts` has never subscribed to it, so the `consent` timeline kind has
 * been unreachable since 0059 and nothing said so. Its row is deliberately
 * ABSENT rather than the subscription being added: adding a consumer is a change
 * to the event catalog, and that belongs to whoever owns that decision.
 *
 * No tenant column, because every tenant projects identically. `reference`
 * generates `USING (true) WITH CHECK (false)` — `crm_app` reads it and only the
 * migrator writes it.
 */
export const timelineProjection = ref.table(
  'timeline_projection',
  {
    consumerName: text('consumer_name').notNull().default('contacts'),
    eventName: eventName('event_name').primaryKey(),
    kind: timelineKind('kind').notNull(),
    /** `correlation` merges a move with its sale; `event` gives a refusal its own row. */
    refMode: text('ref_mode').notNull(),
  },
  (t) => [
    check('timeline_projection_is_contacts', sql`${t.consumerName} = 'contacts'`),
    check('timeline_projection_ref_mode', sql`${t.refMode} IN ('correlation', 'subject', 'event')`),
    foreignKey({
      columns: [t.consumerName, t.eventName],
      foreignColumns: [eventConsumer.consumerName, eventConsumer.eventName],
      name: 'timeline_projection_subscribed_fk',
    }),
  ],
)
