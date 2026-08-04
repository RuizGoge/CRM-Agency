import { sql } from 'drizzle-orm'

import { withTenant, type SessionIdentity } from '~/db'
import { requireIdentity } from '~/lib/auth/identity'
import { toE164 } from '~/lib/phone/e164'

/**
 * Quick-add — the other end of the loop §7 opens.
 *
 * A seller searches a number that is not in the book, and the empty state
 * offers it back. Without this, that sentence is a dead end: the one moment
 * the product knows exactly what the seller wants to create, and it makes them
 * go and type it again somewhere else.
 *
 * 🔴 THE DUPLICATE IS NEVER WRITTEN, and that is a CONSTRAINT rather than a
 * check. `contact_phone_owner_uidx` is UNIQUE on
 * `(tenant_id, owner_user_id, phone_e164)` and has been since migration 0010,
 * so a second contact with the same number in the same book is refused by the
 * database — not by a lookup this function does first and hopes nothing races.
 *
 * The difference matters at exactly the moment it is hard to reproduce: a
 * seller double-tapping `Save`, or two tabs open. A read-then-write would let
 * both pass the check and both insert. Here the second one loses, and losing
 * is how the seller learns the lead is already theirs.
 *
 * So this function's job is not to prevent the duplicate. It is to turn the
 * refusal into `You already have {name} with this number.` plus a way to open
 * the record — which is the only part a constraint cannot do.
 */

export type QuickAddResult =
  | { readonly status: 'created'; readonly contactId: string }
  /** The constraint refused. `name` is what the seller is told they already have. */
  | { readonly status: 'duplicate'; readonly contactId: string; readonly name: string }
  | { readonly status: 'invalid'; readonly reason: 'name' | 'phone' }

/** Postgres's unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'

export async function quickAddFor(
  identity: SessionIdentity,
  input: { name: string; phone: string },
): Promise<QuickAddResult> {
  const name = input.name.trim()
  const phone = toE164(input.phone)

  // Validated here and not only in the browser: this is a resource route, and
  // a resource route that trusts its client has no validation at all.
  if (name.length < 2) return { status: 'invalid', reason: 'name' }
  if (phone === null) return { status: 'invalid', reason: 'phone' }

  // TWO UNITS OF WORK, and the second one cannot be folded into the first.
  //
  // 🔴 Found by the tests: a constraint violation ABORTS the transaction, so
  // every statement after it answers `current transaction is aborted, commands
  // ignored until end of transaction block`. The recovery lookup — the one
  // that turns the refusal into a name — has to run in a NEW transaction,
  // after this one has rolled back.
  //
  // That is a general shape rather than a quirk of this endpoint: catching a
  // database refusal and then asking the database about it is two units of
  // work in Postgres, always. Writing it as one reads perfectly and fails
  // every time the refusal actually fires — which is to say, only on the path
  // the whole feature exists to handle.
  try {
    const created = await withTenant(identity, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        WITH new_contact AS (
          INSERT INTO app.contact (tenant_id, owner_user_id, full_name, created_via)
          VALUES (app.current_tenant(), app.current_user_id(), ${name}, 'manual')
          RETURNING id
        )
        INSERT INTO app.contact_phone
          (tenant_id, contact_id, owner_user_id, phone_e164, is_primary)
        SELECT app.current_tenant(), c.id, app.current_user_id(), ${phone}, true
          FROM new_contact c
        RETURNING contact_id AS id`)

      const row = rows[0]
      if (row === undefined) throw new Error('quick-add inserted nothing')
      return row.id
    })

    return { status: 'created', contactId: created }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }

  // ONE statement above, so the contact and its phone commit or neither does.
  // Without that, a duplicate number would leave a nameless contact behind on
  // every retry — a book that grows by one invisible row each time a seller is
  // told they already have somebody.
  return withTenant(identity, async (tx) => {
    const existing = await tx.execute<{ id: string; full_name: string }>(sql`
      SELECT c.id, c.full_name
        FROM app.contact_phone p
        JOIN app.contact c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
       WHERE p.tenant_id = app.current_tenant()
         AND p.owner_user_id = app.current_user_id()
         AND p.phone_e164 = ${phone}
       LIMIT 1`)

    const row = existing[0]
    // The constraint fired and the row is not readable, which for a seller
    // means it is in somebody else's book. Reported as a duplicate WITHOUT a
    // name: naming it would be a cross-silo disclosure wearing a helpful
    // message, and the seller only needs to know the number is spoken for.
    if (row === undefined) return { status: 'duplicate', contactId: '', name: '' }

    return { status: 'duplicate', contactId: row.id, name: row.full_name }
  })
}

/**
 * Walks the CAUSE CHAIN, and that is not defensiveness.
 *
 * 🔴 The first version checked `error.code` on what was thrown and never
 * matched: Drizzle wraps the driver's error, so the SQLSTATE the constraint
 * raised sits one level down in `cause`. The constraint fired perfectly and
 * the application could not tell — which turns a designed refusal into a 500,
 * and turns `You already have Curtis Vance with this number.` into `Something
 * went wrong.`
 *
 * The lesson generalises past this function: a guarantee enforced in the
 * database is only half a mechanism until the application can RECOGNISE the
 * refusal. An ORM that rewraps errors is exactly where the other half goes
 * missing, silently, because the happy path is unaffected.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current !== null && depth < 5; depth++) {
    if (typeof current !== 'object') break
    if ('code' in current && (current as { code?: unknown }).code === UNIQUE_VIOLATION) return true
    current = (current as { cause?: unknown }).cause ?? null
  }
  return false
}

/**
 * A form field is a STRING or it is nothing.
 *
 * `FormData.get` returns `string | File`, and `String(aFile)` is
 * `"[object File]"` — which would land in a contact's name, in the database,
 * looking like a bug in the browser rather than an unvalidated input. Caught
 * by the linter, and worth the function rather than a cast: the cast would
 * have silenced the warning and kept the behaviour.
 */
function field(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : ''
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const identity = await requireIdentity(request)
  const form = await request.formData()

  const result = await quickAddFor(identity, {
    name: field(form.get('name')),
    phone: field(form.get('phone')),
  })

  return new Response(JSON.stringify(result), {
    // 200 for every arm, including `duplicate`. It is not an error: the seller
    // asked for a lead they already have, and the answer is where to find it.
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  })
}
