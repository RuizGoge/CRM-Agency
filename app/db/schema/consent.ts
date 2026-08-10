import { sql } from 'drizzle-orm'
import {
  char,
  check,
  foreignKey,
  index,
  inet,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { app } from './_shared'
import { contact } from './contacts'
import { appUser, tenant } from './tenant'

/**
 * Consent is keyed on the VALUE, not on the person.
 *
 * A phone number is the thing a TCPA claim is about, and the same number can
 * exist as two contact rows in one tenant — ping-post resells the same consumer
 * to two sellers and each gets their own row. Keying consent on `contact_id`
 * would let a STOP given to one seller leave the other still dialling, which is
 * the violation this whole subsystem exists to make impossible.
 *
 * `contact_id` is still carried, nullable, as the record the capture happened
 * through. It is provenance, never the key.
 */
export const contactValueKind = app.enum('contact_value_kind', ['phone', 'email'])

/**
 * `whatsapp_reserved` is a slot, not a feature.
 *
 * The event catalog carries the same member for the same reason: the day
 * WhatsApp arrives it must be a new enum value and not a new event family, a
 * new consent table, or a second compliance gate.
 */
export const channel = app.enum('channel', ['sms', 'call', 'email', 'whatsapp_reserved'])

export const consentStatus = app.enum('consent_status', ['granted', 'revoked', 'dnc_suppressed'])

/**
 * What KIND of permission this is, which is a different question from whether
 * permission exists. Express written consent is what defends an automated
 * marketing text; implied consent covers a callback the consumer asked for and
 * does not stretch to a cadence.
 */
export const consentType = app.enum('consent_type', ['express_written', 'implied', 'none'])

export const consentSource = app.enum('consent_source', [
  'stop_keyword',
  'manual',
  'dnc_list',
  'vendor_certificate',
  'booking_capture',
  'import_attestation',
  'recycle_revalidation',
])

/**
 * Append-only, per channel, per contact value, tenant-scoped.
 *
 * A REVOCATION IS A NEW ROW, NEVER AN UPDATE. That is the entire point: the
 * question a TCPA defence has to answer is not "may we contact this person
 * today" but "what was true at 14:07 on a Tuesday nineteen months ago", and a
 * mutable status column cannot answer it at any price.
 *
 * Reachable by `crm_app` through nothing at all. The policy class is
 * `definer_only`, which generates `USING (false) WITH CHECK (false)` — an
 * EXPLICIT deny rather than the absence of a policy, so the catalog gate's
 * "every table has a policy" rule is met honestly instead of by omission. The
 * only writer is `app.consent_append()`; the only readers are the SECURITY
 * DEFINER functions that return a verdict and never a row.
 *
 * WHY A VERDICT AND NEVER A ROW. This table is tenant-wide by necessity — a
 * STOP silences a number for every seller — so a readable consent table would
 * be a cross-silo oracle: ask it about a number, learn whether anyone else in
 * the agency is working that consumer. The silo is not a UI rule, so the
 * closure is at the privilege level.
 *
 * Never purged. Erasure of the underlying contact deliberately does not touch
 * these rows: the minimal skeleton that lets us legally REFUSE future contact
 * is exempt from erasure, for the same reason `contact_phone.phone_e164`
 * survives redaction.
 */
export const consentLedger = app.table(
  'consent_ledger',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),

    id: uuid('id')
      .notNull()
      .default(sql`uuidv7()`),

    contactValueKind: contactValueKind('contact_value_kind').notNull(),

    /** E.164 for a phone, lowercased address for an email. Normalised by the appender, never by a call site. */
    contactValueNorm: text('contact_value_norm').notNull(),

    channel: channel('channel').notNull(),
    status: consentStatus('status').notNull(),
    consentType: consentType('consent_type').notNull(),
    source: consentSource('source').notNull(),

    /** Who sold the lead, for a vendor certificate. Descriptive; no behaviour keys off it. */
    vendorName: text('vendor_name'),

    /**
     * The TrustedForm / Jornaya certificate URL. Stored as a reference on
     * purpose: retention through the vendor's API is a paid per-certificate
     * dependency and sits outside the MVP, so what we keep is the pointer and
     * the moment we captured it.
     */
    certificateUrl: text('certificate_url'),
    certificateCapturedAt: timestamp('certificate_captured_at', { withTimezone: true }),

    /**
     * The state whose rule was applied. Two-party recording states and stricter
     * state calling windows both key off this, and reconstructing it later from
     * an area code would be a guess presented as evidence.
     */
    jurisdictionState: char('jurisdiction_state', { length: 2 }),

    captured_ip: inet('captured_ip'),

    /**
     * Required when `source = 'import_attestation'`, by CHECK below. A CSV
     * import cannot assert that consent exists without naming the human who
     * says so — that name is the entire evidentiary value of the row.
     */
    attestingAdminUserId: uuid('attesting_admin_user_id'),

    /** Provenance, not the key. See the note on `contact_value_kind` above. */
    contactId: uuid('contact_id'),

    /** What this row superseded, so a transition reads without a self-join. */
    previousStatus: consentStatus('previous_status'),

    evidenceRef: text('evidence_ref'),

    /**
     * TWO TIMES, AND THEY ARE NOT THE SAME QUESTION. `effective_at` is when the
     * consumer's permission changed in the world; `recorded_at` is when we
     * learned it. A STOP webhook that arrives forty seconds late revokes from
     * the moment they sent it, not from the moment we processed it — and the
     * gap between the two columns is exactly the window a plaintiff asks about.
     */
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    /** Null for a system or provider-driven append, such as an inbound STOP. */
    actorUserId: uuid('actor_user_id'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),

    foreignKey({
      columns: [t.tenantId, t.contactId],
      foreignColumns: [contact.tenantId, contact.id],
      name: 'consent_contact_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.actorUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'consent_actor_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.attestingAdminUserId],
      foreignColumns: [appUser.tenantId, appUser.id],
      name: 'consent_attesting_admin_fk',
    }),

    // E.164 is unfalsifiable at the storage layer, exactly as on contact_phone.
    // An email value is left alone here: its normalisation is lowercasing, and
    // a regex that tried to validate an address would reject deliverable ones.
    check(
      'consent_phone_is_e164',
      sql`${t.contactValueKind} <> 'phone' OR ${t.contactValueNorm} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),

    // An import cannot assert consent without naming the admin who attested it.
    check(
      'consent_import_names_attestor',
      sql`${t.source} <> 'import_attestation' OR ${t.attestingAdminUserId} IS NOT NULL`,
    ),

    // THE READ PATH THE GATE ACTUALLY TAKES: latest row for a value on a
    // channel. Descending on effective_at makes the compliance check a single
    // index hit rather than a scan of a consumer's whole consent history, and
    // that check runs before every dial and every message.
    index('consent_value_channel_idx').on(
      t.tenantId,
      t.contactValueNorm,
      t.channel,
      sql`${t.effectiveAt} DESC`,
    ),
  ],
)
