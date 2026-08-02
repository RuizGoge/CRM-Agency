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
 * Case-insensitive text. Used for `app_user.email` so that lowercasing is a
 * property of the type rather than a call site anyone can forget.
 */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext'
  },
})
