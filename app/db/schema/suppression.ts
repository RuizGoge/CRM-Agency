import { sql } from 'drizzle-orm'
import { check, foreignKey, index, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { channel } from './consent'
import { app } from './_shared'
import { appUser, tenant } from './tenant'

/**
 * Why seven kinds and not a boolean.
 *
 * They are not severities, they are PROVENANCES, and they answer different
 * questions when someone asks why a number was never dialled. `stop` is the
 * consumer's own word and is the strongest thing in the table. `dnc_federal`
 * and `dnc_state` come from a list we did not author and expire on their own
 * schedules. `litigator` is a commercial feed of people who sue for a living —
 * a business decision, not a legal obligation. `carrier_block` is the network
 * telling us the message never arrived, which is not consent at all.
 *
 * Collapsing them to `suppressed boolean` would make all five indistinguishable
 * the day someone has to explain one of them to a regulator.
 */
export const suppressionKind = app.enum('suppression_kind', [
  'stop',
  'start',
  'dnc_federal',
  'dnc_state',
  'internal',
  'litigator',
  'carrier_block',
])

/**
 * Tenant-scoped, keyed on E.164, append-only. DELIBERATELY NOT OWNER-SCOPED.
 *
 * That is the whole design and it is the opposite of every other table here.
 * Ping-post resells the same consumer to two sellers inside one agency, so a
 * STOP given to Ana has to silence Ben's dialler too — immediately, without Ben
 * ever learning that Ana has that lead. Owner-scoping this table would produce
 * a product that honours a STOP for the seller who received it and keeps
 * dialling from the desk next door, which is a TCPA violation with a paper
 * trail proving it was designed in.
 *
 * A START does not delete the STOP. It appends a re-opt-in row and the earlier
 * row stays, because "was this number suppressed on the 14th" has to keep
 * answering yes forever. Same reason as `consent_ledger`: the evidentiary value
 * is the sequence, not the current state.
 *
 * `definer_only`, so `crm_app` holds no SELECT and no DML. A readable
 * tenant-wide suppression list is the same cross-silo oracle the consent ledger
 * would have been — ask whether a number is suppressed, learn that somebody in
 * the agency has been talking to that consumer.
 */
export const suppressionList = app.table(
  'suppression_list',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    phoneE164: text('phone_e164').notNull(),

    kind: suppressionKind('kind').notNull(),

    /**
     * Nullable, and the null means SOMETHING: a suppression with no channel
     * silences every channel. A federal DNC listing is not "do not text me", it
     * is "do not contact me", and forcing a channel here would have quietly
     * narrowed it to one.
     */
    channel: channel('channel'),

    /** The inbound message that carried the STOP, when there was one. */
    sourceMessageId: uuid('source_message_id'),

    evidenceRef: text('evidence_ref'),

    /**
     * Two times, and they are not the same question — the same split as the
     * consent ledger. A STOP webhook that arrives forty seconds late suppresses
     * from the moment the consumer sent it, and the gap between these two
     * columns is the window a plaintiff asks about.
     */
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    /** Null for a provider-driven or list-driven append, which is most of them. */
    actorUserId: uuid('actor_user_id'),

    reason: text('reason'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),

    foreignKey({
      columns: [t.tenantId, t.actorUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'suppression_actor_fk',
    }),

    // Unfalsifiable at the storage layer, exactly as on contact_phone and
    // consent_ledger. A suppression row that does not match the number format
    // the dialler uses is a suppression that silently never applies.
    check('suppression_phone_is_e164', sql`${t.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`),

    // THE READ THE GATE MAKES BEFORE EVERY DIAL AND EVERY MESSAGE: latest rows
    // for a number. Descending on effective_at so the check is an index hit and
    // not a scan of a consumer's whole suppression history.
    index('suppression_phone_idx').on(t.tenantId, t.phoneE164, sql`${t.effectiveAt} DESC`),
  ],
)
