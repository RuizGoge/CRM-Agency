import { customType, pgSchema } from 'drizzle-orm/pg-core'

/**
 * The two managed schemas Drizzle owns.
 *
 * `security` is deliberately absent: it holds `table_registry` and `harden()`,
 * it is on the versioned RLS exception list, and `crm_app` has no grants on it
 * at all. It is bootstrap SQL, not application schema — see migration 0000.
 */
export const app = pgSchema('app')
export const ref = pgSchema('ref')

/**
 * Exactly three roles, forever. A fourth requires `ALTER TYPE`, which is a
 * migration and a deploy gate. A CI test asserts this enum has exactly three
 * labels — that assertion is the mechanical form of "no role builder, no
 * permission matrix". There is deliberately no `role` table and no
 * `user_permission` table: their absence IS the guarantee.
 */
export const userRole = app.enum('user_role', ['seller', 'supervisor', 'admin'])

/** Whether a departed seller stays on the all-time board. */
export const earningsDisposition = app.enum('earnings_disposition', [
  'keep_in_history',
  'exclude_from_board',
])

/**
 * The five arms a CI ratchet can have — §11.3's vocabulary, and the direction
 * is a property of the NAME rather than of a row.
 *
 * `frozen_set` is deliberately absent, and its absence is the ruling: it
 * permitted supersets, so every list it guarded could be loosened by adding
 * one row. §10.0.1 offered it and §11.3 struck it.
 */
export const ratchetDirection = app.enum('ratchet_direction', [
  'monotonic_down',
  'monotonic_up',
  'pinned',
  'shrink_only',
  'sealed_set',
])

/**
 * Case-insensitive text. Used for `app_user.email` so that lowercasing is a
 * property of the type rather than a call site anyone can forget.
 */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext'
  },
})

/**
 * Raw bytes. Used by `ref.capability_probe` to store a provider response body
 * exactly as it arrived — errata E9's requirement, because a body that has been
 * decoded, re-encoded or normalised no longer hashes to the digest that
 * certifies it.
 */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea'
  },
})
