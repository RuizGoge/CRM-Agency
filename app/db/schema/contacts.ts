import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { app, citext } from './_shared'
import { appUser, tenant } from './tenant'

export const tzConfidence = app.enum('tz_confidence', ['high', 'medium', 'low', 'unknown'])
export const tzSource = app.enum('tz_source', ['zip', 'area_code', 'state', 'manual'])
export const contactCreatedVia = app.enum('contact_created_via', [
  'lead_intake',
  'manual',
  'inbound_call',
  'import',
  'merge_survivor',
])
export const phoneKind = app.enum('phone_kind', ['mobile', 'landline', 'voip', 'unknown'])

/**
 * The person.
 *
 * Identity here is OWNER-scoped, and that is a decision rather than an
 * oversight: ping-post resells the same consumer to two sellers in the same
 * agency, so both get their own contact row and neither can see the other's.
 * Suppression, by contrast, is TENANT-wide — a STOP silences that number for
 * everyone. Two scopes on the same human being, which is exactly why
 * `contact_phone` is a separate table.
 */
export const contact = app.table(
  'contact',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    ownerUserId: uuid('owner_user_id').notNull(),

    fullName: text('full_name').notNull(),

    /** citext, so lowercasing is a property of the type and not a call site. */
    emailNorm: citext('email_norm'),

    stateCode: char('state_code', { length: 2 }),
    zip5: char('zip5', { length: 5 }),

    /**
     * The LEAD-LOCAL timezone: it decides the legal calling window and nothing
     * else. Distinct from the tenant's business timezone (which stamps
     * period_key) and from the seller's display timezone (which formats what a
     * human reads). Three rules, three columns, deliberately never merged.
     */
    leadLocalTz: text('lead_local_tz'),
    tzConfidence: tzConfidence('tz_confidence').notNull().default('unknown'),
    tzSource: tzSource('tz_source'),

    createdVia: contactCreatedVia('created_via').notNull(),

    becameClientAt: timestamp('became_client_at', { withTimezone: true }),
    lastTouchAt: timestamp('last_touch_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    /** CCPA erasure: name, email and zip blanked in place. Phones survive. */
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    redactionReason: text('redaction_reason'),

    /** Archived. Excluded by the contact_live view, which is all crm_app reads. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),

    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'contact_owner_fk',
    }),

    // Owner-scoped identity. Note what it does NOT exclude: redacted rows keep
    // their identity slot, so a re-post of someone who asked to be erased
    // matches the skeleton and is refused, rather than creating a shadow
    // record for exactly the person who wanted none.
    uniqueIndex('contact_email_owner_uidx')
      .on(t.tenantId, t.ownerUserId, t.emailNorm)
      .where(sql`${t.emailNorm} IS NOT NULL AND ${t.deletedAt} IS NULL`),

    /**
     * GLOBAL SEARCH, with the ownership predicate INSIDE the index — created
     * by migration 0011 and declared here only now.
     *
     * Sprint-0 gate G1e proved `btree_gin` ships a GIN opclass for uuid, and
     * proved it with a planner check rather than a catalog lookup: all three
     * conditions land in `Index Cond`, not in a post-retrieval filter.
     *
     * That distinction is a SILO property before it is a performance one.
     * 0011 puts it plainly: a tenant-wide trigram index filtered AFTER
     * retrieval is the leak that rules out a separate search service — the
     * rows are fetched first and discarded second, and every layer above has
     * to be trusted to do the discarding. Here the seller's own rows are the
     * only ones the scan ever produces.
     *
     * Measured: a search query written so it could NOT use this index ran at
     * a p95 of 1,053 ms across fifty books. Written so it can, 59.7 ms.
     */
    index('contact_name_trgm_idx').using(
      'gin',
      sql`${t.tenantId}, ${t.ownerUserId}, ${t.fullName} gin_trgm_ops`,
    ),

    index('contact_email_idx')
      .on(t.tenantId, t.ownerUserId, t.emailNorm)
      .where(sql`${t.emailNorm} IS NOT NULL AND ${t.deletedAt} IS NULL`),

    // A timezone we do not know must not masquerade as one we do. Without
    // this, `tz_confidence = 'high'` with a NULL zone reads as a confident
    // answer to the question that decides whether a dial is legal.
    check(
      'contact_tz_confidence_coherent',
      sql`(${t.tzConfidence} = 'unknown') = (${t.leadLocalTz} IS NULL)`,
    ),
  ],
)

/**
 * Numbers are first-class, because every contactability fact — bad number,
 * suppression, dedupe, webhook attribution — is per NUMBER, not per person.
 * Without this split the same physical number in two records carries two
 * truths, and one of them is wrong at the moment it matters.
 */
export const contactPhone = app.table(
  'contact_phone',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    contactId: uuid('contact_id').notNull(),

    /** Denormalised so the owner predicate lives in this table's own indexes. */
    ownerUserId: uuid('owner_user_id').notNull(),

    phoneE164: text('phone_e164').notNull(),

    kind: phoneKind('kind').notNull().default('mobile'),
    isPrimary: boolean('is_primary').notNull().default(false),

    badNumberAt: timestamp('bad_number_at', { withTimezone: true }),
    badNumberReason: text('bad_number_reason'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    /**
     * Redaction deliberately does NOT blank `phone_e164`. Documented
     * minimisation exception: the number is the key by which we are legally
     * obliged to refuse future contact, so hashing it would destroy the
     * ability to honour a STOP. Same argument as suppression_list.
     */
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),

    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contact.tenantId, contact.id],
      name: 'contact_phone_contact_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'contact_phone_owner_fk',
    }),

    // E.164 becomes unfalsifiable at the storage layer rather than a helper
    // someone forgets at one of the six ingress points.
    check('contact_phone_is_e164', sql`${t.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`),

    // THE dedupe rule, expressed as a constraint. Identity is owner-wide, so
    // the uniqueness is owner-wide: two sellers who both bought the same
    // consumer get two rows and neither can see the other. That is the
    // requirement, not a tolerated duplicate.
    uniqueIndex('contact_phone_owner_uidx').on(t.tenantId, t.ownerUserId, t.phoneE164),

    /**
     * Deliberately WITHOUT `owner_user_id`. This is the second, TENANT-WIDE
     * scope on the same number: suppression matching, the non-attributive
     * recent-contact signal, and inbound webhook attribution.
     *
     * Reachable only through SECURITY DEFINER functions that return a verdict
     * and a reason code, never a row — which is what keeps a tenant-wide index
     * on personal data from being a tenant-wide read of it.
     */
    index('contact_phone_tenant_idx').on(t.tenantId, t.phoneE164),

    uniqueIndex('contact_phone_primary_uidx')
      .on(t.tenantId, t.contactId)
      .where(sql`${t.isPrimary}`),
  ],
)
